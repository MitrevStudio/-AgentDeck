package com.mitrevstudio.agentdeck;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own local plugin (not from npm): the Keystore-backed secret store.
        registerPlugin(SecureStorePlugin.class);
        // Port forwarding (docs/PORT-FORWARDING.md 4.1): the listener on 127.0.0.1 and the in-app view of the page.
        registerPlugin(ForwardPlugin.class);
        // Files from a computer (docs/FILES.md 5.1): saved to Downloads a piece at a time, a PDF shown by the system.
        registerPlugin(FilesPlugin.class);
        super.onCreate(savedInstanceState);
        // A terminal zoomed out to its whole width draws text at a few pixels; the WebView's default minimum (8 px)
        // would draw it bigger than its cells and the rows would overlap.
        WebSettings s = getBridge().getWebView().getSettings();
        s.setMinimumFontSize(1);
        s.setMinimumLogicalFontSize(1);
    }
}
