// macOS 데스크톱 알림 — UNUserNotificationCenter 직결(2026-09-18).
//
// tauri-plugin-notification 2.4.0(최신)의 데스크톱 경로는 notify-rust → mac-notification-sys로, 폐기된 NSUserNotificationCenter에
// 번들 식별자를 바꿔 끼워 보내고 결과를 버린다(`let _ = notification.show()`). 권한도 "늘 허용"으로 답해 OS에 한 번도 묻지 않는다.
// 유건 0.1.29 제보("가려도·최소화해도 알림이 안 온다")를 조사하니 이 맥의 알림 설정(com.apple.ncprefs)에 앱이 아예 없었다 —
// 알림이 OS에 한 번도 등록·전달되지 않았다는 뜻이다. 그래서 macOS만 UN 프레임워크로 권한을 묻고 보내며, 실패를 앱에 돌려준다.
// 윈도우·리눅스는 플러그인 그대로다(notify.js가 갈라 부른다).
//
// UNUserNotificationCenter는 .app 번들 안(번들 식별자가 있는 프로세스)에서만 동작한다 — `cargo run`처럼 번들 밖이면
// 호출 즉시 예외로 죽으므로, 번들이 아니면 "unsupported"를 돌려주고 JS가 플러그인으로 물러난다.
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, MainThreadOnly};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use serde::Serialize;
use std::ptr::NonNull;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTap {
    channel_id: String,
    message_id: String,
}

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static PENDING_TAP: Mutex<Option<NotificationTap>> = Mutex::new(None);

fn remember_tap(tap: NotificationTap) {
    if let Ok(mut pending) = PENDING_TAP.lock() {
        *pending = Some(tap);
    }
}

fn take_tap() -> Option<NotificationTap> {
    PENDING_TAP
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
}

fn in_app_bundle() -> bool {
    let b = NSBundle::mainBundle();
    b.bundleIdentifier().is_some() && b.bundlePath().to_string().ends_with(".app")
}

fn center() -> Option<Retained<UNUserNotificationCenter>> {
    if !in_app_bundle() {
        return None;
    }
    Some(UNUserNotificationCenter::currentNotificationCenter())
}

fn status_name(s: UNAuthorizationStatus) -> &'static str {
    // 앱 화면 어휘(notify.js notifyPermission과 같은 값) — provisional·ephemeral도 "보낼 수 있음"이라 granted로 본다
    if s == UNAuthorizationStatus::Denied {
        "denied"
    } else if s == UNAuthorizationStatus::NotDetermined {
        "default"
    } else {
        "granted"
    }
}

fn wait<T>(rx: mpsc::Receiver<T>, secs: u64) -> Result<T, String> {
    rx.recv_timeout(Duration::from_secs(secs))
        .map_err(|_| "notification center did not answer".to_string())
}

fn current_status(c: &UNUserNotificationCenter) -> Result<&'static str, String> {
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let s = unsafe { settings.as_ref() }.authorizationStatus();
        let _ = tx.send(status_name(s));
    });
    c.getNotificationSettingsWithCompletionHandler(&block);
    wait(rx, 20)
}

fn current_capability(c: &UNUserNotificationCenter) -> Result<String, String> {
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: Category 8 (FFI boundary). Apple's completion handler supplies a
        // live, non-null settings object for the duration of this callback.
        let settings = unsafe { settings.as_ref() };
        let value = format!(
            "{};alert={:?};sound={:?};badge={:?}",
            status_name(settings.authorizationStatus()),
            settings.alertSetting(),
            settings.soundSetting(),
            settings.badgeSetting(),
        );
        let _ = tx.send(value);
    });
    c.getNotificationSettingsWithCompletionHandler(&block);
    wait(rx, 20)
}

pub async fn notify_capability_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| match center() {
        None => Ok("unsupported".to_string()),
        Some(c) => current_capability(&c),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notify_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| match center() {
        None => Ok("unsupported".to_string()),
        Some(c) => current_status(&c).map(str::to_string),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notify_request() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(c) = center() else {
            return Ok("unsupported".to_string());
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |_granted: Bool, err: *mut NSError| {
            let msg = if err.is_null() {
                None
            } else {
                Some(unsafe { &*err }.localizedDescription().to_string())
            };
            let _ = tx.send(msg);
        });
        let opts = UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge;
        c.requestAuthorizationWithOptions_completionHandler(opts, &block);
        // 권한 창은 사용자가 응답할 때까지 완료가 오지 않는다 — 10분 기다린다(시간 초과여도 JS는 OS 상태를 다시 읽을 뿐, 허용으로 보지 않는다)
        if let Some(e) = wait(rx, 600)? {
            return Err(e);
        }
        current_status(&c).map(str::to_string) // 요청 뒤 실제 상태(허용·거부)를 다시 읽어 돌려준다
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notify_send(
    title: String,
    body: String,
    tag: String,
    sound: Option<String>,
    channel_id: Option<String>,
    message_id: Option<String>,
) -> Result<(), String> {
    notify_send_guarded(title, body, tag, sound, channel_id, message_id, || true).await
}

pub async fn notify_send_guarded<F>(
    title: String,
    body: String,
    tag: String,
    sound: Option<String>,
    channel_id: Option<String>,
    message_id: Option<String>,
    should_send: F,
) -> Result<(), String>
where
    F: Fn() -> bool + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let Some(c) = center() else {
            return Err("unsupported".to_string());
        };
        // 거부·미결정이면 보내지 않는다 — UN은 거부 상태에서도 addNotificationRequest를 오류 없이 받아 준다(검수용 번들 실측).
        // 그러면 "보냈다"로 보이는데 아무것도 안 뜬다. 상태를 먼저 보고 이유를 돌려준다(notify.js가 진단에 남긴다).
        match current_status(&c)? {
            "granted" => {}
            other => return Err(format!("not allowed: {other}")),
        }
        if !should_send() {
            return Err("stale notification generation".to_string());
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        if let (Some(channel_id), Some(message_id)) = (channel_id, message_id) {
            let channel_key = NSString::from_str("channelId");
            let message_key = NSString::from_str("messageId");
            let channel_value = NSString::from_str(&channel_id);
            let message_value = NSString::from_str(&message_id);
            let user_info = NSDictionary::from_slices(
                &[&*channel_key, &*message_key],
                &[&*channel_value, &*message_value],
            );
            // SAFETY: Category 8 (FFI boundary). Both dictionary keys and values are NSString,
            // and erasing the Objective-C generic markers does not change layout or ownership.
            let user_info = unsafe { user_info.cast_unchecked::<AnyObject, AnyObject>() };
            // SAFETY: Category 8 (FFI boundary). The retained NSDictionary outlives this
            // synchronous setter call, which copies the dictionary according to Apple's API.
            unsafe { content.setUserInfo(user_info) };
        }
        if let Some(name) = sound.filter(|name| {
            matches!(
                name.as_str(),
                "seatbelt-single"
                    | "seatbelt-hilo"
                    | "wood-knock"
                    | "wood-knock-double"
                    | "wood-marimba"
            )
        }) {
            // soundNamed looks only at the bundle Resources root (and Library/Sounds); a
            // subdirectory path silently falls back to the system default sound.
            // 2026-09-24 밤 재관찰(실제 설치본 0.1.37, 실 메시지 알림, log show 직결 확인):
            // systemsoundserverd가 AudioAnalytics 오류로 "file_type_hint: caff, 실제 헤더: FORM..AIFF"를 남기고
            // 기본(built-in) 소리로 떨어졌다 — 이 알림 파이프라인은 CAF 컨테이너만 재생하고 순수 AIFF는 디코드 실패로
            // 기본 소리로 폴백한다. 오전의 애드혹 서명 SoundLab 시험은 배너·소리 자체가 한 번도 present 되지 않은 채
            // (log show에 Presenting/Playing 이벤트 없음) "청취 확인"이 남아 신뢰할 수 없다 — CAF로 되돌린다.
            let resource = NSString::from_str(&format!("{name}.caf"));
            let notification_sound = UNNotificationSound::soundNamed(&resource);
            content.setSound(Some(&notification_sound));
        }
        let id = if tag.is_empty() {
            format!("argo-{}", std::process::id())
        } else {
            tag
        };
        let req = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None,
        );
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |err: *mut NSError| {
            let msg = if err.is_null() {
                None
            } else {
                Some(unsafe { &*err }.localizedDescription().to_string())
            };
            let _ = tx.send(msg);
        });
        c.addNotificationRequest_withCompletionHandler(&req, Some(&block));
        match wait(rx, 20)? {
            Some(e) => Err(e),
            None => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// 앱이 앞에 있을 때도 배너를 보인다 — UN은 기본으로 전면 앱의 알림을 숨긴다. 앱은 "보고 있지 않은 방"에만 보내므로(shouldNotify) 그대로 띄운다.
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ArgoNotifyDelegate"]
    struct NotifyDelegate;

    unsafe impl NSObjectProtocol for NotifyDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotifyDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _c: &UNUserNotificationCenter,
            _n: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _c: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let user_info = response.notification().request().content().userInfo();
            // SAFETY: Category 8 (FFI boundary). Argo creates these local notifications with an
            // NSDictionary<NSString, NSString>; missing or foreign notification keys return None.
            let typed = unsafe { user_info.cast_unchecked::<NSString, NSString>() };
            let channel_key = NSString::from_str("channelId");
            let message_key = NSString::from_str("messageId");
            let tap = typed
                .objectForKey(&channel_key)
                .zip(typed.objectForKey(&message_key))
                .map(|(channel_id, message_id)| NotificationTap {
                    channel_id: channel_id.to_string(),
                    message_id: message_id.to_string(),
                });
            if let Some(tap) = tap {
                remember_tap(tap.clone());
                if let Some(app) = APP_HANDLE.get() {
                    // ⌘M 최소화·닫기(=가리기)여도 방이 보이게 창을 되살린다 — OS 활성화만으로는 최소화가 풀리지 않는다.
                    if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("native-notification-tap", tap);
                }
            }
            handler.call(());
        }
    }
);

/// setup에서 한 번 — 대리자는 center가 약하게 붙잡으므로 앱 수명 동안 놓지 않는다(leak).
pub fn install_delegate(mtm: objc2::MainThreadMarker, app: AppHandle) {
    let _ = APP_HANDLE.set(app);
    let Some(c) = center() else { return };
    let d: Retained<NotifyDelegate> = unsafe { msg_send![NotifyDelegate::alloc(mtm), init] };
    c.setDelegate(Some(ProtocolObject::from_ref(&*d)));
    std::mem::forget(d);
}

#[tauri::command]
pub fn native_notification_pending_tap() -> Option<NotificationTap> {
    take_tap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_notification_tap_is_consumed_once() {
        let tap = NotificationTap {
            channel_id: "channel".to_string(),
            message_id: "message:42".to_string(),
        };
        remember_tap(tap.clone());
        assert_eq!(take_tap(), Some(tap));
        assert_eq!(take_tap(), None);
    }
}
