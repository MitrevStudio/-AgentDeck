package com.mitrevstudio.agentdeck;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own local plugin (not from npm): the Keystore-backed secret store.
        registerPlugin(SecureStorePlugin.class);
        super.onCreate(savedInstanceState);
        // A terminal zoomed out to its whole width draws text at a few pixels; the WebView's default minimum (8 px)
        // would draw it bigger than its cells and the rows would overlap.
        WebSettings s = getBridge().getWebView().getSettings();
        s.setMinimumFontSize(1);
        s.setMinimumLogicalFontSize(1);
    }
}
