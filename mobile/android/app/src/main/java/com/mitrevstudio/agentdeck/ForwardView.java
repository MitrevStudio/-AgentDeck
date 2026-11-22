package com.mitrevstudio.agentdeck;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Locale;

/**
 * The page of a forwarded port, inside the app (docs/PORT-FORWARDING.md 4): a WebView of its own over the app's
 * content, in the same Activity - the app stays in front, which is what keeps the forward alive - under a bar with
 * back, reload, the address (read-only) and close.
 *
 * This view shows whatever a dev server on the user's computer serves, so it has NO way into the app: no
 * JavaScript interface, no Capacitor bridge (that one is injected into Capacitor's own WebView only), no file or
 * content access, and the app's own origin (https://localhost, where the app's page and its storage live) cannot be
 * loaded in it. Cookies and storage are kept by origin; the forwarded page is http://127.0.0.1:port, another origin.
 *
 * Main thread only.
 */
final class ForwardView {
    private final AppCompatActivity activity;
    private final String appHost;        // the host of the app's own page ("localhost"): never loaded here
    private final Runnable onUserClosed; // the close button, or the system back with no history: "hidden"

    private LinearLayout root;
    private WebView web;
    private TextView address;
    private ProgressBar progress;
    private OnBackPressedCallback back;
    private AlertDialog dialog;          // the one question that may be open (certificate, sign in)
    private boolean paused;
    private final ArrayList<View> covered = new ArrayList<>();       // the app's views under this one ...
    private final ArrayList<Integer> coveredAccessibility = new ArrayList<>(); // ... and what they were for a screen reader

    ForwardView(AppCompatActivity activity, String appHost, Runnable onUserClosed) {
        this.activity = activity;
        this.appHost = appHost == null ? "localhost" : appHost.toLowerCase(Locale.ROOT);
        this.onUserClosed = onUserClosed;
    }

    boolean isOpen() {
        return root != null;
    }

    /** Shows the view with this page; one that is open is replaced (a new WebView: no history of the old page). */
    void open(String url, String title) {
        close();
        build(title);
        // What the view covers is not on the screen for a screen reader either (TalkBack would otherwise still walk
        // the app's page under it); close() gives it back.
        ViewGroup content = activity.findViewById(android.R.id.content);
        for (int i = 0; i < content.getChildCount(); i++) {
            View under = content.getChildAt(i);
            covered.add(under);
            coveredAccessibility.add(under.getImportantForAccessibility());
            under.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        }
        // Over the app's content (the CoordinatorLayout with Capacitor's WebView), which stays where it is and keeps
        // running: the forward itself is that page's JavaScript.
        activity.addContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // The system back button: callbacks added later are asked first, so while the view is open this one comes
        // before Capacitor's (the App plugin's "backButton"); removed in close(), and Capacitor's is asked again.
        back = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                goBackOrClose();
            }
        };
        activity.getOnBackPressedDispatcher().addCallback(back);
        applyInsets();
        web.requestFocus();
        if (paused) web.onPause();
        web.loadUrl(url);
    }

    /** Takes the view away (hide(), a replacing show(), the plugin's end). Says nothing to the page. */
    void close() {
        if (root == null) return;
        if (dialog != null) { dialog.dismiss(); dialog = null; } // its dismiss listener cancels what it asked about
        if (back != null) { back.remove(); back = null; }
        for (int i = 0; i < covered.size(); i++) covered.get(i).setImportantForAccessibility(coveredAccessibility.get(i));
        covered.clear();
        coveredAccessibility.clear();
        ViewGroup parent = (ViewGroup) root.getParent();
        if (parent != null) parent.removeView(root);
        web.stopLoading();
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(null);
        root.removeView(web);
        // "Continue" for an untrusted certificate holds for this view only: 127.0.0.1:port may be another computer
        // the next time.
        web.clearSslPreferences();
        web.destroy();
        root = null;
        web = null;
        address = null;
        progress = null;
    }

    void onPause() {
        paused = true;
        if (web != null) web.onPause();
    }

    void onResume() {
        paused = false;
        if (web != null) web.onResume();
    }

    private void userClosed() {
        if (root == null) return;
        close();
        onUserClosed.run();
    }

    private void goBackOrClose() {
        if (web != null && web.canGoBack()) web.goBack();
        else userClosed();
    }

    // ---- the views ------------------------------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private void build(String title) {
        root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(activity.getColor(R.color.agentdeck_bg));
        root.setClickable(true); // a touch beside the bar's buttons does not fall through to the app under the view

        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(activity.getColor(R.color.forward_bar));
        bar.addView(button(R.drawable.ic_forward_back, R.string.forward_back, v -> goBackOrClose()));
        bar.addView(button(R.drawable.ic_forward_reload, R.string.forward_reload, v -> { if (web != null) web.reload(); }));

        // The name the page gave (the computer and the port, say) over the address; the address alone without one.
        LinearLayout texts = new LinearLayout(activity);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setGravity(Gravity.CENTER_VERTICAL);
        texts.setPadding(dp(6), 0, dp(6), 0);
        if (!TextUtils.isEmpty(title)) {
            TextView name = line(11, R.color.forward_muted);
            name.setText(title);
            texts.addView(name);
        }
        address = line(14, R.color.forward_text);
        texts.addView(address);
        bar.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        bar.addView(button(R.drawable.ic_forward_close, R.string.forward_close, v -> userClosed()));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        // How far the page has loaded, as a line under the bar (it also is the bar's lower edge).
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(ColorStateList.valueOf(activity.getColor(R.color.forward_accent)));
        progress.setProgressBackgroundTintList(ColorStateList.valueOf(activity.getColor(R.color.forward_line)));
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        web = new WebView(activity);
        web.setBackgroundColor(0xFFFFFFFF); // pages without a background expect a white one, as in a browser
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(false);
        // A page served over https (a dev server with its own certificate) may still take scripts over http from the
        // same forwarded port; what a browser would let through is let through.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // window.open and target="_blank" open in this same view: there is one view and no second window.
        s.setSupportMultipleWindows(false);
        // Like a browser: desktop-made pages are fitted to the width and can be zoomed with two fingers.
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        web.setWebViewClient(new Pages());
        web.setWebChromeClient(new Chrome());
        // No DownloadListener: a download is not started (there is nowhere to put it yet). No file chooser either
        // (Chrome.onShowFileChooser is not overridden: <input type="file"> does nothing).
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        // The app draws edge to edge and Capacitor's SystemBars either pads the window's decor view by the system
        // bars or leaves them to the page (viewport-fit=cover): this view takes whatever the decor view did not, so
        // the bar is never under the status bar or a cutout, nor the page under the gesture area or the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> { applyInsets(); return insets; });
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> v.post(this::applyInsets));
    }

    private ImageButton button(int icon, int label, View.OnClickListener onClick) {
        ImageButton b = new ImageButton(activity);
        b.setImageResource(icon);
        b.setContentDescription(activity.getString(label));
        TypedValue ripple = new TypedValue();
        activity.getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true);
        b.setBackgroundResource(ripple.resourceId);
        b.setOnClickListener(onClick);
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        return b;
    }

    private TextView line(int sp, int color) {
        TextView t = new TextView(activity);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(activity.getColor(color));
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        return t;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private void applyInsets() {
        if (root == null) return;
        View decor = activity.getWindow().getDecorView();
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
        if (insets == null) return;
        Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
        int left = Math.max(0, bars.left - decor.getPaddingLeft());
        int top = Math.max(0, bars.top - decor.getPaddingTop());
        int right = Math.max(0, bars.right - decor.getPaddingRight());
        int bottom = Math.max(0, Math.max(bars.bottom, keyboard.bottom) - decor.getPaddingBottom());
        if (left != root.getPaddingLeft() || top != root.getPaddingTop() || right != root.getPaddingRight() || bottom != root.getPaddingBottom()) {
            root.setPadding(left, top, right, bottom);
        }
    }

    private void showAddress(String url) {
        if (address != null && url != null) address.setText(url);
    }

    // The app's own page lives at https://localhost: never in this view, whatever a page tries.
    private boolean isAppHost(Uri uri) {
        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        return host.equals(appHost) || host.equals("localhost") || host.endsWith(".localhost");
    }

    // One question at a time. Every way a dialog can go (a button, back, a touch outside, the view closing under it)
    // ends in its dismissal, and the answer is given there: yes only after the positive button, no for all the rest -
    // so the WebView's handler is always answered, once.
    private void ask(AlertDialog.Builder builder, int yesLabel, Runnable onYes, Runnable onNo) {
        if (dialog != null) dialog.dismiss();
        final boolean[] yes = { false };
        AlertDialog shown = builder
                .setNegativeButton(R.string.forward_cancel, null)
                .setPositiveButton(yesLabel, (d, w) -> yes[0] = true)
                .setOnDismissListener(d -> {
                    if (dialog == d) dialog = null;
                    if (yes[0]) onYes.run(); else onNo.run();
                })
                .create();
        dialog = shown;
        shown.show();
    }

    // ---- navigation ---------------------------------------------------------------------------------------------

    private final class Pages extends WebViewClient {
        // Links: http and https open here, whatever the host (a dev page's login redirect, its docs). Everything else
        // (intent:, market:, tel:, mailto:, file:, content:, ...) is ignored: this view starts no other app.
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) return true;
            return isAppHost(uri);
        }

        // The same refusal for what is not a navigation (a frame, a script, a redirect, a fetch).
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (!isAppHost(request.getUrl())) return null;
            return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            showAddress(url);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            showAddress(url); // also the navigations a page makes itself (pushState, #fragment)
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            showAddress(view.getUrl());
        }

        // A certificate the phone does not trust. Only the forwarded listener (host 127.0.0.1: the user's own dev
        // server with a self-signed certificate, reached through the app's encrypted link) may be let through, and
        // only when the user says so; any other host is refused without a question.
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            Uri uri = Uri.parse(error.getUrl() == null ? "" : error.getUrl());
            if (root == null || !"127.0.0.1".equals(uri.getHost())) { handler.cancel(); return; }
            String where = uri.getPort() > 0 ? uri.getHost() + ":" + uri.getPort() : uri.getHost();
            ask(new AlertDialog.Builder(activity)
                    .setTitle(R.string.forward_ssl_title)
                    .setMessage(activity.getString(R.string.forward_ssl_message, where)),
                R.string.forward_continue, handler::proceed, handler::cancel);
        }

        // Basic / digest sign in: asked once per request, nothing is stored by the app.
        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            if (root == null) { handler.cancel(); return; }
            LinearLayout fields = new LinearLayout(activity);
            fields.setOrientation(LinearLayout.VERTICAL);
            fields.setPadding(dp(20), dp(8), dp(20), 0);
            EditText user = new EditText(activity);
            user.setHint(R.string.forward_auth_user);
            user.setSingleLine(true);
            user.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            EditText password = new EditText(activity);
            password.setHint(R.string.forward_auth_password);
            password.setSingleLine(true);
            password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            fields.addView(user);
            fields.addView(password);
            ask(new AlertDialog.Builder(activity)
                    .setTitle(activity.getString(R.string.forward_auth_title, host))
                    .setView(fields),
                R.string.forward_auth_ok,
                () -> handler.proceed(user.getText().toString(), password.getText().toString()), handler::cancel);
        }

        // The page's renderer crashed or was killed for memory: without this the whole app would be killed with it.
        // The view is closed as if the user had closed it.
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            view.post(() -> { if (view == web) userClosed(); }); // not from inside the WebView's own callback
            return true;
        }
    }

    // Permission requests (camera, microphone, location) are denied and a second window is never made: the defaults.
    // alert / confirm / prompt show the WebView's own dialogs.
    private final class Chrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int value) {
            if (progress == null) return;
            progress.setProgress(value);
            progress.setVisibility(value >= 100 ? View.INVISIBLE : View.VISIBLE);
        }
    }
}
