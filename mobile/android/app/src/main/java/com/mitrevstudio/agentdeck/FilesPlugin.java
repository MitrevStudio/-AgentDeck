package com.mitrevstudio.agentdeck;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.MimeTypeMap;

import androidx.annotation.RequiresApi;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Files downloaded from a computer (docs/FILES.md 5.1): the page receives a file a piece at a time and hands each
 * piece to this plugin, so 50 MB never sit in the page's memory. A file kept for the user goes to Downloads; a
 * temporary one (a PDF to look at) goes to the app's cache and is shown by the system's viewer.
 *
 * begin({ name, size, keep }) -> { file }, write({ file, data }), finish({ file }) -> { shown }, open({ file, type }),
 * cancel({ file }).
 *
 * keep: true -> a pending MediaStore.Downloads entry (IS_PENDING=1, invisible to other apps), its stream open between
 * the writes, published on finish (IS_PENDING=0). A name that is taken gets " (2)", " (3)"... before the extension;
 * what the entry is really called afterwards is read back from it ("shown"). Android 10 (API 29) and newer only: below
 * that Downloads needs WRITE_EXTERNAL_STORAGE, which the app does not ask for - begin() is rejected ("needsAndroid10").
 * keep: false -> a file in the app's cache (cache/agentdeck-files/<file>/<name>), for open(): ACTION_VIEW through the
 * app's FileProvider with a read grant.
 *
 * All file work is on one thread of the plugin's own, in the order the calls came: the writes of a file are written
 * in order, and Capacitor's plugin thread (shared with the other plugins) never waits for the disk. When the activity
 * is destroyed every stream is closed and every unfinished file removed (a pending row too). The cache folder of an
 * earlier run is removed when the plugin loads.
 *
 * Rejection codes: invalidData, unknownFile, needsAndroid10, sizeMismatch, finished, notFinished, noViewer,
 * diskFull, createFailed, writeFailed, finishFailed, openFailed, shutDown.
 */
@CapacitorPlugin(name = "Files")
public class FilesPlugin extends Plugin {
    private static final String TAG = "Files";
    /** A write() carries at most this many bytes. */
    static final int MAX_WRITE = 256 * 1024;
    /** The app's folder in its cache: one folder per temporary file in it. */
    private static final String DIR = "agentdeck-files";
    /** A name longer than this (in chars) is shortened, its extension kept. */
    private static final int MAX_NAME = 80;

    // Unique for the app's run, not for the plugin's instance (as ForwardSockets' ids).
    private static final AtomicLong ids = new AtomicLong();

    private static final class Entry {
        String id;
        boolean keep;
        String name;       // keep: the display name the row was made with; temporary: the file's name
        long size;         // what begin() said; -1 when it said nothing
        long written;
        Uri row;           // keep: the MediaStore row
        File file;         // temporary: the file
        OutputStream out;  // open until finish()
        boolean finished;
    }

    private final ExecutorService io = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "agentdeck-files");
        t.setDaemon(true);
        return t;
    });
    private final Map<String, Entry> entries = new HashMap<>(); // io thread only

    /** A task on the io thread; whatever it throws answers its call. */
    private interface Task {
        void run() throws Exception;
    }

    @Override
    public void load() {
        File old = new File(getContext().getCacheDir(), DIR);
        // A file of an earlier run is nobody's any more ("file" ids are for one run).
        onDisk(() -> deleteTree(old));
    }

    // ---- the calls ----------------------------------------------------------------------------------------------

    @PluginMethod
    public void begin(PluginCall call) {
        String name = cleanName(call.getString("name"));
        Boolean keepArg = call.getBoolean("keep", false);
        boolean keep = keepArg != null && keepArg;
        Object sizeArg = call.getData().opt("size");
        long size = sizeArg instanceof Number && ((Number) sizeArg).longValue() >= 0 ? ((Number) sizeArg).longValue() : -1;
        if (name == null) { call.reject("no file name", "invalidData"); return; }
        if (keep && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("saving to Downloads needs Android 10 or newer", "needsAndroid10");
            return;
        }
        File cache = getContext().getCacheDir();
        ContentResolver resolver = getContext().getContentResolver();
        post(call, () -> {
            Entry e = new Entry();
            e.id = "f" + ids.incrementAndGet();
            e.keep = keep;
            e.name = name;
            e.size = size;
            try {
                if (!keep) {
                    File dir = new File(new File(cache, DIR), e.id);
                    if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("could not make the folder");
                    e.file = new File(dir, name);
                    e.out = new FileOutputStream(e.file);
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    openDownload(e, resolver);
                } else {
                    throw new IOException("saving to Downloads needs Android 10 or newer");
                }
            } catch (Exception ex) {
                discard(e, resolver);
                call.reject("could not create the file: " + text(ex), code(ex, "createFailed"));
                return;
            }
            entries.put(e.id, e);
            JSObject ret = new JSObject();
            ret.put("file", e.id);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        String id = call.getString("file");
        String data = call.getString("data");
        if (id == null || data == null) { call.reject("no file or data", "invalidData"); return; }
        // base64 of MAX_WRITE bytes, with room for line breaks: anything longer cannot be one piece.
        if (data.length() > (MAX_WRITE / 3 + 1) * 4 + 4096) { call.reject("more than 256 KB in one write", "invalidData"); return; }
        post(call, () -> {
            Entry e = entries.get(id);
            if (e == null) { call.reject("unknown file", "unknownFile"); return; }
            if (e.finished || e.out == null) { call.reject("the file is finished", "finished"); return; }
            byte[] bytes;
            try {
                bytes = Base64.decode(data, Base64.DEFAULT);
            } catch (IllegalArgumentException ex) {
                call.reject("data is not base64", "invalidData");
                return;
            }
            if (bytes.length > MAX_WRITE) { call.reject("more than 256 KB in one write", "invalidData"); return; }
            if (e.size >= 0 && e.written + bytes.length > e.size) {
                call.reject("more bytes than the size given (" + e.size + ")", "sizeMismatch");
                return;
            }
            try {
                e.out.write(bytes);
            } catch (IOException ex) {
                call.reject("could not write: " + text(ex), code(ex, "writeFailed"));
                return;
            }
            e.written += bytes.length;
            call.resolve();
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String id = call.getString("file");
        if (id == null) { call.reject("no file", "invalidData"); return; }
        ContentResolver resolver = getContext().getContentResolver();
        post(call, () -> {
            Entry e = entries.get(id);
            if (e == null) { call.reject("unknown file", "unknownFile"); return; }
            if (!e.finished) {
                if (e.out == null) { call.reject("the file failed; cancel it", "finishFailed"); return; }
                if (e.size >= 0 && e.written != e.size) {
                    call.reject(e.written + " bytes of " + e.size + " were written", "sizeMismatch");
                    return;
                }
                OutputStream out = e.out;
                e.out = null;
                try {
                    out.close();
                    if (e.keep && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) e.name = publish(e, resolver);
                } catch (Exception ex) {
                    // Left unfinished: the page cancels it, which removes it.
                    call.reject("could not finish the file: " + text(ex), code(ex, "finishFailed"));
                    return;
                }
                e.finished = true;
            }
            JSObject ret = new JSObject();
            ret.put("shown", e.name);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("file");
        String type = call.getString("type");
        if (id == null) { call.reject("no file", "invalidData"); return; }
        post(call, () -> {
            Entry e = entries.get(id);
            if (e == null) { call.reject("unknown file", "unknownFile"); return; }
            if (e.keep || !e.finished || e.file == null) {
                call.reject("only a finished temporary file can be opened", "notFinished");
                return;
            }
            String mime = type != null && !type.isEmpty() ? type : mimeOf(e.name);
            Uri uri = shared(e.file);
            if (uri == null) { call.reject("the file cannot be shared with a viewer", "openFailed"); return; }
            getBridge().executeOnMainThread(() -> view(call, uri, mime));
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("file");
        if (id == null) { call.reject("no file", "invalidData"); return; }
        ContentResolver resolver = getContext().getContentResolver();
        post(call, () -> {
            Entry e = entries.remove(id);
            // Already gone is what was asked for. A finished download is the user's now: only forgotten here.
            if (e != null && !(e.keep && e.finished)) discard(e, resolver);
            call.resolve();
        });
    }

    // ---- Downloads (API 29+) ------------------------------------------------------------------------------------

    @RequiresApi(Build.VERSION_CODES.Q)
    private void openDownload(Entry e, ContentResolver resolver) throws IOException {
        String wished = e.name;
        for (int n = 1; ; n++) {
            if (n > 999) throw new IOException("no free name in Downloads");
            String candidate = n == 1 ? wished : numbered(wished, n);
            if (!taken(candidate, resolver)) { e.name = candidate; break; }
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, e.name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(e.name));
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        e.row = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (e.row == null) throw new IOException("Downloads did not take a new file");
        e.out = resolver.openOutputStream(e.row, "w");
        if (e.out == null) throw new IOException("Downloads gave no stream");
    }

    // Best effort: without a storage permission the query sees this app's own entries only, and the folder may not
    // say what other apps put there. MediaStore may make a name unique itself, its own way, so the name the entry
    // really got is read back in publish().
    @RequiresApi(Build.VERSION_CODES.Q)
    private boolean taken(String name, ContentResolver resolver) {
        for (Entry o : entries.values()) {
            if (o.keep && !o.finished && name.equalsIgnoreCase(o.name)) return true;
        }
        try {
            @SuppressWarnings("deprecation")
            File folder = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (new File(folder, name).exists()) return true;
        } catch (RuntimeException ignored) { }
        try (Cursor c = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[] { MediaStore.MediaColumns._ID },
                MediaStore.MediaColumns.DISPLAY_NAME + "=?", new String[] { name }, null)) {
            return c != null && c.getCount() > 0;
        } catch (RuntimeException ex) {
            return false;
        }
    }

    // The entry becomes a file in Downloads that every app sees. Returns the name it has there.
    @RequiresApi(Build.VERSION_CODES.Q)
    private String publish(Entry e, ContentResolver resolver) throws IOException {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        if (resolver.update(e.row, v, null, null) < 1) throw new IOException("Downloads did not publish the file");
        try (Cursor c = resolver.query(e.row, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String shown = c.getString(0);
                if (shown != null && !shown.isEmpty()) return shown;
            }
        } catch (RuntimeException ignored) { }
        return e.name;
    }

    // ---- the viewer ---------------------------------------------------------------------------------------------

    private Uri shared(File file) {
        try {
            // ${applicationId}.fileprovider in the manifest: the package name, with the preview build's suffix too.
            return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        } catch (IllegalArgumentException ex) {
            Log.w(TAG, "no FileProvider path for the file", ex);
            return null;
        }
    }

    // Main thread. No resolveActivity() first: since Android 11 it would need a <queries> entry for every type and
    // say "nothing" without one; starting it tells.
    private void view(PluginCall call, Uri uri, String mime) {
        Activity a = getActivity();
        if (a == null || a.isFinishing() || a.isDestroyed()) { call.reject("the app is closing", "shutDown"); return; }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, mime);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            a.startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException ex) {
            call.reject("no app on this phone opens " + mime, "noViewer");
        } catch (RuntimeException ex) {
            call.reject("could not open: " + text(ex), "openFailed");
        }
    }

    // ---- the app's life -----------------------------------------------------------------------------------------

    // The activity is destroyed (the page with it): nothing stays open, nothing unfinished stays. A finished
    // temporary file stays until the next load (a viewer may still be reading it).
    @Override
    protected void handleOnDestroy() {
        ContentResolver resolver = getContext().getContentResolver();
        onDisk(() -> {
            for (Entry e : entries.values()) {
                if (!e.finished) discard(e, resolver);
            }
            entries.clear();
        });
        io.shutdown();
        super.handleOnDestroy();
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private void post(PluginCall call, Task task) {
        try {
            io.execute(() -> {
                try {
                    task.run();
                } catch (Exception ex) {
                    Log.w(TAG, "task failed", ex);
                    call.reject("failed: " + text(ex), code(ex, "failed"));
                }
            });
        } catch (RejectedExecutionException ex) {
            call.reject("the plugin is shut down", "shutDown");
        }
    }

    private void onDisk(Runnable task) {
        try {
            io.execute(() -> {
                try { task.run(); } catch (RuntimeException ex) { Log.w(TAG, "cleanup failed", ex); }
            });
        } catch (RejectedExecutionException ignored) { }
    }

    // Closes what is open and removes the file: the pending row, or the temporary file and its folder.
    private static void discard(Entry e, ContentResolver resolver) {
        if (e.out != null) {
            try { e.out.close(); } catch (IOException ignored) { }
            e.out = null;
        }
        if (e.row != null) {
            try { resolver.delete(e.row, null, null); } catch (RuntimeException ex) { Log.w(TAG, "could not remove a download", ex); }
            e.row = null;
        }
        if (e.file != null) {
            deleteTree(e.file.getParentFile());
            e.file = null;
        }
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        if (!f.delete()) Log.w(TAG, "could not remove " + f.getName());
    }

    /**
     * The name comes from another computer: no folder separators, no control characters, none of the characters
     * Downloads refuses, never "." or "..", not too long (its extension kept). null when there is no name at all.
     */
    static String cleanName(String raw) {
        if (raw == null) return null;
        StringBuilder b = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            b.append(ch < 0x20 || ch == 0x7f || "/\\:*?\"<>|".indexOf(ch) >= 0 ? '_' : ch);
        }
        String s = b.toString().trim();
        if (s.isEmpty()) return null;
        if (s.replace(".", "").isEmpty()) return "download";
        if (s.length() > MAX_NAME) {
            int dot = s.lastIndexOf('.');
            String ext = dot > 0 && s.length() - dot <= 17 ? s.substring(dot) : "";
            int cut = MAX_NAME - ext.length();
            if (Character.isHighSurrogate(s.charAt(cut - 1))) cut--;
            s = s.substring(0, cut).trim() + ext;
        }
        return s;
    }

    /** "report.pdf", 2 -> "report (2).pdf"; "notes", 3 -> "notes (3)". */
    static String numbered(String name, int n) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0) return name + " (" + n + ")";
        return name.substring(0, dot) + " (" + n + ")" + name.substring(dot);
    }

    private static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) {
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (mime != null) return mime;
        }
        return "application/octet-stream";
    }

    private static String code(Exception e, String fallback) {
        String m = e.getMessage();
        if (m != null && (m.contains("ENOSPC") || m.contains("No space left"))) return "diskFull";
        return fallback;
    }

    private static String text(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}
