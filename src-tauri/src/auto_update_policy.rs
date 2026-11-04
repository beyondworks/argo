// 자동 업데이트 판단(언제 설치하나) — tauri 없이 표준 라이브러리만 쓴다. CI·로컬 시험이 이 파일만 rustc로 따로 컴파일해
// 아래 #[test]를 돌린다(test/auto-update-policy.test.mjs — boot_port.rs와 같은 방식, 본체 crate의 cargo test는 CI에서 돌지 않는다).
//
// 왜 있나(2026-11-04): 고객 PC가 0.1.124를 받지 못했다. 웹뷰 훅(app/use-app-update.js)은 확인만 하고 설치는 사람이 뱃지·설정 카드·
// 최소 버전 화면 버튼을 눌러야 했다. 셸(auto_update.rs)이 창·웹뷰와 상관없이 확인·내려받기를 하고, 이 파일의 판단이 "지금 설치해도
// 된다"고 할 때만 설치하고 다시 시작한다. 판단 순서와 이유는 decide()의 주석에 있다.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// 앱 시작 뒤 첫 확인까지 — 부팅·로그인·업데이트 경로 관문(사람이 뱃지를 누르는 시험)과 겹치지 않게 넉넉히 둔다.
pub const FIRST_CHECK: Duration = Duration::from_secs(10 * 60);
/// 새 판이 없을 때 다시 확인하는 간격.
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// 받아 둔 새 판을 작업 중이라 미뤘을 때 다시 보는 간격 — 내려받은 파일은 들고 있으므로 네트워크를 다시 쓰지 않는다.
pub const RETRY_DEFERRED: Duration = Duration::from_secs(15 * 60);
/// 받아 둔 새 판이 이만큼 기다렸으면 창을 보고 있어도(초점) 설치한다 — 하루 종일 창을 앞에 두는 사람도 결국 받게.
/// 실행 중인 작업(Busy)은 이 시간이 지나도 끊지 않는다.
pub const IN_USE_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
/// 서버가 작업 여부에 답하지 못하는(Unknown) 상태가 이만큼 이어지면 설치한다 — 고장 난 서버 때문에 고치는 판을 영영 못 받지 않게.
pub const UNKNOWN_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

/// 지금 이 앱이 쓰는 회사 서버(사이드카 또는 입양한 상주)에서 도는 일.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Work {
    /// 실행 중인 턴(채팅·메신저·텔레그램·루틴·회의실 — 모두 src/turn-abort.mjs registerTurn을 거친다)이 없다.
    Idle,
    /// 하나 이상 실행 중이다 — 설치(재시작)하면 끊긴다.
    Busy,
    /// 서버가 떠 있지 않다(포트를 모름·연결 거부) — 끊길 일이 없다.
    NoServer,
    /// 연결은 됐는데 답이 없거나 알아볼 수 없다 — 모르면 설치하지 않는다(UNKNOWN_GRACE까지).
    Unknown,
}

/// 설치 판단에 쓰는 사실 — 셸이 모아 넘긴다.
#[derive(Clone, Copy, Debug)]
pub struct Facts {
    /// 끄는 장치(ARGO_AUTO_UPDATE·~/.argo/auto-update-off)를 반영한 켜짐 여부 — enabled_from().
    pub enabled: bool,
    /// 맥 설치 위치 때문에 설치가 실패하거나 관리자 암호 창이 뜰 자리 — location_blocks().
    pub location_blocked: bool,
    /// 웹뷰(뱃지·설정 카드·최소 버전 화면)가 설치를 잡고 있다 — 같은 때 두 번 설치하지 않는다.
    pub claimed_elsewhere: bool,
    pub work: Work,
    /// 메인 창이 보이고 초점을 받고 있다 — 사람이 지금 화면을 쓰는 중.
    pub window_in_use: bool,
    /// 새 판을 받아 둔 뒤 지난 시간.
    pub waiting: Duration,
    /// Unknown이 이어진 시간(Unknown이 아니면 0).
    pub unknown_for: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Install,
    /// 다음 확인 때 다시 본다(RETRY_DEFERRED) — 이유는 진단 로그에 남긴다.
    Defer(&'static str),
    /// 이 앱에서는 자동 설치를 하지 않는다(사람이 버튼으로는 할 수 있다).
    Skip(&'static str),
}

/// 설치 시점 판단. 순서가 곧 우선순위다:
/// 1) 꺼져 있으면 Skip  2) 맥 설치 위치 문제면 Skip(설치가 실패하거나 갑자기 관리자 암호 창이 뜬다)
/// 3) 웹뷰가 설치 중이면 Defer  4) 실행 중인 작업이 있으면 Defer(시간과 상관없이 끊지 않는다)
/// 5) 작업 여부를 모르면 UNKNOWN_GRACE 전까지 Defer  6) 사람이 창을 쓰는 중이면 IN_USE_GRACE 전까지 Defer
/// 7) 그 밖(작업 없음·서버 없음)은 Install.
pub fn decide(f: &Facts) -> Decision {
    if !f.enabled {
        return Decision::Skip("disabled");
    }
    if f.location_blocked {
        return Decision::Skip("install_location");
    }
    if f.claimed_elsewhere {
        return Decision::Defer("webview_installing");
    }
    match f.work {
        Work::Busy => return Decision::Defer("work_running"),
        Work::Unknown if f.unknown_for < UNKNOWN_GRACE => return Decision::Defer("work_unknown"),
        _ => {}
    }
    if f.window_in_use && f.waiting < IN_USE_GRACE {
        return Decision::Defer("window_in_use");
    }
    Decision::Install
}

/// 끄는 장치. ARGO_AUTO_UPDATE가 0·off·false·no면 끔, 1·on·true·yes면 켬(개발 빌드에서도). 값이 없거나 다른 값이면
/// ~/.argo/auto-update-off 파일이 있으면 끔, 개발(debug) 빌드면 끔, 아니면 켬(기본).
pub fn enabled_from(env: Option<&str>, off_file: bool, debug_build: bool) -> bool {
    match env.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "0" | "off" | "false" | "no") => false,
        Some(v) if matches!(v.as_str(), "1" | "on" | "true" | "yes") => true,
        _ => !off_file && !debug_build,
    }
}

/// 맥 설치 위치 사실(update_location.rs) → 자동 설치를 하지 않을 자리인가. app/update-location.mjs updateLocationIssue와 같은 판정에
/// needs_admin(13·1)까지 막는다 — 사람이 누르지 않았는데 관리자 암호 창이 뜨면 안 된다. 맥이 아니거나 경로를 모르면 false.
pub fn location_blocks(macos: bool, has_path: bool, translocated: bool, errnos: [Option<i32>; 2], same_volume: Option<bool>) -> bool {
    if !macos || !has_path {
        return false;
    }
    translocated
        || errnos.contains(&Some(30))
        || same_volume == Some(false)
        || errnos.contains(&Some(13))
        || errnos.contains(&Some(1))
}

/// /api/app-busy 응답 → Work. 200이고 "busy":false면 Idle, "busy":true면 Busy, 그 밖(404 — 이 경로가 없는 서버, 5xx, 깨진 본문)은 Unknown.
pub fn classify_busy(text: &str) -> Work {
    let status_ok = text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
    let has = |v: &str| body.contains(&format!("\"busy\":{v}")) || body.contains(&format!("\"busy\": {v}"));
    match (status_ok, has("true"), has("false")) {
        (true, true, false) => Work::Busy,
        (true, false, true) => Work::Idle,
        _ => Work::Unknown,
    }
}

/// 회사 서버에 실행 중인 작업이 있는지 묻는다(최소 HTTP, 루프백). 포트를 모르거나 연결이 거부되면 NoServer.
pub fn probe_work(port: Option<u16>) -> Work {
    let Some(port) = port else { return Work::NoServer };
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else { return Work::NoServer };
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let req = format!("GET /api/app-busy HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return Work::Unknown;
    }
    let mut buf = Vec::new();
    let _ = s.take(16_384).read_to_end(&mut buf);
    classify_busy(&String::from_utf8_lossy(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const H: Duration = Duration::from_secs(60 * 60);
    fn idle() -> Facts {
        Facts { enabled: true, location_blocked: false, claimed_elsewhere: false, work: Work::Idle, window_in_use: false, waiting: Duration::ZERO, unknown_for: Duration::ZERO }
    }

    #[test]
    fn installs_when_nothing_runs_or_no_server() {
        assert_eq!(decide(&idle()), Decision::Install);
        assert_eq!(decide(&Facts { work: Work::NoServer, ..idle() }), Decision::Install);
    }

    #[test]
    fn running_work_always_defers_even_after_days() {
        let f = Facts { work: Work::Busy, waiting: 240 * H, unknown_for: 240 * H, ..idle() };
        assert_eq!(decide(&f), Decision::Defer("work_running"));
        assert_eq!(decide(&Facts { window_in_use: true, ..f }), Decision::Defer("work_running"));
    }

    #[test]
    fn unknown_work_defers_until_grace_then_installs() {
        let f = Facts { work: Work::Unknown, ..idle() };
        assert_eq!(decide(&f), Decision::Defer("work_unknown"));
        assert_eq!(decide(&Facts { unknown_for: UNKNOWN_GRACE - Duration::from_secs(1), ..f }), Decision::Defer("work_unknown"));
        assert_eq!(decide(&Facts { unknown_for: UNKNOWN_GRACE, ..f }), Decision::Install);
    }

    #[test]
    fn window_in_use_defers_until_grace() {
        let f = Facts { window_in_use: true, ..idle() };
        assert_eq!(decide(&f), Decision::Defer("window_in_use"));
        assert_eq!(decide(&Facts { waiting: IN_USE_GRACE - Duration::from_secs(1), ..f }), Decision::Defer("window_in_use"));
        assert_eq!(decide(&Facts { waiting: IN_USE_GRACE, ..f }), Decision::Install);
    }

    #[test]
    fn disabled_and_location_skip_before_anything_else() {
        assert_eq!(decide(&Facts { enabled: false, ..idle() }), Decision::Skip("disabled"));
        assert_eq!(decide(&Facts { location_blocked: true, ..idle() }), Decision::Skip("install_location"));
        assert_eq!(decide(&Facts { enabled: false, location_blocked: true, work: Work::Busy, ..idle() }), Decision::Skip("disabled"));
    }

    #[test]
    fn webview_install_claim_defers_auto_install() {
        assert_eq!(decide(&Facts { claimed_elsewhere: true, ..idle() }), Decision::Defer("webview_installing"));
        assert_eq!(decide(&Facts { claimed_elsewhere: true, waiting: 240 * H, ..idle() }), Decision::Defer("webview_installing"));
    }

    #[test]
    fn switch_env_overrides_file_and_build_default_is_on() {
        assert!(enabled_from(None, false, false), "기본은 켬");
        for off in ["0", "off", "FALSE", " no "] { assert!(!enabled_from(Some(off), false, false), "{off}"); }
        assert!(!enabled_from(None, true, false), "끄는 파일");
        assert!(!enabled_from(None, false, true), "개발 빌드는 기본 끔");
        assert!(enabled_from(Some("1"), true, true), "명시적으로 켜면 켬");
        assert!(enabled_from(Some("anything"), false, false));
        assert!(!enabled_from(Some(""), true, false));
    }

    #[test]
    fn mac_location_problems_block_and_others_do_not() {
        let ok = [None, None];
        assert!(!location_blocks(true, true, false, ok, Some(true)));
        assert!(location_blocks(true, true, true, ok, Some(true)), "translocated");
        assert!(location_blocks(true, true, false, [Some(30), None], Some(true)), "read_only");
        assert!(location_blocks(true, true, false, ok, Some(false)), "other_volume");
        assert!(location_blocks(true, true, false, [None, Some(13)], Some(true)), "needs_admin");
        assert!(location_blocks(true, true, false, [Some(1), None], None), "needs_admin(EPERM)");
        assert!(!location_blocks(true, true, false, ok, None), "볼륨을 모르면 막지 않는다(화면 판정과 같음)");
        assert!(!location_blocks(false, true, true, [Some(30), None], Some(false)), "맥이 아니면 해당 없음");
        assert!(!location_blocks(true, false, true, ok, Some(true)), "경로를 모르면 해당 없음");
    }

    #[test]
    fn busy_response_is_read_strictly() {
        assert_eq!(classify_busy("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"busy\":false,\"turns\":0}"), Work::Idle);
        assert_eq!(classify_busy("HTTP/1.1 200 OK\r\n\r\n{\"busy\":true,\"turns\":2}"), Work::Busy);
        assert_eq!(classify_busy("HTTP/1.1 404 Not Found\r\n\r\n{\"busy\":false}"), Work::Unknown, "404면 본문을 믿지 않는다");
        assert_eq!(classify_busy("HTTP/1.1 401 Unauthorized\r\n\r\n{\"error\":\"auth_required\"}"), Work::Unknown);
        assert_eq!(classify_busy("HTTP/1.1 200 OK\r\n\r\n<html>"), Work::Unknown);
        assert_eq!(classify_busy(""), Work::Unknown);
    }

    #[test]
    fn probe_tells_no_server_unknown_and_answers_apart() {
        assert_eq!(probe_work(None), Work::NoServer);
        // 닫힌 포트 — 묶었다가 놓아 아무도 듣지 않는 포트를 얻는다
        let closed = { let l = TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
        assert_eq!(probe_work(Some(closed)), Work::NoServer);
        let serve = |reply: &'static str| {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    let mut b = [0u8; 1024];
                    let n = s.read(&mut b).unwrap_or(0);
                    assert!(String::from_utf8_lossy(&b[..n]).starts_with("GET /api/app-busy HTTP/1.1\r\n"));
                    let _ = s.write_all(reply.as_bytes());
                }
            });
            port
        };
        assert_eq!(probe_work(Some(serve("HTTP/1.1 200 OK\r\n\r\n{\"busy\":true,\"turns\":1}"))), Work::Busy);
        assert_eq!(probe_work(Some(serve("HTTP/1.1 200 OK\r\n\r\n{\"busy\":false,\"turns\":0}"))), Work::Idle);
        assert_eq!(probe_work(Some(serve("HTTP/1.1 404 Not Found\r\n\r\nCannot GET /api/app-busy"))), Work::Unknown);
    }
}
