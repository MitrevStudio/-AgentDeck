package com.mitrevstudio.agentdeck;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The app's secrets (the phone's Noise key and its paired computers, docs/MOBILE.md 3.4), local only: an AES-256-GCM
 * key that lives in the Android Keystore (it never leaves it; hardware-backed where the device has it) wraps one file
 * per entry in the app's no-backup folder. Nothing goes to Google, a cloud backup or the network.
 *
 * get({ key }) -> { value: string | null }, set({ key, value }), remove({ key }), device() -> { model, manufacturer }.
 *
 * The app lock (fingerprint / face) is not here yet: the seam is the key's spec below
 * (setUserAuthenticationRequired + a BiometricPrompt around get), and keystore.js's lock object.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String ALIAS = "agentdeck.securestore.v1";
    private static final String DIR = "securestore";
    private static final int IV_BYTES = 12, TAG_BITS = 128, MAX_VALUE = 1024 * 1024;

    private static String fileName(String key) {
        if (key == null || !key.matches("[A-Za-z0-9._-]{1,64}")) return null;
        return key + ".bin";
    }

    private SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    private File dir() {
        File d = new File(getContext().getNoBackupFilesDir(), DIR);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = fileName(call.getString("key"));
        String value = call.getString("value");
        if (name == null || value == null || value.length() > MAX_VALUE) { call.reject("invalid key or value", "invalidData"); return; }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8)); // a file renamed to another entry does not decrypt
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            ByteBuffer out = ByteBuffer.allocate(1 + iv.length + sealed.length);
            out.put((byte) iv.length).put(iv).put(sealed);
            // Written aside and renamed: a crash leaves the old entry or the new one, never half of one.
            File tmp = new File(dir(), name + ".tmp");
            try (FileOutputStream f = new FileOutputStream(tmp)) {
                f.write(out.array());
                f.getFD().sync();
            }
            if (!tmp.renameTo(new File(dir(), name))) throw new Exception("rename failed");
            call.resolve();
        } catch (Exception e) {
            call.reject("could not store: " + e.getMessage(), "storeFailed");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = fileName(call.getString("key"));
        if (name == null) { call.reject("invalid key", "invalidData"); return; }
        File file = new File(dir(), name);
        JSObject ret = new JSObject();
        if (!file.exists()) { ret.put("value", null); call.resolve(ret); return; }
        try {
            byte[] all = readAll(file);
            int ivLen = all[0] & 0xff;
            if (ivLen != IV_BYTES || all.length < 1 + ivLen + TAG_BITS / 8) throw new Exception("damaged entry");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(TAG_BITS, all, 1, ivLen));
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            byte[] plain = cipher.doFinal(all, 1 + ivLen, all.length - 1 - ivLen);
            ret.put("value", new String(plain, StandardCharsets.UTF_8));
            call.resolve(ret);
        } catch (Exception e) {
            // A key that is gone (the user cleared credentials, a restore to another device) leaves entries nobody can
            // read: reported, not guessed around.
            call.reject("could not read: " + e.getMessage(), "storeFailed");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = fileName(call.getString("key"));
        if (name == null) { call.reject("invalid key", "invalidData"); return; }
        File file = new File(dir(), name);
        if (file.exists() && !file.delete()) { call.reject("could not remove", "storeFailed"); return; }
        call.resolve();
    }

    // What the app calls itself towards the computers until the user names it: the device's model.
    @PluginMethod
    public void device(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("model", Build.MODEL);
        ret.put("manufacturer", Build.MANUFACTURER);
        call.resolve(ret);
    }

    private static byte[] readAll(File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }
}
