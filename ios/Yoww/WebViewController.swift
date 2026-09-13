import UIKit
import WebKit

/// Yoww 的 iOS 壳。跟安卓那个是同一套思路：只负责把网站装起来，
/// 界面和逻辑全在网页里，所以网站更新了这个壳不用重新打包。
///
/// 这个包是不签名发出去的，用户自己签。
final class WebViewController: UIViewController {

  /// 按顺序试。第一个打不开就换下一个 —— 自有域名万一被墙或者解析出问题，
  /// 还有 workers.dev 那个兜底，不至于整个应用打不开。
  private let sites = [
    URL(string: "https://yoww2026.cn/")!,
    URL(string: "https://emoji.yu7705423.workers.dev/")!,
  ]
  private var siteIndex = 0
  private var pageOk = false
  private var watchdog: DispatchWorkItem?
  private let loadTimeout: TimeInterval = 12

  private var webView: WKWebView!
  private var statusBarStyle: UIStatusBarStyle = .darkContent
  override var preferredStatusBarStyle: UIStatusBarStyle { statusBarStyle }

  /// 一次可能同时下好几个，得按 download 对象分别记住各自的落地路径
  fileprivate var downloadDestinations: [ObjectIdentifier: URL] = [:]

  override func viewDidLoad() {
    super.viewDidLoad()

    let cfg = WKWebViewConfiguration()
    cfg.allowsInlineMediaPlayback = true              // 铃声试听要在页内放，不能全屏接管
    cfg.mediaTypesRequiringUserActionForPlayback = []
    cfg.websiteDataStore = .default()                 // 登录状态要能留住

    webView = WKWebView(frame: .zero, configuration: cfg)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.allowsLinkPreview = false                 // 长按图片走网页自己那套，别弹系统预览
    webView.scrollView.contentInsetAdjustmentBehavior = .never   // 页面用 env(safe-area-inset-*) 自己排版
    webView.scrollView.bounces = false
    webView.isOpaque = false
    webView.backgroundColor = .white
    view.backgroundColor = .white

    webView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])

    loadCurrentSite()
  }

  private func loadCurrentSite() {
    pageOk = false
    webView.load(URLRequest(url: sites[siteIndex]))
    armWatchdog()
  }

  /// 手机上"一直转圈"比"报个错"更让人困惑。超时就自己换下一个地址。
  private func armWatchdog() {
    watchdog?.cancel()
    let w = DispatchWorkItem { [weak self] in
      guard let self, !self.pageOk else { return }
      self.nextSiteOrGiveUp()
    }
    watchdog = w
    DispatchQueue.main.asyncAfter(deadline: .now() + loadTimeout, execute: w)
  }

  private func nextSiteOrGiveUp() {
    watchdog?.cancel()
    if siteIndex + 1 < sites.count {
      siteIndex += 1
      loadCurrentSite()
      return
    }
    let a = UIAlertController(title: "打不开",
                              message: "网络好像有问题，或者网站暂时访问不了。",
                              preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "重试", style: .default) { [weak self] _ in
      self?.siteIndex = 0
      self?.loadCurrentSite()
    })
    present(a, animated: true)
  }

  private func isOurHost(_ host: String?) -> Bool {
    guard let host = host?.lowercased() else { return false }
    for site in sites {
      guard let h = site.host?.lowercased() else { continue }
      if host == h || host == "www." + h { return true }
    }
    // 图片放在自己的 R2 上，也算自己人
    return host.hasSuffix(".yoww2026.cn")
  }

  /// 页面底色是用户能改的（外观设置里可以调成深色）。状态栏文字颜色写死的话，
  /// 深色主题下会变成黑字压在深色上，读不出来。所以载入完问一次页面的实际底色。
  private func syncStatusBar() {
    webView.evaluateJavaScript("getComputedStyle(document.body).backgroundColor") { [weak self] v, _ in
      guard let self, let s = v as? String else { return }
      let nums = s.components(separatedBy: CharacterSet(charactersIn: "rgba(), "))
                  .compactMap { Double($0) }
      guard nums.count >= 3 else { return }
      // 感知亮度，不是简单平均：人眼对绿色最敏感，对蓝色最不敏感
      let lum = (0.299 * nums[0] + 0.587 * nums[1] + 0.114 * nums[2]) / 255
      let style: UIStatusBarStyle = lum > 0.5 ? .darkContent : .lightContent
      if style != self.statusBarStyle {
        self.statusBarStyle = style
        self.setNeedsStatusBarAppearanceUpdate()
      }
      self.view.backgroundColor = UIColor(red: nums[0]/255, green: nums[1]/255, blue: nums[2]/255, alpha: 1)
    }
  }
}

extension WebViewController: WKNavigationDelegate {

  func webView(_ webView: WKWebView,
               decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.allow) }

    // 「下载全部」是先在浏览器里打好 zip，再造一个 <a download> 指向 blob: 点一下。
    // 这种意图在这一步就有标记，接住它才能走到下载流程 —— 只在 navigationResponse
    // 里等的话，blob: 压根到不了那儿，表现就是点了保存什么都没发生。
    if action.shouldPerformDownload {
      return decisionHandler(.download)
    }

    // 页面里贴的外链（原作者主页之类）在应用内打开会把人困住，退不回来。丢给 Safari。
    if action.navigationType == .linkActivated,
       let scheme = url.scheme?.lowercased(),
       scheme == "http" || scheme == "https",
       !isOurHost(url.host) {
      UIApplication.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView,
               decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    // 网页里"下载全部"是先在浏览器里打好 zip，再用 blob: 链接触发下载。
    // 不接这一步的话，点了什么都不会发生 —— WKWebView 默认把无法显示的响应直接丢掉。
    if !response.canShowMIMEType {
      decisionHandler(.download)
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pageOk = true
    watchdog?.cancel()
    syncStatusBar()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if !pageOk { nextSiteOrGiveUp() }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if !pageOk { nextSiteOrGiveUp() }
  }

  func webView(_ webView: WKWebView,
               navigationAction: WKNavigationAction,
               didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView,
               navigationResponse: WKNavigationResponse,
               didBecome download: WKDownload) {
    download.delegate = self
  }
}

extension WebViewController: WKUIDelegate {
  /// target="_blank" 的链接在 WKWebView 里默认什么都不做。分享面板里那些链接就是这种。
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url, action.targetFrame == nil {
      if isOurHost(url.host) { webView.load(action.request) }
      else { UIApplication.shared.open(url) }
    }
    return nil
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
    present(a, animated: true)
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
    a.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler(true) })
    present(a, animated: true)
  }
}

extension WebViewController: WKDownloadDelegate {

  func download(_ download: WKDownload,
                decideDestinationUsing response: URLResponse,
                suggestedFilename: String,
                completionHandler: @escaping (URL?) -> Void) {
    // 下到临时目录，下完再弹系统分享面板让用户决定存哪儿（存到"文件"、发微信都行）。
    // 直接往相册写需要额外权限，而且 zip 本来也进不了相册。
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("downloads", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var dest = dir.appendingPathComponent(suggestedFilename.isEmpty ? "Yoww" : suggestedFilename)
    // 同名文件已经在了就加一个后缀：URL 那套 API 碰到已存在的目标会直接失败
    var n = 1
    while FileManager.default.fileExists(atPath: dest.path) {
      let base = dest.deletingPathExtension().lastPathComponent
      let ext = dest.pathExtension
      let name = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
      dest = dir.appendingPathComponent(name)
      n += 1
    }
    completionHandler(dest)
    downloadDestinations[ObjectIdentifier(download)] = dest
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let url = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
    let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    // iPad 上不给锚点会直接崩
    share.popoverPresentationController?.sourceView = view
    share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY,
                                                             width: 0, height: 0)
    present(share, animated: true)
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
    let a = UIAlertController(title: "下载失败", message: error.localizedDescription, preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "好", style: .default))
    present(a, animated: true)
  }
}
