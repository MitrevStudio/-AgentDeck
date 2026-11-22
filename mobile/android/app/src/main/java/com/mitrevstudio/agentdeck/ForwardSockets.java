package com.mitrevstudio.agentdeck;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The sockets of the Forward plugin (docs/PORT-FORWARDING.md 4.1): TCP listeners on 127.0.0.1 and the connections
 * they take, all on ONE thread with a Selector (non-blocking channels). A browser opens six and more connections per
 * page; with one thread their number costs no threads, and - the reason that matters more - everything the page hears
 * about a connection is said by that one thread, so the order is the order things happened in: "connection", then its
 * "data" in the order of the bytes, "end" after the last of them, "closed" last and once.
 *
 * The plugin's methods run on Capacitor's plugin thread; each one only hands a task to this thread (post) and the
 * task answers the call. So nothing here is shared between threads but the task queue, and a slow client can never
 * hold the plugin thread (a blocking write there would also hold the credit() that the same client waits for).
 *
 * The thread starts with the first listen() and lives until shutdown() (the plugin is destroyed); idle it sleeps in
 * select(). It is a daemon and the sockets are the process's: when the app's process dies nothing is left behind.
 */
final class ForwardSockets {
    /** What the page hears. Always called on the socket thread, one event after another. */
    interface Events {
        void connection(String listener, String conn);
        void data(String conn, byte[] bytes, int length);
        void end(String conn);
        void closed(String conn, String error);
    }

    private static final String TAG = "Forward";
    /** A "data" event carries at most this many bytes. */
    static final int CHUNK = 32 * 1024;
    /** A write() carries at most this many bytes. */
    static final int MAX_WRITE = 64 * 1024;
    /** The socket is read only while the bytes given to the page and not yet credited are fewer than this. */
    static final int WINDOW = 256 * 1024;

    // Unique for the app's run, not for the plugin's instance: an activity made again must not reuse an id that the
    // page of the one before may still hold.
    private static final AtomicLong ids = new AtomicLong();

    private static final class Listener {
        String id;
        ServerSocketChannel channel;
        final ArrayList<Conn> conns = new ArrayList<>();
    }

    private static final class PendingWrite {
        ByteBuffer bytes;
        PluginCall call;
    }

    private static final class Conn {
        String id;
        Listener listener;
        SocketChannel channel;
        SelectionKey key;
        int uncredited;         // bytes sent to the page in "data" events that it has not credited yet
        boolean readEof;        // the client sent FIN; "end" was said
        boolean endRequested;   // end(): the output is shut down once the queue below is empty
        boolean outputShut;
        boolean closed;         // "closed" was said (or is being said); nothing more happens to this connection
        final ArrayDeque<PendingWrite> writes = new ArrayDeque<>();
    }

    private final Events events;
    private final ConcurrentLinkedQueue<Runnable> tasks = new ConcurrentLinkedQueue<>();
    private final Map<String, Listener> listeners = new HashMap<>();   // socket thread only
    private final Map<String, Conn> conns = new HashMap<>();           // socket thread only
    private final ByteBuffer readBuffer = ByteBuffer.allocate(CHUNK);  // socket thread only
    private Selector selector;       // guarded by this
    private Thread thread;           // guarded by this
    private boolean stopped;         // guarded by this
    private volatile boolean stopping;

    ForwardSockets(Events events) {
        this.events = events;
    }

    // ---- the plugin's calls (any thread) -----------------------------------------------------------------------

    void listen(PluginCall call, int wished) {
        post(call, () -> {
            ServerSocketChannel channel = null;
            try {
                // 127.0.0.1 by its bytes: getLoopbackAddress() and "localhost" may be ::1, and the page that is opened
                // is http://127.0.0.1:port. Never the wildcard address: other devices on the network must not reach it.
                InetAddress loopback = InetAddress.getByAddress(new byte[] { 127, 0, 0, 1 });
                channel = ServerSocketChannel.open();
                channel.configureBlocking(false);
                ServerSocket socket = channel.socket();
                socket.setReuseAddress(true); // the same port again right after an unlisten (connections in TIME_WAIT)
                boolean bound = false;
                if (wished > 0 && wished <= 65535) {
                    try {
                        socket.bind(new InetSocketAddress(loopback, wished), 64);
                        bound = true;
                    } catch (IOException taken) {
                        // In use, or below 1024 (an app may not bind those): any free port instead. A failed bind may
                        // leave the socket unusable, so a new one.
                        channel.close();
                        channel = ServerSocketChannel.open();
                        channel.configureBlocking(false);
                        socket = channel.socket();
                        socket.setReuseAddress(true);
                    }
                }
                if (!bound) socket.bind(new InetSocketAddress(loopback, 0), 64);
                Listener l = new Listener();
                l.id = "l" + ids.incrementAndGet();
                l.channel = channel;
                channel.register(selector, SelectionKey.OP_ACCEPT, l);
                listeners.put(l.id, l);
                JSObject ret = new JSObject();
                ret.put("listener", l.id);
                ret.put("port", socket.getLocalPort());
                call.resolve(ret);
            } catch (Exception e) {
                closeQuietly(channel);
                call.reject("could not listen: " + text(e), "listenFailed");
            }
        });
    }

    void unlisten(PluginCall call, String id) {
        post(call, () -> {
            Listener l = listeners.remove(id);
            if (l == null) { call.reject("unknown listener", "unknownListener"); return; }
            closeQuietly(l.channel); // also takes its key out of the selector
            for (Conn c : new ArrayList<>(l.conns)) close(c, "");
            call.resolve();
        });
    }

    void write(PluginCall call, String id, byte[] bytes) {
        post(call, () -> {
            Conn c = conns.get(id);
            if (c == null) { call.reject("the connection is gone", "unknownConnection"); return; }
            if (c.endRequested || c.outputShut) { call.reject("the connection was ended", "ended"); return; }
            PendingWrite w = new PendingWrite();
            w.bytes = ByteBuffer.wrap(bytes);
            w.call = call;
            c.writes.add(w);
            flush(c); // most writes fit the socket's buffer and are answered right here
        });
    }

    void end(PluginCall call, String id) {
        post(call, () -> {
            Conn c = conns.get(id);
            if (c == null) { call.reject("the connection is gone", "unknownConnection"); return; }
            c.endRequested = true;
            call.resolve();
            flush(c); // shuts the output down now when nothing waits to be written, else after the last write
        });
    }

    void close(PluginCall call, String id) {
        post(call, () -> {
            Conn c = conns.get(id);
            if (c == null) { call.reject("the connection is gone", "unknownConnection"); return; }
            close(c, "");
            call.resolve();
        });
    }

    void credit(PluginCall call, String id, int bytes) {
        post(call, () -> {
            Conn c = conns.get(id);
            if (c == null) { call.reject("the connection is gone", "unknownConnection"); return; }
            c.uncredited = Math.max(0, c.uncredited - bytes);
            interest(c);
            call.resolve();
        });
    }

    /** The plugin is destroyed: every listener and connection is closed, the thread ends. No events: the page is going too. */
    void shutdown() {
        synchronized (this) {
            if (stopped) return;
            stopped = true;
            stopping = true;
            if (selector != null) selector.wakeup();
        }
    }

    private void post(PluginCall call, Runnable task) {
        synchronized (this) {
            if (stopped) { call.reject("the plugin is shut down", "shutDown"); return; }
            if (thread == null) {
                try {
                    selector = Selector.open();
                } catch (IOException e) {
                    call.reject("could not start: " + text(e), "listenFailed");
                    return;
                }
                thread = new Thread(this::loop, "agentdeck-forward");
                thread.setDaemon(true);
                thread.start();
            }
            tasks.add(task);
            selector.wakeup();
        }
    }

    // ---- the socket thread --------------------------------------------------------------------------------------

    private void loop() {
        final Selector sel;
        synchronized (this) { sel = selector; }
        try {
            while (!stopping) {
                sel.select();
                if (stopping) break;
                Runnable task;
                while ((task = tasks.poll()) != null) {
                    try { task.run(); } catch (RuntimeException e) { Log.w(TAG, "task failed", e); }
                }
                Iterator<SelectionKey> it = sel.selectedKeys().iterator();
                while (it.hasNext()) {
                    SelectionKey key = it.next();
                    it.remove();
                    try {
                        if (!key.isValid()) continue;
                        Object owner = key.attachment();
                        if (owner instanceof Listener) {
                            accept((Listener) owner);
                        } else {
                            Conn c = (Conn) owner;
                            if (key.isReadable()) read(c);
                            if (!c.closed && key.isValid() && key.isWritable()) flush(c);
                        }
                    } catch (RuntimeException e) { // a key cancelled under us and the like: that key only
                        Log.w(TAG, "socket event failed", e);
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "the socket thread stopped", e);
        } finally {
            // Whatever ended the loop, nothing stays open and no call stays unanswered.
            synchronized (this) { stopped = true; }
            for (Listener l : listeners.values()) closeQuietly(l.channel);
            listeners.clear();
            for (Conn c : conns.values()) {
                c.closed = true;
                closeQuietly(c.channel);
                for (PendingWrite w : c.writes) w.call.reject("the plugin is shut down", "shutDown");
            }
            conns.clear();
            try { sel.close(); } catch (IOException ignored) { }
            Runnable late;
            while ((late = tasks.poll()) != null) { // their calls find no listener / connection and are rejected
                try { late.run(); } catch (RuntimeException ignored) { }
            }
        }
    }

    private void accept(Listener l) {
        try {
            SocketChannel channel;
            while ((channel = l.channel.accept()) != null) {
                Conn c = new Conn();
                try {
                    channel.configureBlocking(false);
                    channel.socket().setTcpNoDelay(true); // small HTTP answers and websocket frames go out at once
                    c.key = channel.register(selector, SelectionKey.OP_READ, c);
                } catch (IOException e) {
                    closeQuietly(channel);
                    continue;
                }
                c.id = "c" + ids.incrementAndGet();
                c.listener = l;
                c.channel = channel;
                l.conns.add(c);
                conns.put(c.id, c);
                events.connection(l.id, c.id);
            }
        } catch (IOException e) {
            if (!l.channel.isOpen()) return;
            // Out of file descriptors and the like: the listener stays, the pending client is tried again. The pause
            // keeps a condition that does not pass from spinning the thread.
            Log.w(TAG, "accept failed: " + text(e));
            try { Thread.sleep(50); } catch (InterruptedException ignored) { }
        }
    }

    // One read per readiness, never more than the window has room for: the page holds at most WINDOW uncredited bytes.
    private void read(Conn c) {
        if (c.closed || c.readEof || c.uncredited >= WINDOW) return;
        int n;
        try {
            readBuffer.clear();
            readBuffer.limit(Math.min(CHUNK, WINDOW - c.uncredited));
            n = c.channel.read(readBuffer);
        } catch (IOException e) {
            close(c, text(e));
            return;
        }
        if (n > 0) {
            c.uncredited += n;
            events.data(c.id, readBuffer.array(), n);
        } else if (n < 0) {
            c.readEof = true;
            events.end(c.id);
            if (c.outputShut) { close(c, ""); return; } // both directions are done
        }
        interest(c);
    }

    // Writes what is queued, in order, as far as the socket takes it; each write() is answered when its last byte is
    // in the socket. What does not fit waits for OP_WRITE.
    private void flush(Conn c) {
        if (c.closed) return;
        try {
            PendingWrite w;
            while ((w = c.writes.peek()) != null) {
                c.channel.write(w.bytes);
                if (w.bytes.hasRemaining()) break;
                c.writes.poll();
                w.call.resolve();
            }
            if (c.writes.isEmpty() && c.endRequested && !c.outputShut) {
                c.channel.shutdownOutput();
                c.outputShut = true;
                if (c.readEof) { close(c, ""); return; }
            }
        } catch (IOException e) {
            close(c, text(e));
            return;
        }
        interest(c);
    }

    private void interest(Conn c) {
        if (c.closed || !c.key.isValid()) return;
        int ops = 0;
        if (!c.readEof && c.uncredited < WINDOW) ops |= SelectionKey.OP_READ;
        if (!c.writes.isEmpty()) ops |= SelectionKey.OP_WRITE;
        if (c.key.interestOps() != ops) c.key.interestOps(ops);
    }

    // The one place a connection ends: "closed" is said here and nowhere else, so once.
    private void close(Conn c, String error) {
        if (c.closed) return;
        c.closed = true;
        conns.remove(c.id);
        c.listener.conns.remove(c);
        closeQuietly(c.channel);
        for (PendingWrite w : c.writes) w.call.reject("the connection is gone", "unknownConnection");
        c.writes.clear();
        events.closed(c.id, error);
    }

    private static void closeQuietly(java.nio.channels.Channel channel) {
        if (channel == null) return;
        try { channel.close(); } catch (IOException ignored) { }
    }

    private static String text(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}
