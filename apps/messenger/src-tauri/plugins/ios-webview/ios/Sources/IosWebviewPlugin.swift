import ObjectiveC
import Tauri
import UIKit
import WebKit

struct BackgroundArgs: Decodable {
  let red: Int
  let green: Int
  let blue: Int
}

// iOS 웹뷰 다듬기(유건 실기기 제보 2026-10-03: 대화방 입력창을 누르면 키보드 위에 ↑↓✓ 막대가 뜨고, 입력창과 막대 사이가 검게 비쳤다).
// 1) 폼 보조 막대: WKWebView는 입력칸에 초점이 가면 WKContentView.inputAccessoryView로 웹 폼용 막대(이전·다음·완료)를 키보드 위에 붙인다.
//    메신저 앱에는 필요 없는 막대라 그 getter가 nil을 돌려주게 바꾼다(Capacitor Keyboard 플러그인의 setAccessoryBarVisible(false)와 같은 방식).
// 2) 네이티브 바탕: 창 설정(tauri.ios.conf.json backgroundColor)이 첫 페인트 전 스플래시 색(#1F1E1B)으로 웹뷰·부모 뷰를 칠한다.
//    Tauri의 웹뷰 바탕 명령은 데스크톱 전용이라 iOS에서는 테마 색으로 되돌릴 길이 없었다 — 키보드 위 막대 주변·키보드 둥근 모서리 뒤로
//    그 어두운 색이 드러났다. setBackground가 웹뷰·스크롤 뷰·페이지 밖 영역·부모 뷰·창을 같은 테마 색으로 칠한다.
class IosWebviewPlugin: Plugin {
  private weak var webview: WKWebView?
  private static var accessoryBarHidden = false

  @objc public override func load(webview: WKWebView) {
    self.webview = webview
    Self.hideFormAccessoryBar()
  }

  @objc public func setBackground(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BackgroundArgs.self)
    let color = UIColor(
      red: CGFloat(args.red) / 255, green: CGFloat(args.green) / 255, blue: CGFloat(args.blue) / 255, alpha: 1)
    DispatchQueue.main.async {
      guard let webview = self.webview else {
        invoke.reject("webview not loaded")
        return
      }
      webview.backgroundColor = color
      webview.scrollView.backgroundColor = color
      if #available(iOS 15.0, *) {
        webview.underPageBackgroundColor = color
      }
      webview.superview?.backgroundColor = color
      webview.window?.backgroundColor = color
      invoke.resolve()
    }
  }

  // 클래스 이름은 조각으로 이어 붙인다(비공개 클래스 이름 문자열을 그대로 두지 않는 Capacitor·Cordova 관례).
  // WKContentView가 inputAccessoryView를 직접 구현하지 않는 판이면 class_addMethod가 그 클래스에만 덮어쓰기를 더한다 —
  // 상위(UIResponder) 구현을 바꿔 앱 전체 응답자에 번지지 않게 한다.
  private static func hideFormAccessoryBar() {
    guard !accessoryBarHidden, let cls = NSClassFromString(["WK", "Content", "View"].joined()) else { return }
    let selector = #selector(getter: UIResponder.inputAccessoryView)
    guard let method = class_getInstanceMethod(cls, selector) else { return }
    let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
    let imp = imp_implementationWithBlock(block)
    if !class_addMethod(cls, selector, imp, method_getTypeEncoding(method)) {
      method_setImplementation(method, imp)
    }
    accessoryBarHidden = true
  }
}

@_cdecl("init_plugin_ios_webview")
func initPlugin() -> Plugin {
  return IosWebviewPlugin()
}
