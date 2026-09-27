// Copyright 2021-2025 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0

use objc2::{define_class, rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{
  NSBundle, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSSet, NSString,
  NSUserActivity,
};
use objc2_ui_kit::{
  UIApplication, UIOpenURLContext, UIScene, UISceneConnectionOptions, UISceneDelegate,
  UISceneSession, UIWindowScene,
};

use crate::{
  event::{Event, WindowEvent},
  platform_impl::platform::{app_state, event_loop::EventWrapper},
  window::WindowId as RootWindowId,
};

// true when the system allows the app to display multiple scenes and multiple_scenes_enabled() returns true
// https://developer.apple.com/documentation/uikit/uiapplication/supportsmultiplescenes?language=objc
pub unsafe fn app_supports_multiple_scenes() -> bool {
  let mtm = MainThreadMarker::new().unwrap();
  let application = UIApplication::sharedApplication(mtm);
  application.supportsMultipleScenes()
}

// check whether the app's Info.plist enabled multiple scenes
pub unsafe fn multiple_scenes_enabled() -> bool {
  let bundle = NSBundle::mainBundle();
  let Some(info) = bundle.infoDictionary() else {
    return false;
  };

  let key = NSString::from_str("UIApplicationSceneManifest");
  let Some(manifest) = (*info).objectForKey(&key) else {
    return false;
  };

  let manifest_dict = Retained::cast_unchecked::<NSDictionary<NSString, NSObject>>(manifest);
  let supports_key = NSString::from_str("UIApplicationSupportsMultipleScenes");
  let Some(value) = (*manifest_dict).objectForKey(&supports_key) else {
    return false;
  };

  let num = Retained::cast_unchecked::<NSNumber>(value);
  (*num).as_bool()
}

define_class!(
  #[unsafe(super(NSObject))]
  #[name = "TaoSceneDelegate"]
  #[thread_kind = MainThreadOnly]
  pub struct TaoSceneDelegate;

  unsafe impl NSObjectProtocol for TaoSceneDelegate {}

  #[allow(non_snake_case)]
  unsafe impl UISceneDelegate for TaoSceneDelegate {
    #[unsafe(method(scene:willConnectToSession:options:))]
    fn scene_willConnectToSession_options(
      &self,
      scene: &UIScene,
      session: &UISceneSession,
      connection_options: &UISceneConnectionOptions,
    ) {
      unsafe {
        // 아이패드 다중 창(Dock 길게 누르기 "새로운 윈도우"·앱 전환기 '+') 차단(유건 지시 2026-09-26) — 두 번째 씬이
        // 붙으려는 순간 즉시 파기 요청한다. UIApplicationSupportsMultipleScenes 자체는 true로 남긴다: tao는 이 값이
        // true여야 TaoSceneDelegate로 붙고, false면 iOS 27에서 실행 즉시 종료한다(실사고 0.1.27, project.yml 주석).
        // 로그인 세션·Supabase 실시간 구독·작성 중 초안이 전역(모듈 싱글턴) 상태라 두 창이 동시에 살면 서로 덮어써
        // 꼬인다 — 여러 창을 "안전하게" 만드는 대신 애초에 한 창만 허용한다. Split View·Slide Over는 다른 앱과 화면을
        // 나누는 것이라 이 앱의 씬은 여전히 하나이므로 영향 없다.
        let mtm = MainThreadMarker::new().unwrap();
        let application = UIApplication::sharedApplication(mtm);
        if application.connectedScenes().count() > 1 {
          application.requestSceneSessionDestruction_options_errorHandler(session, None, None);
          return;
        }
        app_state::connect_scene(scene, connection_options);
      }
    }

    #[unsafe(method(sceneDidDisconnect:))]
    fn sceneDidDisconnect(&self, _scene: &UIScene) {}

    #[unsafe(method(sceneDidBecomeActive:))]
    fn sceneDidBecomeActive(&self, scene: &UIScene) {
      unsafe {
        if let Some(window_scene) = scene.downcast_ref::<UIWindowScene>() {
          for window in window_scene.windows() {
            app_state::handle_nonuser_event(EventWrapper::StaticEvent(Event::WindowEvent {
              window_id: RootWindowId(window.into()),
              event: WindowEvent::Focused(true),
            }));
          }
        }
      }
    }

    #[unsafe(method(sceneWillResignActive:))]
    fn sceneWillResignActive(&self, scene: &UIScene) {
      unsafe {
        if let Some(window_scene) = scene.downcast_ref::<UIWindowScene>() {
          for window in window_scene.windows() {
            app_state::handle_nonuser_event(EventWrapper::StaticEvent(Event::WindowEvent {
              window_id: RootWindowId(window.into()),
              event: WindowEvent::Focused(false),
            }));
          }
        }
      }
    }

    #[unsafe(method(sceneWillEnterForeground:))]
    fn sceneWillEnterForeground(&self, _scene: &UIScene) {}

    #[unsafe(method(sceneDidEnterBackground:))]
    fn sceneDidEnterBackground(&self, _scene: &UIScene) {}

    #[unsafe(method(scene:openURLContexts:))]
    fn scene_openURLContexts(&self, _scene: &UIScene, url_contexts: &NSSet<UIOpenURLContext>) {
      unsafe {
        let urls: Vec<url::Url> = url_contexts
          .iter()
          .filter_map(|ctx| {
            ctx.URL().absoluteString().and_then(|url| {
              let url = url.to_string();
              url
                .parse()
                .map_err(|e| {
                  log::error!("failed to parse URL {url} from scene:openURLContexts: {e}");
                  e
                })
                .ok()
            })
          })
          .collect();
        if !urls.is_empty() {
          app_state::handle_nonuser_event(EventWrapper::StaticEvent(Event::Opened { urls }));
        }
      }
    }

    #[unsafe(method(stateRestorationActivityForScene:))]
    fn stateRestorationActivityForScene(
      &self,
      _scene: &UIScene,
    ) -> Option<std::ptr::NonNull<NSUserActivity>> {
      None
    }

    #[unsafe(method(scene:restoreInteractionStateWithUserActivity:))]
    fn scene_restoreInteractionStateWithUserActivity(
      &self,
      _scene: &UIScene,
      _state_restoration_activity: &NSUserActivity,
    ) {
    }

    #[unsafe(method(scene:willContinueUserActivityWithType:))]
    fn scene_willContinueUserActivityWithType(
      &self,
      _scene: &UIScene,
      _user_activity_type: &NSString,
    ) {
    }

    #[unsafe(method(scene:continueUserActivity:))]
    fn scene_continueUserActivity(&self, _scene: &UIScene, user_activity: &NSUserActivity) {
      unsafe {
        // universal app links
        if let Some(url) = user_activity
          .webpageURL()
          .and_then(|url| url.absoluteString())
        {
          let url = url.to_string().parse::<url::Url>().unwrap();
          app_state::handle_nonuser_event(EventWrapper::StaticEvent(Event::Opened {
            urls: vec![url],
          }));
        }
      }
    }

    #[unsafe(method(scene:didFailToContinueUserActivityWithType:error:))]
    fn scene_didFailToContinueUserActivityWithType_error(
      &self,
      _scene: &UIScene,
      _user_activity_type: &NSString,
      _error: &NSError,
    ) {
    }

    #[unsafe(method(scene:didUpdateUserActivity:))]
    fn scene_didUpdateUserActivity(&self, _scene: &UIScene, _user_activity: &NSUserActivity) {}
  }
);
