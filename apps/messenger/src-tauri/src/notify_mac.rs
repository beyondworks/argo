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
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, MainThreadOnly};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationSettings, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

fn in_app_bundle() -> bool {
    let b = NSBundle::mainBundle();
    b.bundleIdentifier().is_some() && b.bundlePath().to_string().ends_with(".app")
}

fn center() -> Option<Retained<UNUserNotificationCenter>> {
    if !in_app_bundle() { return None; }
    Some(UNUserNotificationCenter::currentNotificationCenter())
}

fn status_name(s: UNAuthorizationStatus) -> &'static str {
    // 앱 화면 어휘(notify.js notifyPermission과 같은 값) — provisional·ephemeral도 "보낼 수 있음"이라 granted로 본다
    if s == UNAuthorizationStatus::Denied { "denied" }
    else if s == UNAuthorizationStatus::NotDetermined { "default" }
    else { "granted" }
}

fn wait<T>(rx: mpsc::Receiver<T>) -> Result<T, String> {
    rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "notification center did not answer".to_string())
}

fn current_status(c: &UNUserNotificationCenter) -> Result<&'static str, String> {
    let (tx, rx) = mpsc::channel();
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let s = unsafe { settings.as_ref() }.authorizationStatus();
        let _ = tx.send(status_name(s));
    });
    c.getNotificationSettingsWithCompletionHandler(&block);
    wait(rx)
}

#[tauri::command]
pub async fn notify_status() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| match center() {
        None => Ok("unsupported".to_string()),
        Some(c) => current_status(&c).map(str::to_string),
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notify_request() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(c) = center() else { return Ok("unsupported".to_string()) };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |_granted: Bool, err: *mut NSError| {
            let msg = if err.is_null() { None } else { Some(unsafe { &*err }.localizedDescription().to_string()) };
            let _ = tx.send(msg);
        });
        let opts = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
        c.requestAuthorizationWithOptions_completionHandler(opts, &block);
        if let Some(e) = wait(rx)? { return Err(e); }
        current_status(&c).map(str::to_string) // 요청 뒤 실제 상태(허용·거부)를 다시 읽어 돌려준다
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notify_send(title: String, body: String, tag: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(c) = center() else { return Err("unsupported".to_string()) };
        // 거부·미결정이면 보내지 않는다 — UN은 거부 상태에서도 addNotificationRequest를 오류 없이 받아 준다(검수용 번들 실측).
        // 그러면 "보냈다"로 보이는데 아무것도 안 뜬다. 상태를 먼저 보고 이유를 돌려준다(notify.js가 진단에 남긴다).
        match current_status(&c)? { "granted" => {}, other => return Err(format!("not allowed: {other}")) }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        // 소리는 앱이 직접 울린다(notify.js playChime) — OS 알림은 무음(종전 플러그인 경로와 같다)
        let id = if tag.is_empty() { format!("argo-{}", std::process::id()) } else { tag };
        let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |err: *mut NSError| {
            let msg = if err.is_null() { None } else { Some(unsafe { &*err }.localizedDescription().to_string()) };
            let _ = tx.send(msg);
        });
        c.addNotificationRequest_withCompletionHandler(&req, Some(&block));
        match wait(rx)? { Some(e) => Err(e), None => Ok(()) }
    }).await.map_err(|e| e.to_string())?
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
        fn will_present(&self, _c: &UNUserNotificationCenter, _n: &UNNotification, handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }
    }
);

/// setup에서 한 번 — 대리자는 center가 약하게 붙잡으므로 앱 수명 동안 놓지 않는다(leak).
pub fn install_delegate(mtm: objc2::MainThreadMarker) {
    let Some(c) = center() else { return };
    let d: Retained<NotifyDelegate> = unsafe { msg_send![NotifyDelegate::alloc(mtm), init] };
    c.setDelegate(Some(ProtocolObject::from_ref(&*d)));
    std::mem::forget(d);
}
