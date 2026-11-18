import Capacitor
import UIKit

/// What a page in WKWebView cannot do itself (mobile/src/ios.js): there is no navigator.vibrate, and the page's
/// clipboard is the browser's - writing takes a touch on the very button, reading shows a bubble to press first.
///
/// buzz({ strong }) - a tap of the Taptic Engine; strong: the pattern of a notification (a session waits).
/// copy({ text }), paste() -> { text } - the system pasteboard (iOS asks the user before a paste from another app).
@objc(PhonePlugin)
public class PhonePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhonePlugin"
    public let jsName = "Phone"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "buzz", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "paste", returnType: CAPPluginReturnPromise)
    ]

    @objc func buzz(_ call: CAPPluginCall) {
        let strong = call.getBool("strong") ?? false
        DispatchQueue.main.async {
            if strong {
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
            } else {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            call.resolve()
        }
    }

    @objc func copy(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else {
            call.reject("no text", "invalidData")
            return
        }
        UIPasteboard.general.string = text
        call.resolve()
    }

    @objc func paste(_ call: CAPPluginCall) {
        call.resolve(["text": UIPasteboard.general.string ?? ""])
    }
}
