// Where the phone keeps its identity and what it is paired with (docs/MOBILE.md 3.4, 5), and the seam of the app lock.
//
// On the phone: the app's own SecureStore plugin (android/.../SecureStorePlugin.java) - an AES-GCM key in the Android
// Keystore wraps one file per entry in the app's no-backup folder; nothing leaves the device. iOS will need the same
// four calls over the Keychain (kSecClassGenericPassword, kSecAttrAccessibleWhenUnlockedThisDeviceOnly).
//
// In a browser (npm run dev) there is no secure storage: the entries go to localStorage, which anyone with the
// profile's files can read. DEV ONLY - `keystore.secure` is false there and the Computers screen says so.
//
// Entries (JSON):
//   identity: { publicKey, privateKey } as hex - the phone's X25519 key for Noise, made once (noise.generateKeypair)
//   peers:    what web-client.js hands onPeersChanged: [{ id, key, name, kind, address, port, pairedAt }]
//   name:     what the phone calls itself towards the computers (the device model until the user names it)
import { Capacitor, registerPlugin } from "@capacitor/core";

const SecureStore = registerPlugin("SecureStore");
// Capacitor's bridge logs every plugin call with its options and its answer while the config's loggingBehavior lets
// it (a debug build): in logcat that reads "Msg: [object Object]" / "Msg: undefined", and in the WebView's console
// it is the call itself - the identity's private key with set("identity"). Off: the app's own console lines stay.
for (const cap of new Set([globalThis.Capacitor, Capacitor])) if (cap) cap.isLoggingEnabled = false;
const native = () => Boolean(Capacitor.isNativePlatform?.() && Capacitor.isPluginAvailable?.("SecureStore"));
const DEV_PREFIX = "agentdeck.dev-insecure-keystore.";

async function readRaw(name) {
  if (native()) return (await SecureStore.get({ key: name }))?.value ?? null;
  try { return localStorage.getItem(DEV_PREFIX + name); } catch { return null; }
}
async function writeRaw(name, text) {
  if (native()) {
    if (text == null) await SecureStore.remove({ key: name });
    else await SecureStore.set({ key: name, value: text });
    return;
  }
  try {
    if (text == null) localStorage.removeItem(DEV_PREFIX + name);
    else localStorage.setItem(DEV_PREFIX + name, text);
  } catch {}
}
async function read(name) {
  const text = await readRaw(name);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}
const write = (name, value) => writeRaw(name, value == null ? null : JSON.stringify(value));

export const keystore = {
  get secure() { return native(); },

  async getIdentity() { return read("identity"); },
  async setIdentity(pair) { await write("identity", pair); },

  async getPeers() { return (await read("peers")) || []; },
  async setPeers(list) { await write("peers", list); },

  async getName() { return read("name"); },
  async setName(name) { await write("name", name); },

  // Everything gone (this phone unpaired): a new identity is made next time.
  async clear() { for (const n of ["identity", "peers"]) await write(n, null); }
};

// The device's model ("Pixel 8"), for the name the phone gives itself; "" when unknown (a browser).
export async function deviceModel() {
  if (!native()) return "";
  try {
    const d = await SecureStore.device();
    const model = String(d?.model || "").trim(), maker = String(d?.manufacturer || "").trim();
    if (!model) return "";
    return maker && !model.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker[0].toUpperCase()}${maker.slice(1)} ${model}` : model;
  } catch { return ""; }
}

// The lock in front of the app (fingerprint / face): not built yet, always open. The seam: unlock() runs before the
// identity is read (main.js boot); the real one would make the Keystore key require user authentication.
export const lock = {
  async available() { return false; },
  async unlock() { return true; }
};
