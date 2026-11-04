// 셸 자동 업데이트 — 창이 닫혀 있거나(맥: 숨김) 웹뷰가 없어도, 사람 손 없이 새 판을 받아 설치하고 다시 시작한다(2026-11-04, 0.1.125 후보).
// 판단(언제 설치하나)은 auto_update_policy.rs의 순수 함수(decide)가 하고, 여기서는 사실을 모으고 실행만 한다.
//
// 흐름: 앱 시작 FIRST_CHECK 뒤 → app.updater().check() → 새 판이면 download()(플러그인이 tauri.conf.json pubkey로 서명 검증)
//   → 받은 파일을 들고 decide()가 Install일 때까지 RETRY_DEFERRED마다 다시 본다 → install() → 맥은 app.restart(),
//   Windows는 플러그인이 NSIS 설치기(passive)를 띄우고 프로세스를 끝낸다(설치기 /R이 다시 띄운다 — 웹뷰 버튼 경로와 같은 호출).
// 잠금: 웹뷰 훅(app/use-app-update.js)과 같은 때 두 번 설치하지 않도록 설치 잡기(claim)를 이 파일 한 곳에 둔다.
//   셸은 내려받는 동안과 설치하는 순간에만 잡고, 웹뷰는 버튼을 누른 뒤 설치를 마칠 때까지 잡는다(update_install_claim·release 명령).
#![cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
use tauri::Manager;
#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
use crate::auto_update_policy::{self as policy, Decision, Facts, Work};
#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
use crate::diag_log;

/// 웹뷰가 잡은 설치가 이보다 오래 풀리지 않으면 버려진 것으로 본다(내려받는 중 화면을 새로 고친 경우 등).
const WEBVIEW_CLAIM_STALE: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Holder { Auto, Webview, Installed }

static CLAIM: Mutex<Option<(Holder, Instant)>> = Mutex::new(None);
static SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// 웹뷰가 붙는 회사 서버 포트(입양한 상주 또는 띄운 사이드카) — 작업 중 여부를 여기에 묻는다.
pub fn set_server_port(port: u16) {
    SERVER_PORT.store(port, Ordering::SeqCst);
}

fn claim(who: Holder) -> bool {
    let mut c = CLAIM.lock().unwrap_or_else(|e| e.into_inner());
    let stale = matches!(*c, Some((Holder::Webview, at)) if at.elapsed() >= WEBVIEW_CLAIM_STALE);
    if c.is_none() || stale {
        *c = Some((who, Instant::now()));
        true
    } else {
        false
    }
}

fn release(who: Holder) {
    let mut c = CLAIM.lock().unwrap_or_else(|e| e.into_inner());
    if matches!(*c, Some((h, _)) if h == who) {
        *c = None;
    }
}

fn held_by_other(me: Holder) -> bool {
    let c = CLAIM.lock().unwrap_or_else(|e| e.into_inner());
    match *c {
        Some((Holder::Webview, at)) => me != Holder::Webview && at.elapsed() < WEBVIEW_CLAIM_STALE,
        Some((h, _)) => h != me,
        None => false,
    }
}

/// 웹뷰가 설치를 시작하기 전에 잡는다 — false면 셸이 내려받거나 설치하는 중(웹뷰는 잠시 뒤 다시 잡는다).
#[tauri::command]
pub fn update_install_claim() -> bool {
    claim(Holder::Webview)
}

/// 웹뷰 설치가 실패하면 놓는다. 설치에 성공했는데 재시작만 실패한 경우에는 놓지 않는다(셸이 같은 판을 다시 설치하지 않게).
#[tauri::command]
pub fn update_install_release() {
    release(Holder::Webview);
}

#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
#[derive(Default)]
struct State {
    ready: Option<(Update, Vec<u8>, Instant)>,
    unknown_since: Option<Instant>,
}

#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
fn enabled_now(app: &AppHandle) -> bool {
    let off_file = app.path().home_dir().map(|h| h.join(".argo").join("auto-update-off").exists()).unwrap_or(false);
    policy::enabled_from(std::env::var("ARGO_AUTO_UPDATE").ok().as_deref(), off_file, cfg!(debug_assertions))
}

#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
fn window_in_use(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

/// 백그라운드 작업 시작 — setup에서 한 번. 맥·Windows만(리눅스 묶음은 앱 안 설치 경로가 다르고 시험하지 않았다, 모바일은 업데이터 없음).
#[cfg(not(all(desktop, any(target_os = "macos", target_os = "windows"))))]
pub fn start(_app: AppHandle) {}

#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(policy::FIRST_CHECK);
        let mut st = State::default();
        loop {
            let next = round(&app, &mut st);
            std::thread::sleep(next);
        }
    });
}

#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
fn log(msg: &str) {
    log::info!("[argo] auto update: {msg}");
    diag_log::write("update", msg);
}

#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
fn round(app: &AppHandle, st: &mut State) -> Duration {
    let enabled = enabled_now(app);
    let location_blocked = crate::update_location::update_location().blocks_auto_install();
    // 꺼짐·설치 위치 문제는 네트워크를 쓰기 전에 거른다 — 같은 판단 함수로
    let pre = Facts { enabled, location_blocked, claimed_elsewhere: false, work: Work::NoServer, window_in_use: false, waiting: Duration::ZERO, unknown_for: Duration::ZERO };
    if let Decision::Skip(why) = policy::decide(&pre) {
        log(&format!("skip ({why})"));
        st.ready = None;
        return policy::CHECK_EVERY;
    }
    if matches!(*CLAIM.lock().unwrap_or_else(|e| e.into_inner()), Some((Holder::Installed, _))) {
        return policy::CHECK_EVERY;
    }
    // 받아 둔 판이 오래됐으면 버리고 다시 확인한다(그사이 더 새 판이 나왔을 수 있다)
    if st.ready.as_ref().is_some_and(|(_, _, at)| at.elapsed() >= policy::CHECK_EVERY) {
        st.ready = None;
    }
    if st.ready.is_none() {
        let update = match app.updater().map_err(|e| e.to_string()).and_then(|u| tauri::async_runtime::block_on(u.check()).map_err(|e| e.to_string())) {
            Ok(Some(u)) => u,
            Ok(None) => return policy::CHECK_EVERY,
            Err(e) => {
                log(&format!("check failed: {e}"));
                return policy::CHECK_EVERY;
            }
        };
        if !claim(Holder::Auto) {
            log("webview is installing — will look again");
            return policy::RETRY_DEFERRED;
        }
        let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}));
        release(Holder::Auto);
        match bytes {
            Ok(b) => {
                log(&format!("downloaded {} ({} bytes, signature verified)", update.version, b.len()));
                st.ready = Some((update, b, Instant::now()));
            }
            Err(e) => {
                // 서명 실패·네트워크 오류 — 설치하지 않고 다음 확인 때 처음부터
                log(&format!("download failed ({}): {e}", update.version));
                return policy::CHECK_EVERY;
            }
        }
    }
    let waiting = st.ready.as_ref().map(|(_, _, at)| at.elapsed()).unwrap_or_default();
    let work = policy::probe_work(Some(SERVER_PORT.load(Ordering::SeqCst)).filter(|p| *p != 0));
    let unknown_for = if work == Work::Unknown {
        st.unknown_since.get_or_insert_with(Instant::now).elapsed()
    } else {
        st.unknown_since = None;
        Duration::ZERO
    };
    let facts = Facts { enabled, location_blocked, claimed_elsewhere: held_by_other(Holder::Auto), work, window_in_use: window_in_use(app), waiting, unknown_for };
    match policy::decide(&facts) {
        Decision::Install => install(app, st),
        Decision::Defer(why) => {
            log(&format!("deferred ({why})"));
            policy::RETRY_DEFERRED
        }
        Decision::Skip(why) => {
            log(&format!("skip ({why})"));
            st.ready = None;
            policy::CHECK_EVERY
        }
    }
}

#[cfg(all(desktop, any(target_os = "macos", target_os = "windows")))]
fn install(app: &AppHandle, st: &mut State) -> Duration {
    if !claim(Holder::Auto) {
        return policy::RETRY_DEFERRED;
    }
    let Some((update, bytes, _)) = st.ready.take() else {
        release(Holder::Auto);
        return policy::CHECK_EVERY;
    };
    log(&format!("installing {} -> {}", app.package_info().version, update.version));
    match update.install(&bytes) {
        Ok(()) => {
            *CLAIM.lock().unwrap_or_else(|e| e.into_inner()) = Some((Holder::Installed, Instant::now()));
            log("installed — restarting");
            app.restart();
        }
        Err(e) => {
            release(Holder::Auto);
            log(&format!("install failed: {e}"));
            policy::CHECK_EVERY
        }
    }
}
