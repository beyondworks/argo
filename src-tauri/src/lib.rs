// Argo 데스크톱 셸 — 앱 실행 = 회사 서버 자동 기동.
// 번들에 내장된 Node + Next standalone 서버를 사이드카로 띄운다. 포트에 이미 뜬 서버는 /api/ping
// 신원 마커로 "진짜 Argo인가"를 확인한 뒤에만 붙는다(실사용 2026-07-20: 타 앱이 3001을 선점한
// Windows에서 TCP 열림만 보고 낯선 Express 서버에 웹뷰가 붙어 "Cannot GET /" 표시 — 사이드카는
// 아예 안 떴다). Argo가 아니면 다음 후보 포트로 폴백해 스폰하고, 선택 포트를 boot 이벤트로
// 프론트(public/boot.js)에 알린다.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
#[cfg(target_os = "macos")]
mod no_dock;
mod update_notes;
mod update_location;

// 부트 화면(public/index.html)에 실시간 상태를 알린다 — 실패도 화면에 보이게(무한 대기 방지).
// port: 프론트가 이동할 서버 포트(선택 확정 후) — boot.js가 후보 목록 맨 앞에 넣는다.
fn boot_status(app: &tauri::AppHandle, phase: &str, detail: &str, port: Option<u16>) {
    // version — boot.js가 프로브 시 "같은 버전의 Argo인가"를 대조한다(아래 is_same_version_argo와 한 쌍).
    let _ = app.emit("boot", serde_json::json!({ "phase": phase, "detail": detail, "port": port, "version": env!("CARGO_PKG_VERSION") }));
}

// 포트 후보 — 3001(상주 서비스·기존 관례) 우선, 선점 시 폴백. boot.js의 후보 목록과 일치해야 한다.
const PORTS: [u16; 3] = [3001, 3011, 3021];

// Recomputed from the actual sidecar bind, never inherited from the parent.
fn local_bind_proof(host: &str) -> &str {
    match host { "127.0.0.1" | "::1" | "localhost" => host, _ => "" }
}

// 앱이 띄운 사이드카 핸들 — 종료 시 함께 죽인다.
// (실측: Windows에서 앱을 닫아도 node가 고아로 남아 3001을 점유 → 다음 실행이 구버전/죽은 서버에 붙는다)
struct Sidecar(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn tcp_open(port: u16) -> bool {
    TcpStream::connect_timeout(&(([127, 0, 0, 1], port).into()), Duration::from_millis(300)).is_ok()
}

// connect 실패 ≠ bind 가능 — Windows Hyper-V/WinNAT 동적 예약 대역의 포트는 아무도 LISTEN하지
// 않아도 커널이 bind()를 EACCES로 거부한다(실사용 신고 2026-07-27, Win11 24H2 재현: 예약 대역에
// 3001이 걸리면 사이드카가 listen EACCES로 즉사, 재시작으로는 절대 안 풀림). 스폰 전에 실제
// bind로 확인한다 — TcpListener는 즉시 drop되고 loopback+즉시 스폰 흐름이라 TIME_WAIT 무해.
fn can_bind(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

// 스폰 후보 선택(순수) — tried 제외 + 닫혀 있고(bind 가능) 순서 유지. 판정 함수를 주입받아
// 실소켓 없이 단위 테스트한다(검수 1R: 폴백 로직 무테스트 지적).
fn pick_spawn_port(tried: &[u16], open: impl Fn(u16) -> bool, bindable: impl Fn(u16) -> bool) -> Option<u16> {
    PORTS.iter().copied().find(|&p| !tried.contains(&p) && !open(p) && bindable(p))
}

// Windows 예약 포트 자가진단 힌트 — can_bind 실패가 원인일 때만 실어 보낸다(부록 c).
const RESERVED_HINT: &str = "ports may be reserved by Windows (Hyper-V dynamic range) — check with `netsh int ipv4 show excludedportrange protocol=tcp` in Admin PowerShell, or run `net stop winnat && net start winnat` and reopen Argo";

// 플랫폼별 힌트 — netsh/winnat 안내가 macOS/Linux 사용자에게 나가면 오귀속(검수 1R MEDIUM).
fn reserved_hint() -> &'static str {
    if cfg!(windows) { RESERVED_HINT } else { "another program may be interfering with local ports — check the app logs" }
}

// 종결 에러 — terminal:true로 boot.js가 "재시도 중" 문구를 붙이지 않게 한다(검수 1R: 폴백
// 소진 후에도 '재시도 중'이 떠 있으면 신고가 지적한 UX 거짓이 종료 단계로 이동할 뿐).
fn boot_error_final(app: &tauri::AppHandle, detail: &str, port: Option<u16>) {
    let _ = app.emit("boot", serde_json::json!({ "phase": "error", "detail": detail, "port": port, "terminal": true, "version": env!("CARGO_PKG_VERSION") }));
}

// 포트의 서버 상태 — /api/ping 한 번으로 가른다. Silent = 연결은 받았는데 답이 없다: next start는 포트를 먼저 열고
// 핸들러가 준비(Ready)될 때까지 요청을 붙잡아 둔다(next/dist/server/lib/start-server.js: listen → handlersPromise).
// 상주가 기동 중이라는 뜻이라 기다릴 근거가 된다. Other = 답이 왔지만 같은 버전 Argo가 아니다(타 앱·다른 버전).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PortState { Closed, Silent, SameArgo, Other }

// /api/ping 응답 판정 — 신원 마커 + 같은 버전 + 현재 dockProtocol일 때만 SameArgo.
fn classify_ping(text: &str) -> PortState {
    let is_argo = text.contains("\"argo\":true") || text.contains("\"argo\": true");
    let same_ver = text.contains(&format!("\"version\":\"{}\"", env!("CARGO_PKG_VERSION")))
        || text.contains(&format!("\"version\": \"{}\"", env!("CARGO_PKG_VERSION")));
    // Version alone can adopt an old resident with the pre-fix spawn paths.
    // Bound the numeric token so a future incompatible protocol is not accepted.
    let dock_protocol = ["\"dockProtocol\":1,", "\"dockProtocol\":1}", "\"dockProtocol\": 1,", "\"dockProtocol\": 1}"]
        .iter().any(|marker| text.contains(marker));
    if is_argo && same_ver && dock_protocol { PortState::SameArgo } else { PortState::Other }
}

// 이 포트의 서버가 "같은 버전의" Argo인가 — /api/ping 신원 마커 + 버전을 최소 HTTP로 확인.
// TCP 열림 ≠ Argo(타 앱 선점·좀비) — 신원 확인 없이는 붙지도, 그 포트를 쓰지도 않는다.
// 버전 대조(2026-07-22 실사용 신고): 버전 불문 adopt는 앱(쉘) 버전과 화면(UI) 버전을 어긋나게 한다 —
// v0.1.20 앱이 상주 v0.1.22 서버에 붙어 "업데이트 안 했는데 다음 버전이 표시"되고, 업데이트 뱃지도
// 무의미해진다. 같은 버전일 때만 붙고(같은 앱 이중 실행 방지라는 원 목적), 다르면 자기 사이드카를
// 다음 빈 포트에 띄운다(상주 서버는 건드리지 않는다).
fn probe_port(port: u16) -> PortState {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else { return PortState::Closed };
    let _ = s.set_write_timeout(Some(Duration::from_millis(300)));
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    let req = format!("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() { return PortState::Other; }
    let mut buf = Vec::new();
    // 타임아웃/조기 종료여도 읽힌 만큼 판정. 한 바이트도 없이 읽기 상한에 걸렸을 때만 Silent(기동 중) —
    // 바로 끊는 서버(빈 EOF·리셋)는 기동 중이 아니라 Other다.
    let read = s.take(16_384).read_to_end(&mut buf);
    let timed_out = matches!(&read, Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut));
    if buf.is_empty() && timed_out { return PortState::Silent; }
    classify_ping(&String::from_utf8_lossy(&buf))
}

fn is_same_version_argo(port: u16) -> bool {
    probe_port(port) == PortState::SameArgo
}

// 상주 서비스(scripts/service.mjs install)가 맡은 포트 — 맥 LaunchAgent plist의 `next start … -p <포트>`.
// 서비스 기본 포트는 3999지만 ARGO_PORT로 3001에 둔 기기(개발 맥)가 있다. 후보 포트(PORTS)와 겹칠 때만 앱과 자리를 다툰다.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn resident_port_from_plist(plist: &str) -> Option<u16> {
    let args = plist.split("<key>ProgramArguments</key>").nth(1)?;
    let args = &args[..args.find("</array>")?];
    let items: Vec<&str> = args.split("<string>").skip(1).filter_map(|s| s.split_once("</string>")).map(|(v, _)| v.trim()).collect();
    items.iter().enumerate().find_map(|(i, a)| match *a {
        "-p" | "--port" => items.get(i + 1)?.parse().ok(),
        _ => a.strip_prefix("--port=")?.parse().ok(),
    })
}

// 라벨은 scripts/service.mjs의 LABEL과 같아야 한다. uninstall은 plist를 지우므로 파일이 있으면 설치된 것으로 본다.
#[cfg(target_os = "macos")]
fn installed_resident_port(home: Option<std::path::PathBuf>) -> Option<u16> {
    let plist = std::fs::read_to_string(home?.join("Library/LaunchAgents/com.beyondworks.argo.plist")).ok()?;
    resident_port_from_plist(&plist)
}

// Windows 상주 = 작업 스케줄러 'Argo' + 저장소 안 argo-service.cmd(앱은 그 위치를 모른다) — 판정하려면 schtasks를
// 띄워야 해서 이번에는 보지 않는다(기존 동작 그대로). Linux는 데스크톱 앱 배포가 없다(release.yml: macOS 2종 + Windows).
#[cfg(not(target_os = "macos"))]
fn installed_resident_port(_home: Option<std::path::PathBuf>) -> Option<u16> {
    None
}

// 상주 대기 상한 — 근거(2026-10-08 이 맥 실측, PR 본문에 원자료):
// · 포트가 아직 닫힘: 로그인 직후 launchd가 사용자 에이전트 기동을 미룬다("pending spawn, domain in on-demand-only
//   mode" 17:18:19.161). 상주는 그 뒤 16초 안에 listen까지 왔고(17:18:35.298 첫 종료, err 로그는 EADDRINUSE 반복), 첫 실행이 죽으면
//   ThrottleInterval 10초 뒤 다시 뜬다 → 30초.
// · 포트는 열렸는데 답이 없음(next start 준비 중): ~/Library/Logs/argo.log 'Ready in' 22건 중 최대 37.2초(나머지 21건은 1.8초 이하) + 위 16초 → 60초.
const RESIDENT_WAIT_CLOSED: Duration = Duration::from_secs(30);
const RESIDENT_WAIT_SILENT: Duration = Duration::from_secs(60);
// 확인 간격 — 루프백 연결 몇 개뿐이다(닫힌 포트는 즉시 거절, 답 없는 포트는 probe가 읽기 상한 800ms만큼 기다린다).
// 상주가 준비되면 boot.js가 스스로 프로브해 이동하므로, 이 간격은 '다른 버전으로 판명'·'포기' 판정 지연에만 든다.
const RESIDENT_POLL: Duration = Duration::from_millis(500);

#[derive(Debug, PartialEq, Eq)]
enum Boot {
    Adopt(u16),
    // keep_free = 상주 자리 — 상주가 늦게 떠도 포트를 잃지 않게 앱 서버는 다른 포트에 띄운다.
    Spawn { keep_free: Option<u16> },
}

// 포트 결정(순수) — None = 상주를 더 기다린다. 판정 함수를 주입받아 실소켓 없이 단위 테스트한다.
// ① 후보 중 같은 버전 Argo가 있으면 붙는다(기존). ② 상주가 후보 포트에 설치돼 있고 그 포트가 닫혀 있거나(아직 안 뜸)
// 답이 없으면(준비 중) 상한까지 기다린다. 상한을 넘기면 그 포트를 비워 두고 띄운다. ③ 상주 포트에서 답이 왔는데
// 같은 버전이 아니면(다른 버전 상주·타 앱) 지금처럼 공존 — 열린 포트는 pick_spawn_port가 건너뛴다.
// 상주가 없으면(dmg 일반 사용자·Windows) ②가 없어 지금과 같다(기다림 0, 3001부터).
fn plan_boot(resident: Option<u16>, waited: Duration, probe: impl Fn(u16) -> PortState) -> Option<Boot> {
    let states: Vec<(u16, PortState)> = PORTS.iter().map(|&p| (p, probe(p))).collect();
    if let Some(&(p, _)) = states.iter().find(|(_, s)| *s == PortState::SameArgo) {
        return Some(Boot::Adopt(p));
    }
    let Some((r, state)) = resident.and_then(|r| states.iter().copied().find(|&(p, _)| p == r)) else {
        return Some(Boot::Spawn { keep_free: None });
    };
    match state {
        PortState::Closed if waited < RESIDENT_WAIT_CLOSED => None,
        PortState::Silent if waited < RESIDENT_WAIT_SILENT => None,
        PortState::Closed | PortState::Silent => Some(Boot::Spawn { keep_free: Some(r) }),
        PortState::SameArgo | PortState::Other => Some(Boot::Spawn { keep_free: None }),
    }
}

// 상주 대기 루프 — elapsed = 부팅 시작부터 흐른 시간, pause = 상태 알림 + 한 간격 쉬기(테스트는 가짜 시계).
fn settle_boot(resident: Option<u16>, probe: impl Fn(u16) -> PortState, elapsed: impl Fn() -> Duration, mut pause: impl FnMut()) -> Boot {
    loop {
        if let Some(boot) = plan_boot(resident, elapsed(), &probe) { return boot; }
        pause();
    }
}

// 스폰 포트 — 상주 자리(keep_free)는 비워 둔다. 다만 그 자리밖에 남지 않았으면 앱이 아예 못 뜨는 것보다 나으므로 마지막에 쓴다.
fn pick_boot_port(keep_free: Option<u16>, tried: &[u16], open: impl Fn(u16) -> bool, bindable: impl Fn(u16) -> bool) -> Option<u16> {
    let avoid: Vec<u16> = tried.iter().copied().chain(keep_free).collect();
    pick_spawn_port(&avoid, &open, &bindable).or_else(|| pick_spawn_port(tried, &open, &bindable))
}

#[cfg(target_os = "macos")]
fn no_dock_node_options(_server_dir: &str, home: Option<std::path::PathBuf>) -> Result<String, String> {
    let home = home.ok_or_else(|| "홈 디렉터리를 알 수 없음".to_string())?;
    no_dock::prepare(&home, std::env::var("NODE_OPTIONS").ok().as_deref())
}

// Windows 리소스 경로의 \\?\ (UNC) 프리픽스 제거 — node가 스크립트 경로 인자로 받지 못해
// 사이드카가 침묵 사망한다 (실측: 같은 서버를 수동 실행하면 578ms에 정상 기동).
fn de_unc(p: String) -> String {
    p.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(p)
}

// 산출물 저장 — 웹뷰의 <a download>가 WKWebView(맥)/WebView2(윈)에서 무동작이라(실사용 제보
// 2026-08-07: "채팅·산출물에서 클릭해도 다운로드 안 됨"), UI가 파일 바이트를 IPC로 넘기면
// OS 다운로드 폴더에 저장하고 최종 경로를 돌려준다. UI는 그 경로를 opener revealItemInDir로
// 파인더/탐색기에 하이라이트해 "받아졌다"를 보여준다.
// 이름은 basename만 취해 경로 조작을 차단하고, 충돌은 " (n)" 접미로 회피(브라우저 관례).
// ponytail: 바이트가 IPC JSON을 타므로 수십 MB급에서 느리다 — 그때는 raw IPC(Request body)로 전환.
#[tauri::command]
fn save_download(app: tauri::AppHandle, name: String, data: Vec<u8>) -> Result<String, String> {
    let base = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("download")
        .to_string();
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut target = dir.join(&base);
    if target.exists() {
        let (stem, ext) = match base.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (base.clone(), String::new()),
        };
        // 후보 소진 시 원본을 덮어쓰지 않는다 — 조용한 데이터 유실(검수 MEDIUM 2026-08-07).
        // 실패로 돌리면 UI가 서버 다운로드로 폴백해 브라우저가 자기 규칙으로 이름을 정한다.
        target = (1..1000)
            .map(|n| dir.join(format!("{stem} ({n}){ext}")))
            .find(|c| !c.exists())
            .ok_or_else(|| format!("같은 이름의 파일이 너무 많습니다: {base}"))?;
    }
    std::fs::write(&target, &data).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// 앱 창이 파일 응답 주소로 항해하면 막는다(실사고 2026-09-17: 산출물 칩의 다운로드 폴백이 창 전체를 이미지로 바꿨고,
/// 닫기·ESC·뒤로가기가 없어 앱을 종료해야만 돌아왔다). 파일을 내려주는 라우트만 대상 — 결제 포털 등 다른 /api 항해는 그대로.
fn is_file_route_nav(url: &tauri::Url) -> bool {
    let local = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"));
    let segs: Vec<&str> = url.path().trim_start_matches('/').split('/').collect();
    // inline=1 = 미리보기 iframe(PDF). WKWebView의 항해 핸들러는 메인 프레임과 iframe을 가르지 않아, 막으면 PDF 미리보기가 빈 칸이 된다(2차 검수 HIGH-3).
    let inline = url.query_pairs().any(|(k, v)| k == "inline" && v == "1");
    local && !inline && segs.len() == 4 && segs[0] == "api" && segs[1] == "companies" && matches!(segs[3], "files" | "vault")
}

#[tauri::command]
async fn read_update_notes_version(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || update_notes::read(&dir)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn acknowledge_update_notes_version(app: tauri::AppHandle, version: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let installed = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || update_notes::acknowledge(&dir, &version, &installed)).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_download, read_update_notes_version, acknowledge_update_notes_version, update_location::update_location])
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("file-nav-guard")
                .on_navigation(|_webview, url| !is_file_route_nav(url))
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init()) // 앱에서 외부 브라우저 열기(로그인 핸드오프)
        .plugin(tauri_plugin_dialog::init()) // 폴더 픽커(내보내기 목적지 — 평문 경로 입력 대체)
        // macOS: 창 닫기(빨간 버튼·cmd+W) = 앱 숨김 — Claude Desktop과 같은 관례(실사용 요청 2026-07-27).
        // NSApp hide라 독 아이콘이 남고, 독 클릭이 OS 표준 unhide로 창을 복원한다(별도 Reopen 코드 불요).
        // cmd+Q·메뉴 Quit은 CloseRequested가 아니라 ExitRequested 경로라 그대로 종료(사이드카 정리 포함).
        // 크루·동기화·루틴은 사이드카에서 돌므로 "닫아도 계속 일하는" 기대와도 일치한다.
        // Windows/Linux는 기존 동작 유지(트레이가 없어 숨기면 복귀 수단이 없다 — 트레이 도입 시 재검토).
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.app_handle().hide();
                api.prevent_close();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event); // 미사용 경고 억제 — 타 OS는 기본 동작(닫기=종료)
        })
        .setup(|app| {
            app.manage(Sidecar(std::sync::Mutex::new(None)));
            // 인앱 업데이트(설정 → 앱 업데이트 버튼) — 데스크톱 전용. 서명 검증은 tauri.conf.json pubkey.
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?; // 설치 후 relaunch
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 포트 결정 — plan_boot(순수 판정) 주석 참고. 상주가 없으면 지금과 같이 여기서 바로 정한다.
            // 주의(TCC, 분리 검수 M4): 입양 경로에선 서버가 앱의 자식이 아니라(예: launchd 상주)
            // macOS 폴더 접근 프롬프트가 이 앱 번들(Info.plist 문구·부여 권한)로 귀속되지 않는다.
            // dmg 일반 사용자는 항상 스폰 경로라 무영향 — 상주 서버를 쓰는 개발 환경에서
            // "프롬프트가 안 뜬다"고 plist 병합 실패로 오진하지 말 것.
            let handle = app.handle().clone();
            let resident = installed_resident_port(app.path().home_dir().ok());
            let boot_started = Instant::now();
            match plan_boot(resident, Duration::ZERO, probe_port) {
                Some(boot) => start_boot(&handle, boot),
                // 상주가 아직 안 떴거나 준비 중(실사고 2026-10-08: 재시동 직후 앱이 먼저 3001을 차지해 상주가 2시간 50분
                // EADDRINUSE 재시작). 설정 단계를 붙잡으면 창이 늦게 뜨므로 별도 스레드에서 기다린다. 매 간격 상태를
                // 다시 보낸다 — boot.js의 이벤트 등록이 첫 emit보다 늦어도 버전·문구가 도착한다.
                None => {
                    std::thread::spawn(move || {
                        let boot = settle_boot(resident, probe_port, || boot_started.elapsed(), || {
                            boot_status(&handle, "resident", "waiting for the Argo background service", None);
                            std::thread::sleep(RESIDENT_POLL);
                        });
                        if let Boot::Spawn { keep_free: Some(r) } = boot {
                            log::warn!("[argo] 상주(포트 {r})가 {}초 안에 답하지 않아 앱 서버를 다른 포트에 띄운다", boot_started.elapsed().as_secs());
                        }
                        start_boot(&handle, boot);
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // 앱 종료 = 사이드카도 종료 — 고아 node가 3001을 계속 점유하지 않게
            if let tauri::RunEvent::Exit = event {
                if let Some(st) = app.try_state::<Sidecar>() {
                    if let Some(child) = st.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}

// 포트 결정 실행 — 붙거나, 빈 포트를 골라 사이드카를 띄운다.
fn start_boot(handle: &tauri::AppHandle, boot: Boot) {
    let keep_free = match boot {
        Boot::Adopt(p) => {
            boot_status(handle, "started", "server already running", Some(p));
            return;
        }
        Boot::Spawn { keep_free } => keep_free,
    };
    // 빈 포트 판정 = connect 안 됨 **그리고 bind 됨** — connect만 보면 Hyper-V 예약 포트를
    // "빈 포트"로 오판해 스폰 즉사(실사용 신고 2026-07-27).
    let Some(port) = pick_boot_port(keep_free, &[], tcp_open, can_bind) else {
        // 원인을 갈라 알린다 — 타 앱 점유(전부 TCP 열림)와 커널 예약(닫혀 있는데 bind 불가)은
        // 사용자가 취할 행동이 다르다(전자=앱 종료, 후자=winnat 재시작).
        let all_taken = PORTS.iter().copied().all(tcp_open);
        let msg = if all_taken {
            "ports 3001/3011/3021 are all taken by other apps — close them (or restart this computer) and reopen Argo".to_string()
        } else {
            format!("no usable port among 3001/3011/3021 — {}", reserved_hint())
        };
        boot_error_final(handle, &msg, None);
        return;
    };
    boot_status(handle, "starting", "launching local server", Some(port));
    spawn_sidecar(handle.clone(), port, keep_free);
}

fn spawn_sidecar(handle: tauri::AppHandle, port: u16, keep_free: Option<u16>) {
    // 데이터 루트 = OS 앱 로컬 데이터 폴더. 여기 workspaces/ 아래 회사 폴더가 쌓인다.
    let data_root = de_unc(handle
        .path()
        .app_local_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default());
    // 번들 리소스의 standalone 서버 경로
    let server_dir = de_unc(handle
        .path()
        .resolve("server", tauri::path::BaseDirectory::Resource)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default());

    tauri::async_runtime::spawn(async move {
        // 즉사 폴백(실사용 신고 2026-07-27 제안 b) — 스폰 5초 안에 비정상 종료하면
        // (bind 거부·모듈 로드 실패 계열) 다음 후보 포트로 재스폰한다. can_bind를
        // 스폰 직전에도 재확인해 경합·예약을 걸러낸다. 후보 소진 시에만 최종 에러 —
        // 예전엔 폴백이 없어 boot.js가 "재시도 중"을 띄우지만 실제 재시도는 0회였다(UX 거짓).
        let mut tried: Vec<u16> = Vec::new();
        let mut port = port;
        loop {
            tried.push(port);
            let sidecar = match handle.shell().sidecar("node") {
                Ok(c) => c,
                Err(e) => {
                    log::error!("[argo] node 사이드카 없음: {e}");
                    boot_error_final(&handle, &format!("node sidecar missing: {e}"), Some(port)); // 종결 — 재스폰 없음(2R H2)
                    return;
                }
            };
            let bind_host = "127.0.0.1";
            #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
            let mut cmd = sidecar
                .current_dir(std::path::PathBuf::from(&server_dir))
                .env("PORT", port.to_string())
                .env("HOSTNAME", bind_host)
                .env("ARGO_LOCAL_BIND_PROOF", local_bind_proof(bind_host))
                .env("ARGO_ROOT", format!("{data_root}/workspaces"))
                .env("ARGO_STANDALONE", "1")
                .env("NODE_ENV", "production")
                // 부모 감시 — 서버가 이 PID(셸)를 지켜보다 사라지면 스스로 종료(고아 방지)
                .env("ARGO_PARENT_PID", std::process::id().to_string());
            // macOS Dock 아이콘 억제 — 번들 node는 process.title을 설정하는 순간 Foreground 앱으로 등록돼 Dock에 뜬다
            // (실측 2026-09-15: 같은 코드도 시스템 node는 BackgroundOnly, 앱 번들 안 node만 Foreground). 서버 자신은 server.js
            // 부트스트랩이 막지만, 서버가 띄우는 node 자식(npm exec·MCP 서버·CLI 러너)은 상속 env로만 막을 수 있다.
            // 런타임 setupNoDock(프로브 뒤 대입)의 실패·타임아웃에 걸리지 않게 **초기 env**에 프리로드를 넣는다(유건 지시
            // "언제가 됐든 뜨면 안 돼"). 심은 ~/.argo/tools에 복사해 가리킨다(no_dock_node_options). 실패는 경고만 — 그때는 런타임 경로가 프로브를 거쳐 재시도한다.
            #[cfg(target_os = "macos")]
            match no_dock_node_options(&server_dir, handle.path().home_dir().ok()) {
                Ok(v) => cmd = cmd.env("NODE_OPTIONS", v),
                Err(e) => log::warn!("[argo] Dock 아이콘 억제 프리로드 미적용(자식 node가 Dock에 뜰 수 있다): {e}"),
            }
            let child = cmd
                // 상대경로 — current_dir(server_dir) 기준. 절대경로 조합은 Windows UNC에서 깨진다.
                .args(["server.js"])
                .spawn();
            match child {
                Ok((mut rx, child)) => {
                    log::info!("[argo] 회사 서버 사이드카 기동 (포트 {port})");
                    boot_status(&handle, "started", "local server process launched", Some(port));
                    // 종료 시 kill할 수 있게 보관
                    if let Some(st) = handle.try_state::<Sidecar>() {
                        *st.0.lock().unwrap() = Some(child);
                    }
                    let started = std::time::Instant::now();
                    let mut early_exit: Option<String> = None;
                    // 진짜 원인 — stderr에서 "Error"/⨯를 포함한 **첫** 줄만(2R 실측: 마지막 줄 캡처는
                    // Next 에러 덤프의 닫는 중괄호 `}`만 실었고, stdout 공용 캡처는 스트림 순서 미보장).
                    let mut err_cause = String::new();
                    while let Some(ev) = rx.recv().await {
                        match ev {
                            CommandEvent::Stderr(line) => {
                                let s = String::from_utf8_lossy(&line).trim_end().to_string();
                                if err_cause.is_empty() && (s.contains("Error") || s.contains('⨯')) {
                                    err_cause = s.chars().take(180).collect();
                                }
                                log::info!("[server] {s}");
                                let _ = handle.emit("boot-log", &s);
                            }
                            CommandEvent::Stdout(line) => {
                                let s = String::from_utf8_lossy(&line).trim_end().to_string();
                                log::info!("[server] {s}");
                                // 부트 화면 로그 테일 — 느릴 때 무엇을 하는지 보여준다
                                let _ = handle.emit("boot-log", &s);
                            }
                            CommandEvent::Error(e) => {
                                boot_status(&handle, "error", &format!("server error: {e}"), Some(port));
                            }
                            CommandEvent::Terminated(t) => {
                                let code = t.code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
                                // 즉사(<5s + 비정상 코드)만 폴백 대상 — 정상 서비스 중 사망은 기존대로 알린다
                                if t.code.map_or(false, |c| c != 0) && started.elapsed() < Duration::from_secs(5) {
                                    early_exit = Some(code);
                                } else {
                                    // 정상/지연 종료 — 이 경로는 재스폰이 없다(종결). 2R H2.
                                    boot_error_final(&handle, &format!("server exited (code {code})"), Some(port));
                                }
                            }
                            _ => {}
                        }
                    }
                    let Some(code) = early_exit else { return };
                    // 폴백 전 adopt 재확인 — 두 인스턴스가 동시에 폴백하면 진 쪽이 다음 포트에
                    // 자기 서버를 또 띄워 같은 ARGO_ROOT에 같은 버전 서버 2개(스케줄러·동기화
                    // 이중 구동)가 된다(검수 1R 차단 지적 — 이 PR 전에는 없던 회귀 방향).
                    if let Some(p) = PORTS.iter().copied().find(|&p| tcp_open(p) && is_same_version_argo(p)) {
                        log::info!("[argo] 폴백 중 같은 버전 Argo 발견(포트 {p}) — 스폰 대신 입양");
                        boot_status(&handle, "started", "server already running", Some(p));
                        return;
                    }
                    match pick_boot_port(keep_free, &tried, tcp_open, can_bind) {
                        Some(n) => {
                            log::warn!("[argo] 포트 {port} 사이드카 즉사(code {code}) — {n}으로 폴백");
                            boot_status(&handle, "starting", &format!("server died instantly on port {port} (code {code}) — retrying on port {n}"), Some(n));
                            port = n;
                            continue;
                        }
                        None => {
                            let tail = if err_cause.is_empty() { String::new() } else { format!(" | cause: {err_cause}") };
                            boot_error_final(&handle, &format!("server exited immediately on every usable port (last code {code}) — {}{tail}", reserved_hint()), Some(port));
                            return;
                        }
                    }
                }
                Err(e) => {
                    log::error!("[argo] 서버 사이드카 기동 실패: {e}");
                    boot_error_final(&handle, &format!("failed to launch server: {e}"), Some(port)); // 종결 — 재스폰 없음(2R H2)
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn file_route_navigation_is_blocked_but_other_pages_are_not() {
        let u = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(is_file_route_nav(&u("http://localhost:3001/api/companies/lean-ax-wqou/files?rel=a.png&download=1")));
        assert!(is_file_route_nav(&u("http://127.0.0.1:3011/api/companies/w/vault?rel=x.md&format=docx")));
        assert!(!is_file_route_nav(&u("http://localhost:3001/c/lean-ax-wqou/crew/pepper")));
        assert!(!is_file_route_nav(&u("http://localhost:3001/api/me/billing/portal")));
        assert!(!is_file_route_nav(&u("https://example.com/api/companies/w/files")));
        assert!(!is_file_route_nav(&u("http://localhost:3001/api/companies/w/files?rel=a.pdf&inline=1")), "PDF 미리보기 iframe은 통과");
    }

    use super::*;
    #[test]
    fn adoption_rejects_same_version_without_current_dock_protocol() {
        for (protocol, expected) in [("", false), (",\"dockProtocol\":0", false), (",\"dockProtocol\":10", false), (",\"dockProtocol\":1", true)] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let body = format!("{{\"argo\":true,\"version\":\"{}\"{protocol}}}", env!("CARGO_PKG_VERSION"));
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = [0; 512];
                let _ = socket.read(&mut request);
                let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                socket.write_all(response.as_bytes()).unwrap();
            });
            assert_eq!(is_same_version_argo(port), expected);
            server.join().unwrap();
        }
    }

    #[test]
    fn local_asset_proof_follows_actual_bind() {
        assert_eq!(local_bind_proof("127.0.0.1"), "127.0.0.1");
        assert_eq!(local_bind_proof("::1"), "::1");
        assert_eq!(local_bind_proof("0.0.0.0"), "");
        assert_eq!(local_bind_proof(""), "");
    }
    // can_bind — 점유 포트에서 false, 해제 후 true (Hyper-V 예약 대역은 CI/mac에서 재현 불가 —
    // 그 케이스는 Windows 커널이 EACCES를 주므로 같은 is_ok() 판정으로 걸러진다. 신고 2026-07-27)
    #[test]
    fn pick_spawn_port_skips_tried_open_and_unbindable() {
        // 3001 예약(bind 불가)·3011 tried → 3021 (신고 시나리오의 폴백 경로)
        assert_eq!(pick_spawn_port(&[3011], |_| false, |p| p != 3001), Some(3021));
        // 열려 있는 포트(타 앱·타 버전 Argo)는 스폰 후보가 아니다
        assert_eq!(pick_spawn_port(&[], |p| p == 3001, |_| true), Some(3011));
        // 전부 소진 → None (무한 루프 없음)
        assert_eq!(pick_spawn_port(&[3001, 3011, 3021], |_| false, |_| true), None);
        // 전부 bind 불가(Hyper-V 대역이 3000번대 전체를 덮은 경우) → None
        assert_eq!(pick_spawn_port(&[], |_| false, |_| false), None);
    }

    // ── 상주 대기(2026-10-08 실사고: 재시동 직후 앱이 3001을 먼저 차지 → 상주 2시간 50분 EADDRINUSE) ──
    use super::PortState::{Closed, Other, SameArgo, Silent};
    const SECOND: Duration = Duration::from_secs(1);

    /// 가짜 시계로 settle_boot를 돌린다 — state_at(경과, 포트)가 그 순간 포트 상태. (결정, 결정 시각, 쉰 횟수)
    fn settle_with(resident: Option<u16>, state_at: impl Fn(Duration, u16) -> PortState) -> (Boot, Duration, u32) {
        let now = std::cell::Cell::new(Duration::ZERO);
        let pauses = std::cell::Cell::new(0u32);
        let boot = settle_boot(resident, |p| state_at(now.get(), p), || now.get(), || {
            pauses.set(pauses.get() + 1);
            now.set(now.get() + RESIDENT_POLL);
            assert!(now.get() < 120 * SECOND, "대기가 끝나지 않는다");
        });
        (boot, now.get(), pauses.get())
    }
    fn only(port: u16, state: PortState) -> impl Fn(u16) -> PortState {
        move |p| if p == port { state } else { Closed }
    }

    #[test]
    fn resident_up_same_version_is_adopted_without_waiting() {
        let (boot, at, pauses) = settle_with(Some(3001), |_, p| only(3001, SameArgo)(p));
        assert_eq!((boot, at, pauses), (Boot::Adopt(3001), Duration::ZERO, 0));
    }

    #[test]
    fn resident_still_starting_is_waited_for_then_adopted() {
        // 이 맥의 최악 실측 그대로: 포트 닫힘 16초(launchd 기동 지연) → 답 없음 37초(next 준비) → 같은 버전 응답.
        let ready = 16 * SECOND + 37 * SECOND;
        let (boot, at, _) = settle_with(Some(3001), |t, p| {
            if p != 3001 || t < 16 * SECOND { Closed } else if t < ready { Silent } else { SameArgo }
        });
        assert_eq!(boot, Boot::Adopt(3001), "구 코드는 t=0에 3001로 스폰했다(사고 경로)");
        assert!(at >= ready && at < ready + RESIDENT_POLL, "준비된 다음 간격에 붙는다: {at:?}");
    }

    #[test]
    fn resident_never_binding_gives_up_after_closed_limit_and_keeps_its_port_free() {
        let (boot, at, _) = settle_with(Some(3001), |_, _| Closed);
        assert_eq!(boot, Boot::Spawn { keep_free: Some(3001) });
        assert!(at >= RESIDENT_WAIT_CLOSED && at < RESIDENT_WAIT_CLOSED + RESIDENT_POLL, "{at:?}");
        assert_eq!(pick_boot_port(Some(3001), &[], |_| false, |_| true), Some(3011), "상주 자리 3001은 비워 둔다");
    }

    #[test]
    fn resident_bound_but_silent_is_waited_up_to_ready_limit() {
        let (boot, at, _) = settle_with(Some(3001), |_, p| only(3001, Silent)(p));
        assert_eq!(boot, Boot::Spawn { keep_free: Some(3001) });
        assert!(at >= RESIDENT_WAIT_SILENT && at < RESIDENT_WAIT_SILENT + RESIDENT_POLL, "{at:?}");
        // 상주가 준비 중에 죽어 다시 닫히면 닫힘 상한(30초)이 이미 지났으니 바로 포기한다.
        assert_eq!(plan_boot(Some(3001), 40 * SECOND, only(3001, Closed)), Some(Boot::Spawn { keep_free: Some(3001) }));
    }

    #[test]
    fn resident_other_version_coexists_without_waiting() {
        let (boot, at, pauses) = settle_with(Some(3001), |_, p| only(3001, Other)(p));
        assert_eq!((boot, at, pauses), (Boot::Spawn { keep_free: None }, Duration::ZERO, 0));
        assert_eq!(pick_boot_port(None, &[], |p| p == 3001, |_| true), Some(3011), "열린 3001(다른 버전 상주)은 건너뛴다");
    }

    #[test]
    fn no_resident_is_unchanged_no_wait_and_3001_first() {
        for state in [Closed, Silent, Other] {
            let (boot, at, pauses) = settle_with(None, |_, p| only(3001, state)(p));
            assert_eq!((boot, at, pauses), (Boot::Spawn { keep_free: None }, Duration::ZERO, 0), "{state:?}");
        }
        assert_eq!(pick_boot_port(None, &[], |_| false, |_| true), Some(3001));
        // 같은 버전 Argo가 다른 후보에 있으면 지금처럼 그 포트에 붙는다.
        assert_eq!(plan_boot(None, Duration::ZERO, only(3011, SameArgo)), Some(Boot::Adopt(3011)));
    }

    #[test]
    fn resident_outside_candidate_ports_does_not_wait() {
        // service.mjs 기본 포트(3999)는 앱 후보와 겹치지 않는다 — 다툴 자리가 없으니 기다리지 않는다.
        let (boot, _, pauses) = settle_with(Some(3999), |_, _| Closed);
        assert_eq!((boot, pauses), (Boot::Spawn { keep_free: None }, 0));
    }

    #[test]
    fn all_ports_taken_still_reports_no_port() {
        let (boot, _, pauses) = settle_with(Some(3001), |_, _| Other);
        assert_eq!((boot, pauses), (Boot::Spawn { keep_free: None }, 0));
        assert_eq!(pick_boot_port(None, &[], |_| true, |_| true), None, "→ 'all taken' 종결 에러(기존)");
    }

    #[test]
    fn resident_port_is_last_resort_when_nothing_else_is_usable() {
        assert_eq!(pick_boot_port(Some(3001), &[], |p| p != 3001, |_| true), Some(3001), "못 뜨는 것보다 상주 자리라도 쓴다");
        // 즉사 폴백 루프도 상주 자리를 맨 뒤로 미룬다.
        assert_eq!(pick_boot_port(Some(3001), &[3011], |_| false, |_| true), Some(3021));
        assert_eq!(pick_boot_port(Some(3001), &[3011, 3021], |_| false, |_| true), Some(3001));
        assert_eq!(pick_boot_port(Some(3001), &[3001, 3011, 3021], |_| false, |_| true), None);
    }

    // scripts/service.mjs darwinInstall이 쓰는 plist 모양 그대로.
    fn service_plist(args: &str) -> String {
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>com.beyondworks.argo</string>\n  <key>ProgramArguments</key><array>\n    {args}\n  </array>\n  <key>EnvironmentVariables</key><dict>\n    <key>PORT</key><string>4444</string>\n  </dict>\n</dict></plist>\n")
    }

    #[test]
    fn resident_port_is_read_from_launch_agent_arguments() {
        let next = "<string>/usr/local/bin/node</string><string>/x/node_modules/next/dist/bin/next</string><string>start</string><string>-H</string><string>127.0.0.1</string>";
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>-p</string><string>3001</string>"))), Some(3001));
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>-p</string><string>3999</string>"))), Some(3999));
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>--port=3011</string>"))), Some(3011));
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>--port</string><string>3021</string>"))), Some(3021));
        assert_eq!(resident_port_from_plist(&service_plist(next)), None, "-p 없음(EnvironmentVariables는 인자가 아니다)");
        assert_eq!(resident_port_from_plist(&service_plist(&format!("{next}<string>-p</string>"))), None);
        assert_eq!(resident_port_from_plist("<plist><dict></dict></plist>"), None);
    }

    #[test]
    fn installed_resident_port_reads_the_macos_launch_agent_only() {
        let home = std::env::temp_dir().join(format!("argo-resident-home-{}", std::process::id()));
        let agents = home.join("Library/LaunchAgents");
        std::fs::create_dir_all(&agents).unwrap();
        assert_eq!(installed_resident_port(Some(home.clone())), None, "plist 없음 = 상주 미설치");
        std::fs::write(agents.join("com.beyondworks.argo.plist"), service_plist("<string>next</string><string>start</string><string>-p</string><string>3001</string>")).unwrap();
        let got = installed_resident_port(Some(home.clone()));
        std::fs::remove_dir_all(&home).unwrap();
        assert_eq!(got, if cfg!(target_os = "macos") { Some(3001) } else { None }, "Windows·Linux는 판정하지 않는다(기존 동작)");
        assert_eq!(installed_resident_port(None), None);
    }

    #[test]
    fn ping_body_classification() {
        let v = env!("CARGO_PKG_VERSION");
        assert_eq!(classify_ping(&format!("{{\"argo\":true,\"version\":\"{v}\",\"dockProtocol\":1}}")), SameArgo);
        assert_eq!(classify_ping("{\"argo\":true,\"version\":\"0.0.0-other\",\"dockProtocol\":1}"), Other);
        assert_eq!(classify_ping("HTTP/1.1 404 Not Found\r\n\r\nCannot GET /api/ping"), Other);
        assert_eq!(classify_ping(""), Other);
    }

    #[test]
    fn probe_tells_closed_silent_and_hang_up_apart() {
        // 닫힘 — 아무도 듣지 않는 포트
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert_eq!(probe_port(port), Closed);
        // 답 없음 — 받기만 하고 응답하지 않는다(next start 준비 중과 같은 모양)
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let held = std::thread::spawn(move || { let (s, _) = l.accept().unwrap(); std::thread::sleep(Duration::from_millis(1500)); drop(s); });
        assert_eq!(probe_port(port), Silent);
        held.join().unwrap();
        // 바로 끊음 — 기동 중이 아니다(기다리지 않는다)
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let hang = std::thread::spawn(move || { let (mut s, _) = l.accept().unwrap(); let _ = s.read(&mut [0; 512]); drop(s); });
        assert_eq!(probe_port(port), Other);
        hang.join().unwrap();
    }

    #[test]
    fn can_bind_detects_occupied_and_freed_port() {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(!can_bind(port), "LISTEN 중인 포트는 bind 불가여야 한다");
        drop(l);
        assert!(can_bind(port), "해제된 포트는 bind 가능해야 한다");
    }
}
