package com.mitrevstudio.agentdeck;

import android.net.Uri;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Port forwarding on the phone (docs/PORT-FORWARDING.md 4.1): the page forwards a TCP port of one of the user's
 * computers through the app's encrypted link, and this plugin is the phone's end of it - a TCP listener on 127.0.0.1
 * whose connections' bytes go to and from the page over the bridge (base64), and a web view inside the app that
 * shows http://127.0.0.1:port. Nothing here talks to the network: the listener is loopback only.
 *
 * listen({ port }) -> { listener, port }, unlisten({ listener }), write({ conn, data }), end({ conn }),
 * close({ conn }), credit({ conn, bytes }), show({ url, title }), hide().
 * Events: "connection" { listener, conn }, "data" { conn, data }, "end" { conn }, "closed" { conn, error },
 * "hidden" {}.
 *
 * The sockets are in ForwardSockets (one thread of its own; all socket events come from it, in order), the view in
 * ForwardView (main thread). A call for a listener or a connection that does not exist (any more) is rejected with
 * the code "unknownListener" / "unknownConnection" - also a credit() or close() that crosses the "closed" event.
 *
 * In the background nothing is closed here: the listener and its connections live as long as the process does (the
 * page decides what a pause means). When the activity is destroyed everything is closed.
 */
@CapacitorPlugin(name = "Forward")
public class ForwardPlugin extends Plugin implements ForwardSockets.Events {
    private final ForwardSockets sockets = new ForwardSockets(this);
    private ForwardView view; // main thread only

    // ---- sockets ------------------------------------------------------------------------------------------------

    @PluginMethod
    public void listen(PluginCall call) {
        Integer port = call.getInt("port");
        sockets.listen(call, port == null ? 0 : port);
    }

    @PluginMethod
    public void unlisten(PluginCall call) {
        String listener = call.getString("listener");
        if (listener == null) { call.reject("no listener", "invalidData"); return; }
        sockets.unlisten(call, listener);
    }

    @PluginMethod
    public void write(PluginCall call) {
        String conn = call.getString("conn");
        String data = call.getString("data");
        if (conn == null || data == null) { call.reject("no connection or data", "invalidData"); return; }
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("data is not base64", "invalidData");
            return;
        }
        if (bytes.length > ForwardSockets.MAX_WRITE) { call.reject("more than 64 KB in one write", "invalidData"); return; }
        sockets.write(call, conn, bytes);
    }

    @PluginMethod
    public void end(PluginCall call) {
        String conn = call.getString("conn");
        if (conn == null) { call.reject("no connection", "invalidData"); return; }
        sockets.end(call, conn);
    }

    @PluginMethod
    public void close(PluginCall call) {
        String conn = call.getString("conn");
        if (conn == null) { call.reject("no connection", "invalidData"); return; }
        sockets.close(call, conn);
    }

    @PluginMethod
    public void credit(PluginCall call) {
        String conn = call.getString("conn");
        Integer bytes = call.getInt("bytes");
        if (conn == null || bytes == null || bytes < 0) { call.reject("no connection or bytes", "invalidData"); return; }
        sockets.credit(call, conn, bytes);
    }

    // The four below are called by the socket thread only, one after another: the bridge gets them in that order and
    // hands them to the page in that order.

    @Override
    public void connection(String listener, String conn) {
        JSObject e = new JSObject();
        e.put("listener", listener);
        e.put("conn", conn);
        notifyListeners("connection", e);
    }

    @Override
    public void data(String conn, byte[] bytes, int length) {
        JSObject e = new JSObject();
        e.put("conn", conn);
        e.put("data", Base64.encodeToString(bytes, 0, length, Base64.NO_WRAP));
        notifyListeners("data", e);
    }

    @Override
    public void end(String conn) {
        JSObject e = new JSObject();
        e.put("conn", conn);
        notifyListeners("end", e);
    }

    @Override
    public void closed(String conn, String error) {
        JSObject e = new JSObject();
        e.put("conn", conn);
        e.put("error", error == null ? "" : error);
        notifyListeners("closed", e);
    }

    // ---- the view -----------------------------------------------------------------------------------------------

    @PluginMethod
    public void show(PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "");
        Uri uri = url == null ? null : Uri.parse(url);
        String scheme = uri == null || uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(java.util.Locale.ROOT);
        if (uri == null || uri.getHost() == null || !(scheme.equals("http") || scheme.equals("https"))) {
            call.reject("an http or https address is needed", "invalidData");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            if (getActivity() == null || getActivity().isFinishing() || getActivity().isDestroyed()) { call.reject("the app is closing", "shutDown"); return; }
            if (view == null) view = new ForwardView(getActivity(), getBridge().getHost(), this::hiddenByUser);
            view.open(url, title);
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            if (view != null && view.isOpen()) {
                view.close();
                getBridge().getWebView().requestFocus();
            }
            call.resolve();
        });
    }

    // The close button, the system back button with no page to go back to, or the page's renderer died.
    private void hiddenByUser() {
        getBridge().getWebView().requestFocus(); // the keyboard and the keys belong to the app's page again
        notifyListeners("hidden", new JSObject());
    }

    // ---- the app's life -----------------------------------------------------------------------------------------

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (view != null) view.onPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (view != null) view.onResume();
    }

    // The activity is destroyed (the page with it): no listener, connection, thread or view outlives it.
    @Override
    protected void handleOnDestroy() {
        sockets.shutdown();
        if (view != null) { view.close(); view = null; }
        super.handleOnDestroy();
    }
}
