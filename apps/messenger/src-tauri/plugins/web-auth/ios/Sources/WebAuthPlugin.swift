import AuthenticationServices
import Foundation
import Tauri
import UIKit

struct StartArgs: Decodable {
  let url: String
  let callbackScheme: String
}

struct StartResult: Encodable {
  let url: String?
  let cancelled: Bool
}

// 애플 표준 로그인 창. 시스템이 Safari 엔진으로 페이지를 띄우고, callbackScheme으로 시작하는 리디렉션이 오면
// 창을 닫고 그 URL을 완료 핸들러로 돌려준다 — 기본 브라우저(Chrome 등)를 거치지 않는다.
class WebAuthPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?

  @objc public func start(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StartArgs.self)
    guard let url = URL(string: args.url), url.scheme == "https" else {
      invoke.reject("invalid url")
      return
    }
    DispatchQueue.main.async {
      self.session?.cancel()
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: args.callbackScheme) { callback, _ in
        self.session = nil
        if let callback = callback {
          invoke.resolve(StartResult(url: callback.absoluteString, cancelled: false))
        } else {
          // 사용자 취소·시스템 오류 모두 '취소'로 — 앱은 대기 상태를 풀고 다시 시도하게 한다.
          invoke.resolve(StartResult(url: nil, cancelled: true))
        }
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = false
      self.session = session
      if !session.start() {
        self.session = nil
        invoke.reject("session start failed")
      }
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    return manager.viewController?.view.window ?? ASPresentationAnchor()
  }
}

@_cdecl("init_plugin_web_auth")
func initPlugin() -> Plugin {
  return WebAuthPlugin()
}
