import Capacitor
import Foundation
import Security
import UIKit

/// The app's secrets (the phone's Noise key and its paired computers, docs/MOBILE.md 3.4), local only: one generic
/// password item per entry in the Keychain, readable only while the phone is unlocked and only on this device
/// (kSecAttrAccessibleWhenUnlockedThisDeviceOnly) and never synchronised - so not in iCloud Keychain, and a backup
/// restored to another phone does not have them. The same four calls as android/.../SecureStorePlugin.java:
///
/// get({ key }) -> { value: string | null }, set({ key, value }), remove({ key }), device() -> { model, manufacturer }.
///
/// The Keychain outlives the app: iOS keeps its items when the app is deleted. A marker file in the app's own folder
/// (which does go with the app, and is kept out of backups) tells a fresh install, and what an earlier install left
/// is removed before anything is read - a deleted app is an unpaired phone, as on Android.
///
/// The app lock (Face ID / Touch ID) is not here yet: the seam is the item's access control
/// (SecAccessControlCreateWithFlags with .userPresence) and keystore.js's lock object.
@objc(SecureStorePlugin)
public class SecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStorePlugin"
    public let jsName = "SecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "device", returnType: CAPPluginReturnPromise)
    ]

    private static let service = "agentdeck.securestore.v1"
    private static let maxValue = 1024 * 1024

    override public func load() {
        guard var marker = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        try? FileManager.default.createDirectory(at: marker, withIntermediateDirectories: true)
        marker.appendPathComponent("securestore.installed")
        if FileManager.default.fileExists(atPath: marker.path) { return }
        SecItemDelete(Self.query(nil) as CFDictionary)
        FileManager.default.createFile(atPath: marker.path, contents: Data())
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? marker.setResourceValues(values)
    }

    // The items of this store: all of them (key nil) or one entry's.
    private static func query(_ key: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: false
        ]
        if let key = key { q[kSecAttrAccount as String] = key }
        return q
    }

    private func entry(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), key.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil else { return nil }
        return key
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = entry(call), let value = call.getString("value"), value.utf16.count <= Self.maxValue else {
            call.reject("invalid key or value", "invalidData")
            return
        }
        let data = Data(value.utf8)
        // An entry that is there is changed in place: it is the old value or the new one, never neither.
        var status = SecItemUpdate(Self.query(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = Self.query(key)
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        if status == errSecSuccess { call.resolve() } else { call.reject("could not store: \(Self.text(status))", "storeFailed") }
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = entry(call) else {
            call.reject("invalid key", "invalidData")
            return
        }
        var q = Self.query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &found)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
        } else if status == errSecSuccess, let data = found as? Data, let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else {
            // An entry that cannot be read (the phone locked itself meanwhile, a damaged item): reported, not guessed around.
            call.reject("could not read: \(Self.text(status))", "storeFailed")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = entry(call) else {
            call.reject("invalid key", "invalidData")
            return
        }
        let status = SecItemDelete(Self.query(key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { call.resolve() } else { call.reject("could not remove: \(Self.text(status))", "storeFailed") }
    }

    // What the app calls itself towards the computers until the user names it: "iPhone" (iOS gives an app neither the
    // name the user gave the phone nor a readable model).
    @objc func device(_ call: CAPPluginCall) {
        call.resolve(["model": UIDevice.current.model, "manufacturer": ""])
    }

    private static func text(_ status: OSStatus) -> String {
        (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
    }
}
