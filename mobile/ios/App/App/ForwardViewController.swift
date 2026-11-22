import UIKit
import WebKit

/// The in-app view of a forwarded port (ForwardPlugin.show): a web view of its own over the whole screen, under a bar
/// with back, reload, the address (read-only) and close. Over the whole screen and not a sheet: the terminal below
/// is not half in sight, and nothing but the close button (or back, with no page to go back to) takes it away.
///
/// The web view has nothing of the app's: a configuration of its own with no message handlers and no scripts (the
/// pages it shows cannot reach the Capacitor bridge) and the plugin's own data store, not the app page's.
///
/// Links: http and https open here, also those meant for a new window; anything else (tel:, mailto:, an app's
/// scheme) is ignored. A certificate that cannot be verified is accepted for 127.0.0.1 only - that is the app's own
/// listener, and what answers there is the user's dev server on their computer, whose certificate is never one made
/// for this address; any other host is verified as usual.
final class ForwardViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    /// The user closed the view. Called once, on the main thread; not called when the plugin takes the view away.
    var onClose: (() -> Void)?

    private static let background = UIColor(red: 13 / 255, green: 16 / 255, blue: 21 / 255, alpha: 1)    // --bg
    private static let panel = UIColor(red: 19 / 255, green: 23 / 255, blue: 30 / 255, alpha: 1)         // --panel
    private static let line = UIColor(red: 35 / 255, green: 42 / 255, blue: 53 / 255, alpha: 1)          // --line
    private static let text = UIColor(red: 233 / 255, green: 237 / 255, blue: 243 / 255, alpha: 1)       // --text
    private static let muted = UIColor(red: 154 / 255, green: 165 / 255, blue: 181 / 255, alpha: 1)      // --muted
    private static let accent = UIColor(red: 122 / 255, green: 167 / 255, blue: 255 / 255, alpha: 1)     // --accent

    private let start: URL
    private let heading: String
    private let webView: WKWebView
    private let headingLabel = UILabel()
    private let addressLabel = UILabel()
    private let messageLabel = UILabel()
    private let progress = UIProgressView(progressViewStyle: .bar)
    private var observations: [NSKeyValueObservation] = []
    private var leaving = false

    init(url: URL, heading: String, store: WKWebsiteDataStore) {
        self.start = url
        self.heading = heading
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.allowsInlineMediaPlayback = true
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
        // Over the whole screen, with the app's page left in the window below: a page taken out of the window is a
        // hidden one, and the app's page - which carries the bytes of what is shown here - pauses when hidden.
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .lightContent
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The keyboard of the terminal below would stay up over this view.
        presentingViewController?.view.endEditing(true)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background

        let bar = UIView()
        bar.backgroundColor = Self.panel
        // The bar's colour up to the top of the screen, behind the notch and the clock.
        let top = UIView()
        top.backgroundColor = Self.panel
        let rule = UIView()
        rule.backgroundColor = Self.line

        headingLabel.text = heading
        headingLabel.textColor = Self.text
        headingLabel.font = UIFont.systemFont(ofSize: 14, weight: .semibold)
        headingLabel.lineBreakMode = .byTruncatingTail
        headingLabel.isHidden = heading.isEmpty
        addressLabel.text = start.absoluteString
        addressLabel.textColor = Self.muted
        addressLabel.font = UIFont.systemFont(ofSize: 12)
        addressLabel.lineBreakMode = .byTruncatingTail
        let labels = UIStackView(arrangedSubviews: [headingLabel, addressLabel])
        labels.axis = .vertical
        labels.spacing = 1
        for item in [headingLabel, addressLabel, labels] as [UIView] {
            item.setContentHuggingPriority(.defaultLow, for: .horizontal)
            item.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }

        let row = UIStackView(arrangedSubviews: [
            button("chevron.left", "Back", #selector(backTapped)),
            button("arrow.clockwise", "Reload", #selector(reloadTapped)),
            labels,
            button("xmark", "Close", #selector(closeTapped))
        ])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 4

        progress.trackTintColor = .clear
        progress.progressTintColor = Self.accent
        progress.isHidden = true

        messageLabel.textColor = Self.muted
        messageLabel.font = UIFont.systemFont(ofSize: 14)
        messageLabel.textAlignment = .center
        messageLabel.numberOfLines = 0
        messageLabel.isHidden = true

        // Nothing of the web view is seen until a page has come: the screen stays the app's dark one, not white.
        webView.isHidden = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        for item in [top, bar, webView, messageLabel, rule, progress] as [UIView] {
            item.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(item)
        }
        row.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(row)

        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: view.topAnchor),
            top.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            top.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            top.bottomAnchor.constraint(equalTo: bar.topAnchor),

            bar.topAnchor.constraint(equalTo: safe.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 48),

            row.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 4),
            row.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -4),
            row.topAnchor.constraint(equalTo: bar.topAnchor),
            row.bottomAnchor.constraint(equalTo: bar.bottomAnchor),

            rule.topAnchor.constraint(equalTo: bar.bottomAnchor),
            rule.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            rule.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            rule.heightAnchor.constraint(equalToConstant: 1),

            progress.topAnchor.constraint(equalTo: bar.bottomAnchor),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            // Beside the notch when the phone is on its side; down to the screen's end, as a page in Safari.
            webView.topAnchor.constraint(equalTo: rule.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            messageLabel.centerYAnchor.constraint(equalTo: safe.centerYAnchor),
            messageLabel.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 24),
            messageLabel.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -24)
        ])

        // The address follows the page, wherever a link or a redirect takes it.
        observations.append(webView.observe(\.url, options: [.new]) { [weak self] web, _ in
            guard let self = self else { return }
            self.addressLabel.text = (web.url ?? self.start).absoluteString
        })
        observations.append(webView.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            self?.progress.progress = Float(web.estimatedProgress)
        })
        observations.append(webView.observe(\.isLoading, options: [.new]) { [weak self] web, _ in
            self?.progress.isHidden = !web.isLoading
        })

        webView.load(URLRequest(url: start))
    }

    private func button(_ symbol: String, _ label: String, _ action: Selector) -> UIButton {
        let made = UIButton(type: .system)
        made.setImage(UIImage(systemName: symbol), for: .normal)
        made.tintColor = Self.text
        made.accessibilityLabel = label
        made.addTarget(self, action: action, for: .touchUpInside)
        made.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            made.widthAnchor.constraint(equalToConstant: 44),
            made.heightAnchor.constraint(equalToConstant: 44)
        ])
        return made
    }

    // Back in the page's history; with nowhere to go back to, out of the view.
    @objc private func backTapped() {
        if webView.canGoBack {
            webView.goBack()
        } else {
            closeTapped()
        }
    }

    @objc private func reloadTapped() {
        if webView.url == nil {
            // Nothing came the first time (the port did not answer): the address asked for, again.
            webView.load(URLRequest(url: start))
        } else {
            webView.reload()
        }
    }

    @objc private func closeTapped() {
        let closed = onClose
        leave(animated: true) { closed?() }
    }

    /// Takes the view off the screen, with everything it shows above itself. Without a word to `onClose`.
    func leave(animated: Bool, completion: (() -> Void)?) {
        if leaving {
            completion?()
            return
        }
        leaving = true
        onClose = nil
        webView.stopLoading()
        if let presenter = presentingViewController {
            presenter.dismiss(animated: animated, completion: completion)
        } else {
            completion?()
        }
    }

    private func say(_ error: Error) {
        let failure = error as NSError
        // A load given up for another one (a second tap, a redirect) is not a failure.
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        if failure.domain == "WebKitErrorDomain" && failure.code == 102 { return }
        messageLabel.text = failure.localizedDescription
        messageLabel.isHidden = false
        webView.isHidden = true
    }

    // ---- WKNavigationDelegate -----------------------------------------------------------------------------------

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""
        // A frame inside a page may also be filled by the page itself (about:blank, srcdoc, a blob).
        var inner = false
        if let frame = navigationAction.targetFrame, !frame.isMainFrame { inner = true }
        if scheme == "http" || scheme == "https" || (inner && (scheme == "about" || scheme == "blob" || scheme == "data")) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        messageLabel.isHidden = true
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        messageLabel.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        say(error)
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        if space.authenticationMethod == NSURLAuthenticationMethodServerTrust, space.host == "127.0.0.1", let trust = space.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS ended the page's process (memory): the page again, not an empty view.
        webView.reload()
    }

    // ---- WKUIDelegate -------------------------------------------------------------------------------------------

    // A link for a new window (target="_blank", window.open): there is one view, so it opens in it.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""
        if navigationAction.targetFrame == nil && (scheme == "http" || scheme == "https") {
            webView.load(navigationAction.request)
        }
        return nil
    }
}
