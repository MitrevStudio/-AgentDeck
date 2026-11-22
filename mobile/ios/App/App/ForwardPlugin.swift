import Capacitor
import Darwin
import Foundation
import Network
import UIKit
import WebKit

/// Port forwarding on the phone (docs/PORT-FORWARDING.md 4.1; the same contract as android/.../ForwardPlugin.java):
/// a TCP listener on 127.0.0.1 whose connections' bytes go to and from the page over the bridge (base64) - the page
/// carries them to the computer through the app's encrypted link - and the in-app web view that opens such a port.
///
/// listen({ port }) -> { listener, port }, unlisten({ listener }), write({ conn, data }), end({ conn }),
/// close({ conn }), credit({ conn, bytes }), show({ url, title }), hide();
/// events "connection" { listener, conn }, "data" { conn, data }, "end" { conn }, "closed" { conn, error }, "hidden" {}.
///
/// Threads: every listener and connection lives on one serial queue (`work`) - Network.framework calls back on it,
/// the plugin's calls hop onto it, and the events are sent from it, so they reach the page in the order things
/// happened: "data" in the order of the bytes, "end" after the last of them, "closed" last and once. The web view is
/// the main thread's.
///
/// Only loopback: the listener is bound to 127.0.0.1 and has no Bonjour service, so nothing here asks for the local
/// network permission.
///
/// In the background iOS suspends the app and may take its sockets. Nothing is closed here for that: a connection
/// that died says "closed" with the error when it is next read or written, and a listener that failed is opened again
/// on its own port under its own name (the page sees nothing); when the port cannot be had again the listener is gone -
/// its connections say "closed" and an unlisten() of it answers "unknownListener".
@objc(ForwardPlugin)
public class ForwardPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForwardPlugin"
    public let jsName = "Forward"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlisten", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "credit", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise)
    ]

    private static let maxWrite = 64 * 1024   // the bytes of one write()
    private static let maxRead = 32 * 1024    // the bytes of one "data" event
    private static let window = 256 * 1024    // delivered and not yet credited: at this much the socket is not read
    private static let rebinds = 5            // tries to open a failed listener again on its port

    private final class Listener {
        let id: String
        var port = 0
        var nw: NWListener?        // listening
        var binding: NWListener?   // started, not ready yet (kept alive here)
        init(id: String) { self.id = id }
    }

    private final class Conn {
        let id: String
        let listener: String
        let nw: NWConnection
        var uncredited = 0        // bytes of "data" events the page has not credited yet
        var reading = false       // a receive is outstanding
        var inputDone = false     // the client's FIN was read: "end" was said
        var outputEnded = false   // end() was called: no write is taken any more
        var outputDone = false    // our FIN was handed to the socket
        var closed = false        // "closed" was said: nothing more happens to this connection
        var waiting: [Int: CAPPluginCall] = [:]   // write() and end() calls not answered yet
        init(id: String, listener: String, nw: NWConnection) {
            self.id = id
            self.listener = listener
            self.nw = nw
        }
    }

    private let work = DispatchQueue(label: "agentdeck.forward")
    // Only on `work`:
    private var listening: [String: Listener] = [:]
    private var conns: [String: Conn] = [:]
    private var serial = 0

    // The pages opened from the app keep their cookies and storage for the app's run, apart from the app's own page.
    private static let pages = WKWebsiteDataStore.nonPersistent()
    // Only on the main thread:
    private var shown: ForwardViewController?

    deinit {
        // The bridge is gone: nothing may stay listening. Nothing else can hold the plugin here (the handlers hold it
        // weakly), so its state is touched directly.
        for l in listening.values {
            if let nw = l.nw { ForwardPlugin.drop(nw) }
            if let nw = l.binding { ForwardPlugin.drop(nw) }
        }
        for c in conns.values {
            c.nw.stateUpdateHandler = nil
            c.nw.cancel()
        }
    }

    // ---- listeners ----------------------------------------------------------------------------------------------

    @objc func listen(_ call: CAPPluginCall) {
        let asked = call.getInt("port") ?? 0
        work.async {
            var wished: UInt16 = 0
            // A port one of our listeners already has is not wished for again: that one keeps it.
            if asked >= 1 && asked <= 65535 && !self.listening.values.contains(where: { $0.port == asked }) {
                wished = UInt16(asked)
            }
            self.serial += 1
            let l = Listener(id: "l\(self.serial)")
            self.listening[l.id] = l
            self.tryListen(l, stage: wished == 0 ? 1 : 0, wished: wished, call: call, last: "")
        }
    }

    // The port wished for; taken (or not allowed) -> any free one, chosen by the system; and should the system not
    // say which it chose -> one found free a moment ago.
    private func tryListen(_ l: Listener, stage: Int, wished: UInt16, call: CAPPluginCall, last: String) {
        var port: UInt16 = 0
        if stage == 0 {
            port = wished
        } else if stage == 2 {
            port = freeLoopbackPort()
        }
        if stage > 2 || (stage == 2 && port == 0) {
            listening.removeValue(forKey: l.id)
            call.reject("could not listen: \(last)", "listenFailed")
            return
        }
        bind(l, port: port) { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                self.tryListen(l, stage: stage + 1, wished: wished, call: call, last: error)
            } else {
                call.resolve(["listener": l.id, "port": l.port])
            }
        }
    }

    private static func parameters(port: UInt16) -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let parameters = NWParameters(tls: nil, tcp: tcp)
        // 127.0.0.1 and nothing else; port 0 = any free one. Without a service (Bonjour) nothing is advertised.
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host.ipv4(IPv4Address.loopback), port: NWEndpoint.Port(rawValue: port) ?? NWEndpoint.Port.any)
        // A port closed a moment ago, or one whose earlier connections are still open, can be listened on again.
        parameters.allowLocalEndpointReuse = true
        return parameters
    }

    private static func drop(_ nw: NWListener) {
        nw.stateUpdateHandler = nil
        nw.newConnectionHandler = nil
        nw.cancel()
    }

    // Starts a listener for `l` on the port (0: any). `done` is called once, on the queue: nil when it listens
    // (l.nw and l.port are set), or the error's text. A listener that fails after that is opened again (rebind).
    private func bind(_ l: Listener, port: UInt16, done: @escaping (String?) -> Void) {
        let nw: NWListener
        do {
            nw = try NWListener(using: ForwardPlugin.parameters(port: port))
        } catch {
            done(ForwardPlugin.text(error))
            return
        }
        var answer: ((String?) -> Void)? = done
        l.binding = nw
        nw.stateUpdateHandler = { [weak self, weak l, weak nw] state in
            guard let self = self, let l = l, let nw = nw else { return }
            switch state {
            case .ready:
                guard let ready = answer else { return }
                answer = nil
                l.binding = nil
                let got = Int(nw.port?.rawValue ?? 0)
                if got == 0 {
                    ForwardPlugin.drop(nw)
                    ready("the system did not say which port it chose")
                    return
                }
                l.nw = nw
                l.port = got
                ready(nil)
            case .failed(let error):
                // Before it listened: the port is taken (or may not be had). After: its socket was taken away.
                let failed = answer
                answer = nil
                let listened = l.nw === nw
                ForwardPlugin.drop(nw)
                if let failed = failed {
                    l.binding = nil
                    failed(ForwardPlugin.text(error))
                } else if listened {
                    l.nw = nil
                    self.rebind(l, tries: ForwardPlugin.rebinds, last: ForwardPlugin.text(error))
                }
            case .waiting(let error):
                // Before it listened this may pass (the time limit below ends the wait); after, it listens no more.
                guard answer == nil, l.nw === nw else { return }
                ForwardPlugin.drop(nw)
                l.nw = nil
                self.rebind(l, tries: ForwardPlugin.rebinds, last: ForwardPlugin.text(error))
            default:
                break
            }
        }
        // A listener that neither listens nor fails is not waited for: the call is answered either way.
        work.asyncAfter(deadline: .now() + .seconds(3)) { [weak l, weak nw] in
            guard let late = answer else { return }
            answer = nil
            if let nw = nw { ForwardPlugin.drop(nw) }
            l?.binding = nil
            late("the listener did not start")
        }
        nw.newConnectionHandler = { [weak self, weak l] connection in
            guard let self = self, let l = l, self.listening[l.id] === l else {
                connection.cancel()
                return
            }
            self.accept(connection, on: l)
        }
        nw.start(queue: work)
    }

    // A listener that failed while listening (the app was suspended and iOS took its socket): the same listener for
    // the page, on the same port, a moment later. When the port cannot be had the listener is over.
    private func rebind(_ l: Listener, tries: Int, last: String) {
        if tries <= 0 {
            lose(l, error: "the listener failed: \(last)")
            return
        }
        work.asyncAfter(deadline: .now() + .milliseconds(300)) { [weak self, weak l] in
            guard let self = self, let l = l, self.listening[l.id] === l, l.nw == nil, l.binding == nil else { return }
            self.bind(l, port: UInt16(l.port)) { [weak self, weak l] error in
                guard let self = self, let l = l, let error = error else { return }
                self.rebind(l, tries: tries - 1, last: error)
            }
        }
    }

    // The listener is over: it and every connection it took.
    private func lose(_ l: Listener, error: String) {
        guard listening[l.id] === l else { return }
        listening.removeValue(forKey: l.id)
        if let nw = l.nw { ForwardPlugin.drop(nw) }
        if let nw = l.binding { ForwardPlugin.drop(nw) }
        l.nw = nil
        l.binding = nil
        for c in conns.values.filter({ $0.listener == l.id }) { finish(c, error: error) }
    }

    @objc func unlisten(_ call: CAPPluginCall) {
        guard let id = call.getString("listener") else {
            call.reject("no listener", "invalidData")
            return
        }
        work.async {
            guard let l = self.listening[id] else {
                call.reject("unknown listener", "unknownListener")
                return
            }
            self.lose(l, error: "")
            call.resolve()
        }
    }

    // ---- connections --------------------------------------------------------------------------------------------

    private func accept(_ nw: NWConnection, on l: Listener) {
        serial += 1
        let c = Conn(id: "c\(serial)", listener: l.id, nw: nw)
        conns[c.id] = c
        notifyListeners("connection", data: ["listener": l.id, "conn": c.id])
        nw.stateUpdateHandler = { [weak self, weak c] state in
            guard let self = self, let c = c else { return }
            switch state {
            case .ready:
                self.read(c)
            case .failed(let error), .waiting(let error):
                self.finish(c, error: ForwardPlugin.text(error))
            case .cancelled:
                self.finish(c, error: "")
            default:
                break
            }
        }
        nw.start(queue: work)
    }

    // One receive at a time, and none while the page holds a window of bytes it has not credited: the socket's own
    // buffer fills and TCP holds the client back.
    private func read(_ c: Conn) {
        guard !c.closed, !c.reading, !c.inputDone, c.uncredited < ForwardPlugin.window else { return }
        c.reading = true
        c.nw.receive(minimumIncompleteLength: 1, maximumLength: ForwardPlugin.maxRead) { [weak self, weak c] data, _, isComplete, error in
            guard let self = self, let c = c else { return }
            c.reading = false
            if c.closed { return }
            if let data = data, !data.isEmpty {
                c.uncredited += data.count
                self.notifyListeners("data", data: ["conn": c.id, "data": data.base64EncodedString()])
            }
            if let error = error {
                self.finish(c, error: ForwardPlugin.text(error))
                return
            }
            if isComplete {
                // The client's FIN. It may still be written to, until end() or close().
                c.inputDone = true
                self.notifyListeners("end", data: ["conn": c.id])
                if c.outputDone { self.finish(c, error: "") }
                return
            }
            self.read(c)
        }
    }

    // The one place a connection ends: "closed" is said here and nowhere else, so once.
    private func finish(_ c: Conn, error: String) {
        guard !c.closed else { return }
        c.closed = true
        conns.removeValue(forKey: c.id)
        c.nw.stateUpdateHandler = nil
        c.nw.cancel()
        let waiting = c.waiting
        c.waiting.removeAll()
        for call in waiting.values { call.reject("the connection is gone", "unknownConnection") }
        notifyListeners("closed", data: ["conn": c.id, "error": error])
    }

    private func hold(_ call: CAPPluginCall, for c: Conn) -> Int {
        serial += 1
        c.waiting[serial] = call
        return serial
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let id = call.getString("conn"), let text = call.getString("data") else {
            call.reject("no connection or data", "invalidData")
            return
        }
        guard let data = Data(base64Encoded: text) else {
            call.reject("data is not base64", "invalidData")
            return
        }
        guard data.count <= ForwardPlugin.maxWrite else {
            call.reject("more than 64 KB in one write", "invalidData")
            return
        }
        work.async {
            guard let c = self.conns[id] else {
                call.reject("the connection is gone", "unknownConnection")
                return
            }
            if c.outputEnded {
                call.reject("the connection was ended", "ended")
                return
            }
            if data.isEmpty {
                call.resolve()
                return
            }
            // Answered when the bytes were taken by the socket; the sends of one connection are done in order.
            let token = self.hold(call, for: c)
            c.nw.send(content: data, completion: .contentProcessed { [weak self, weak c] error in
                guard let self = self, let c = c, let call = c.waiting.removeValue(forKey: token) else { return }
                if let error = error {
                    call.reject("the connection is gone", "unknownConnection")
                    self.finish(c, error: ForwardPlugin.text(error))
                } else {
                    call.resolve()
                }
            })
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard let id = call.getString("conn") else {
            call.reject("no connection", "invalidData")
            return
        }
        work.async {
            guard let c = self.conns[id] else {
                call.reject("the connection is gone", "unknownConnection")
                return
            }
            if c.outputEnded {
                call.resolve()
                return
            }
            c.outputEnded = true
            // The half close of Network.framework: the final message, complete, after the sends before it - a FIN
            // once what was written is out. The client may still send.
            let token = self.hold(call, for: c)
            c.nw.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self, weak c] error in
                guard let self = self, let c = c, let call = c.waiting.removeValue(forKey: token) else { return }
                if let error = error {
                    call.reject("the connection is gone", "unknownConnection")
                    self.finish(c, error: ForwardPlugin.text(error))
                    return
                }
                call.resolve()
                c.outputDone = true
                // Both sides have finished: the connection is over.
                if c.inputDone { self.finish(c, error: "") }
            })
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let id = call.getString("conn") else {
            call.reject("no connection", "invalidData")
            return
        }
        work.async {
            guard let c = self.conns[id] else {
                call.reject("the connection is gone", "unknownConnection")
                return
            }
            self.finish(c, error: "")
            call.resolve()
        }
    }

    @objc func credit(_ call: CAPPluginCall) {
        guard let id = call.getString("conn"), let bytes = call.getInt("bytes"), bytes >= 0 else {
            call.reject("no connection or bytes", "invalidData")
            return
        }
        work.async {
            guard let c = self.conns[id] else {
                call.reject("the connection is gone", "unknownConnection")
                return
            }
            c.uncredited = max(0, c.uncredited - bytes)
            self.read(c)
            call.resolve()
        }
    }

    private static func text(_ error: Error) -> String {
        let text = String(describing: error)
        return text.isEmpty ? "error" : text
    }

    // ---- the in-app view ----------------------------------------------------------------------------------------

    @objc func show(_ call: CAPPluginCall) {
        guard let address = call.getString("url"), let url = URL(string: address), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            call.reject("an http or https address is needed", "invalidData")
            return
        }
        let heading = call.getString("title") ?? ""
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let root = self.bridge?.viewController else {
                call.reject("the app is closing", "shutDown")
                return
            }
            let next = ForwardViewController(url: url, heading: heading, store: ForwardPlugin.pages)
            next.onClose = { [weak self, weak next] in
                guard let self = self else { return }
                if self.shown === next { self.shown = nil }
                self.notifyListeners("hidden", data: [:])
            }
            let present = {
                // Over whatever is on top (a sheet of the system's, say), so that the view is seen.
                var top: UIViewController = root
                while let above = top.presentedViewController, !above.isBeingDismissed { top = above }
                self.shown = next
                top.present(next, animated: true, completion: nil)
                call.resolve()
            }
            // One view: the one that is open goes first, without a "hidden".
            if let old = self.shown {
                self.shown = nil
                old.leave(animated: false, completion: present)
            } else {
                present()
            }
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let self = self, let old = self.shown {
                self.shown = nil
                old.leave(animated: true, completion: nil)
            }
            call.resolve()
        }
    }
}

// A port on 127.0.0.1 that is free now: bound for a moment, asked for its number and closed.
private func freeLoopbackPort() -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return 0 }
    defer { _ = Darwin.close(fd) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr = in_addr(s_addr: UInt32(0x7f00_0001).bigEndian)
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let size = length
    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, size) }
    }
    guard bound == 0 else { return 0 }
    let named = withUnsafeMutablePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(fd, $0, &length) }
    }
    guard named == 0 else { return 0 }
    return UInt16(bigEndian: address.sin_port)
}
