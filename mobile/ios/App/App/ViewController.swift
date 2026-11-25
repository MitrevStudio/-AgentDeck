import Capacitor
import UIKit
import WebKit

/// The app's one screen: Capacitor's web view with the app's own local plugins (not from npm).
class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SecureStorePlugin())
        bridge?.registerPluginInstance(PhonePlugin())
        bridge?.registerPluginInstance(ForwardPlugin())
        bridge?.registerPluginInstance(FilesPlugin())
        // A swipe from the screen's left edge goes back, as the Back button does on Android: the app keeps its
        // screens in the page's history (main.js go / popstate).
        webView?.allowsBackForwardNavigationGestures = true
        #if DEBUG && targetEnvironment(simulator)
        startDriver()
        #endif
    }
}

#if DEBUG && targetEnvironment(simulator)
// For the simulator on a CI runner only (scripts/ios-simulator.js; nobody can touch that screen): a script put into
// the app's own Documents/drive folder as next.js is run in the page and what it returns is written to result.txt
// beside it; the one word "landscape" or "portrait" instead of a script turns the phone. Without that folder
// nothing happens. Not compiled into a build for a real phone.
extension ViewController {
    func startDriver() {
        guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let dir = docs.appendingPathComponent("drive")
        guard FileManager.default.fileExists(atPath: dir.path) else { return }
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            let next = dir.appendingPathComponent("next.js")
            guard let script = try? String(contentsOf: next, encoding: .utf8) else { return }
            try? FileManager.default.removeItem(at: next)
            let word = script.trimmingCharacters(in: .whitespacesAndNewlines)
            if word == "landscape" || word == "portrait" {
                let turn = UIWindowScene.GeometryPreferences.iOS(interfaceOrientations: word == "landscape" ? .landscapeRight : .portrait)
                self?.view.window?.windowScene?.requestGeometryUpdate(turn)
                try? "ok \(word)".write(to: dir.appendingPathComponent("result.txt"), atomically: true, encoding: .utf8)
                return
            }
            self?.webView?.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
                var out: String
                switch result {
                case .success(let value): out = "ok \(value)"
                case .failure(let error): out = "error \(error)"
                }
                try? out.write(to: dir.appendingPathComponent("result.txt"), atomically: true, encoding: .utf8)
            }
        }
    }
}
#endif
