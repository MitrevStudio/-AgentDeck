import Capacitor
import Foundation
import QuickLook
import UIKit
import UniformTypeIdentifiers

/// Files downloaded from a computer (docs/FILES.md 5.1; the same contract as android/.../FilesPlugin.java): the page
/// receives a file a piece at a time and hands each piece here, so 50 MB never sit in the page's memory.
///
/// begin({ name, size, keep }) -> { file }, write({ file, data }), finish({ file }) -> { shown }, open({ file, type }),
/// cancel({ file }).
///
/// Every file is written to the app's temporary folder (tmp/agentdeck-files/<file>/<name>) through a FileHandle that
/// stays open between the writes. keep: true -> finish() shows the system's export sheet (UIDocumentPickerViewController
/// forExporting, "Save to Files"): it answers when the user has chosen a place, with the name the file got there (the
/// Files app may make it "name 2"), and the temporary copy is removed; a user who closes the sheet gets the rejection
/// "cancelled", and the file stays ready for another finish() or a cancel(). The export sheet, not the share sheet:
/// it says where the file went and under which name, it needs no anchor on an iPad, and "Save to Files" is the one
/// thing the share sheet would be used for here.
/// keep: false -> open() shows the finished file in QuickLook. QuickLook goes by the file's extension; a name without
/// one gets the extension of `type`.
///
/// All file work is on one serial queue, in the order the calls came; the sheets are the main thread's. A plugin that
/// goes away closes its handles and removes its unfinished files; the folder of an earlier run is removed on load.
///
/// Rejection codes: invalidData, unknownFile, sizeMismatch, finished, notFinished, busy, cancelled, noViewer,
/// diskFull, createFailed, writeFailed, finishFailed, shutDown.
@objc(FilesPlugin)
public class FilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FilesPlugin"
    public let jsName = "Files"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private static let maxWrite = 256 * 1024   // the bytes of one write()
    private static let maxName = 80            // a longer name is shortened, its extension kept

    private final class Entry {
        let id: String
        let keep: Bool
        let size: Int              // what begin() said; -1 when it said nothing
        var url: URL
        var handle: FileHandle?    // open until finish()
        var written = 0
        var finished = false
        var saving = false         // the export sheet is up for it
        init(id: String, keep: Bool, size: Int, url: URL, handle: FileHandle) {
            self.id = id
            self.keep = keep
            self.size = size
            self.url = url
            self.handle = handle
        }
    }

    // One queue for every instance: the ids below are unique for the app's run.
    private static let work = DispatchQueue(label: "agentdeck.files")
    private static var serial = 0                  // only on `work`
    private var entries: [String: Entry] = [:]     // only on `work`
    // Only on the main thread: the sheets' delegates (UIKit holds them weakly).
    private var exports: [String: FilesExport] = [:]
    private var previews: [FilesPreview] = []

    private static var root: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("agentdeck-files", isDirectory: true)
    }

    override public func load() {
        // A file of an earlier run is nobody's any more ("file" ids are for one run).
        let old = FilesPlugin.root
        FilesPlugin.work.async { try? FileManager.default.removeItem(at: old) }
    }

    deinit {
        // No queued work is left (it holds the plugin strongly), so the state is touched directly.
        for e in entries.values {
            try? e.handle?.close()
            if !e.finished { try? FileManager.default.removeItem(at: e.url.deletingLastPathComponent()) }
        }
    }

    // ---- the calls ----------------------------------------------------------------------------------------------

    @objc func begin(_ call: CAPPluginCall) {
        guard let name = FilesPlugin.clean(call.getString("name")) else {
            call.reject("no file name", "invalidData")
            return
        }
        let keep = call.getBool("keep") ?? false
        let size: Int
        if let n = call.getInt("size"), n >= 0 {
            size = n
        } else if let d = call.getDouble("size"), d >= 0, d < 9e15 {
            size = Int(d)
        } else {
            size = -1
        }
        FilesPlugin.work.async {
            FilesPlugin.serial += 1
            let id = "f\(FilesPlugin.serial)"
            let dir = FilesPlugin.root.appendingPathComponent(id, isDirectory: true)
            let url = dir.appendingPathComponent(name, isDirectory: false)
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
                    throw FilesFailure(text: "the file could not be made")
                }
                let handle = try FileHandle(forWritingTo: url)
                self.entries[id] = Entry(id: id, keep: keep, size: size, url: url, handle: handle)
                call.resolve(["file": id])
            } catch {
                try? FileManager.default.removeItem(at: dir)
                call.reject("could not create the file: \(FilesPlugin.text(error))", FilesPlugin.code(error, "createFailed"))
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let id = call.getString("file"), let text = call.getString("data") else {
            call.reject("no file or data", "invalidData")
            return
        }
        // base64 of 256 KB, with room for line breaks: anything longer cannot be one piece.
        guard text.utf8.count <= (FilesPlugin.maxWrite / 3 + 1) * 4 + 4096 else {
            call.reject("more than 256 KB in one write", "invalidData")
            return
        }
        FilesPlugin.work.async {
            guard let e = self.entries[id] else {
                call.reject("unknown file", "unknownFile")
                return
            }
            guard !e.finished, let handle = e.handle else {
                call.reject("the file is finished", "finished")
                return
            }
            guard let data = Data(base64Encoded: text, options: .ignoreUnknownCharacters) else {
                call.reject("data is not base64", "invalidData")
                return
            }
            guard data.count <= FilesPlugin.maxWrite else {
                call.reject("more than 256 KB in one write", "invalidData")
                return
            }
            if e.size >= 0 && e.written + data.count > e.size {
                call.reject("more bytes than the size given (\(e.size))", "sizeMismatch")
                return
            }
            do {
                // The throwing API: the old write(_:) raises an Objective-C exception (the app dies) on a full disk.
                try handle.write(contentsOf: data)
            } catch {
                call.reject("could not write: \(FilesPlugin.text(error))", FilesPlugin.code(error, "writeFailed"))
                return
            }
            e.written += data.count
            call.resolve()
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let id = call.getString("file") else {
            call.reject("no file", "invalidData")
            return
        }
        FilesPlugin.work.async {
            guard let e = self.entries[id] else {
                call.reject("unknown file", "unknownFile")
                return
            }
            if e.saving {
                call.reject("the file is being saved", "busy")
                return
            }
            if !e.finished {
                guard let handle = e.handle else {
                    call.reject("the file failed; cancel it", "finishFailed")
                    return
                }
                if e.size >= 0 && e.written != e.size {
                    call.reject("\(e.written) bytes of \(e.size) were written", "sizeMismatch")
                    return
                }
                e.handle = nil
                do {
                    try handle.close()
                } catch {
                    // Left unfinished: the page cancels it, which removes it.
                    call.reject("could not finish the file: \(FilesPlugin.text(error))", FilesPlugin.code(error, "finishFailed"))
                    return
                }
                e.finished = true
            }
            if !e.keep {
                call.resolve(["shown": e.url.lastPathComponent])
                return
            }
            e.saving = true
            let url = e.url
            DispatchQueue.main.async { self.export(url, id: id, call: call) }
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let id = call.getString("file") else {
            call.reject("no file", "invalidData")
            return
        }
        let type = call.getString("type") ?? ""
        FilesPlugin.work.async {
            guard let e = self.entries[id] else {
                call.reject("unknown file", "unknownFile")
                return
            }
            guard !e.keep, e.finished else {
                call.reject("only a finished temporary file can be opened", "notFinished")
                return
            }
            // QuickLook knows a file by its extension.
            if e.url.pathExtension.isEmpty, !type.isEmpty, let ext = UTType(mimeType: type)?.preferredFilenameExtension {
                let named = e.url.appendingPathExtension(ext)
                if (try? FileManager.default.moveItem(at: e.url, to: named)) != nil { e.url = named }
            }
            let url = e.url
            DispatchQueue.main.async { self.preview(url, call: call) }
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("file") else {
            call.reject("no file", "invalidData")
            return
        }
        FilesPlugin.work.async {
            // Already gone is what was asked for.
            guard let e = self.entries[id] else {
                call.resolve()
                return
            }
            if e.saving {
                call.reject("the file is being saved", "busy")
                return
            }
            self.entries.removeValue(forKey: id)
            try? e.handle?.close()
            e.handle = nil
            try? FileManager.default.removeItem(at: e.url.deletingLastPathComponent())
            call.resolve()
        }
    }

    // ---- the sheets (main thread) -------------------------------------------------------------------------------

    private static func top(_ root: UIViewController) -> UIViewController {
        // Over whatever is on top (a sheet of the system's, the forwarded page's view), so that it is seen.
        var top = root
        while let above = top.presentedViewController, !above.isBeingDismissed { top = above }
        return top
    }

    private func export(_ url: URL, id: String, call: CAPPluginCall) {
        guard let root = bridge?.viewController else {
            FilesPlugin.work.async {
                self.entries[id]?.saving = false
                call.reject("the app is closing", "shutDown")
            }
            return
        }
        // asCopy: the sheet copies the file to where the user chose; ours is removed afterwards.
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        let delegate = FilesExport { [weak self] saved in
            guard let self = self else { return }
            self.exports.removeValue(forKey: id)
            FilesPlugin.work.async {
                guard let e = self.entries[id] else {
                    call.reject("unknown file", "unknownFile")
                    return
                }
                e.saving = false
                if let saved = saved {
                    self.entries.removeValue(forKey: id)
                    try? FileManager.default.removeItem(at: e.url.deletingLastPathComponent())
                    call.resolve(["shown": saved.lastPathComponent])
                } else {
                    call.reject("the file was not saved", "cancelled")
                }
            }
        }
        exports[id] = delegate
        picker.delegate = delegate
        // Only its own buttons close it; should a swipe still do, the presentation's delegate answers the call.
        picker.isModalInPresentation = true
        picker.presentationController?.delegate = delegate
        FilesPlugin.top(root).present(picker, animated: true, completion: nil)
    }

    private func preview(_ url: URL, call: CAPPluginCall) {
        let item = url as NSURL
        guard QLPreviewController.canPreview(item) else {
            call.reject("this phone cannot show this file", "noViewer")
            return
        }
        guard let root = bridge?.viewController else {
            call.reject("the app is closing", "shutDown")
            return
        }
        let source = FilesPreview(url: url)
        source.onDismiss = { [weak self, weak source] in
            guard let self = self, let source = source else { return }
            self.previews.removeAll { $0 === source }
        }
        previews.append(source)
        let viewer = QLPreviewController()
        viewer.dataSource = source
        viewer.delegate = source
        FilesPlugin.top(root).present(viewer, animated: true, completion: nil)
        call.resolve()
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    /// The name comes from another computer: no folder separators, no control characters, never "." or "..", not
    /// too long (its extension kept). nil when there is no name at all.
    private static func clean(_ raw: String?) -> String? {
        guard let raw = raw else { return nil }
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        let underscore: Unicode.Scalar = "_"
        var out = ""
        for scalar in raw.unicodeScalars { out.unicodeScalars.append(bad.contains(scalar) ? underscore : scalar) }
        out = out.trimmingCharacters(in: .whitespacesAndNewlines)
        if out.isEmpty { return nil }
        if out.allSatisfy({ $0 == "." }) { return "download" }
        if out.count > maxName {
            let ext = (out as NSString).pathExtension
            if !ext.isEmpty && ext.count <= 16 {
                let base = String((out as NSString).deletingPathExtension.prefix(maxName - ext.count - 1))
                out = base.trimmingCharacters(in: .whitespaces) + "." + ext
            } else {
                out = String(out.prefix(maxName))
            }
        }
        return out
    }

    private static func code(_ error: Error, _ fallback: String) -> String {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain && ns.code == CocoaError.Code.fileWriteOutOfSpace.rawValue { return "diskFull" }
        if ns.domain == NSPOSIXErrorDomain && ns.code == Int(ENOSPC) { return "diskFull" }
        if let under = ns.userInfo[NSUnderlyingErrorKey] as? NSError, under.domain == NSPOSIXErrorDomain, under.code == Int(ENOSPC) {
            return "diskFull"
        }
        return fallback
    }

    private static func text(_ error: Error) -> String {
        let text = error.localizedDescription
        return text.isEmpty ? "error" : text
    }
}

private struct FilesFailure: LocalizedError {
    let text: String
    var errorDescription: String? { text }
}

/// The export sheet's delegate: says once where the file went (nil: it went nowhere).
private final class FilesExport: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private var done: ((URL?) -> Void)?

    init(done: @escaping (URL?) -> Void) {
        self.done = done
    }

    private func end(_ saved: URL?) {
        guard let done = done else { return }
        self.done = nil
        done(saved)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        end(urls.first)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        end(nil)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        end(nil)
    }
}

/// QuickLook's source of the one file it shows.
private final class FilesPreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    let url: URL
    var onDismiss: (() -> Void)?

    init(url: URL) {
        self.url = url
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        1
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        url as NSURL
    }

    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        onDismiss?()
    }
}
