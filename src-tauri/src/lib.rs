// Argo 데스크톱 셸 — 앱 실행 = 회사 서버 자동 기동.
// 번들에 내장된 Node + Next standalone 서버를 사이드카로 띄운다. 포트에 이미 뜬 서버는 /api/ping
// 신원 마커로 "진짜 Argo인가"를 확인한 뒤에만 붙는다(실사용 2026-07-20: 타 앱이 3001을 선점한
// Windows에서 TCP 열림만 보고 낯선 Express 서버에 웹뷰가 붙어 "Cannot GET /" 표시 — 사이드카는
// 아예 안 떴다). Argo가 아니면 다음 후보 포트로 폴백해 스폰하고, 선택 포트를 boot 이벤트로
// 프론트(public/boot.js)에 알린다.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

// 부트 화면(public/index.html)에 실시간 상태를 알린다 — 실패도 화면에 보이게(무한 대기 방지).
// port: 프론트가 이동할 서버 포트(선택 확정 후) — boot.js가 후보 목록 맨 앞에 넣는다.
fn boot_status(app: &tauri::AppHandle, phase: &str, detail: &str, port: Option<u16>) {
    // version — boot.js가 프로브 시 "같은 버전의 Argo인가"를 대조한다(아래 is_same_version_argo와 한 쌍).
    let _ = app.emit("boot", serde_json::json!({ "phase": phase, "detail": detail, "port": port, "version": env!("CARGO_PKG_VERSION") }));
}

// 포트 후보 — 3001(상주 서비스·기존 관례) 우선, 선점 시 폴백. boot.js의 후보 목록과 일치해야 한다.
const PORTS: [u16; 3] = [3001, 3011, 3021];

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

// 이 포트의 서버가 "같은 버전의" Argo인가 — /api/ping 신원 마커 + 버전을 최소 HTTP로 확인.
// TCP 열림 ≠ Argo(타 앱 선점·좀비) — 신원 확인 없이는 붙지도, 그 포트를 쓰지도 않는다.
// 버전 대조(2026-07-22 실사용 신고): 버전 불문 adopt는 앱(쉘) 버전과 화면(UI) 버전을 어긋나게 한다 —
// v0.1.20 앱이 상주 v0.1.22 서버에 붙어 "업데이트 안 했는데 다음 버전이 표시"되고, 업데이트 뱃지도
// 무의미해진다. 같은 버전일 때만 붙고(같은 앱 이중 실행 방지라는 원 목적), 다르면 자기 사이드카를
// 다음 빈 포트에 띄운다(상주 서버는 건드리지 않는다).
fn is_same_version_argo(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else { return false };
    let _ = s.set_write_timeout(Some(Duration::from_millis(300)));
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    let req = format!("GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() { return false; }
    let mut buf = Vec::new();
    let _ = s.take(16_384).read_to_end(&mut buf); // 타임아웃/조기 종료여도 읽힌 만큼 판정
    let text = String::from_utf8_lossy(&buf);
    let is_argo = text.contains("\"argo\":true") || text.contains("\"argo\": true");
    let same_ver = text.contains(&format!("\"version\":\"{}\"", env!("CARGO_PKG_VERSION")))
        || text.contains(&format!("\"version\": \"{}\"", env!("CARGO_PKG_VERSION")));
    is_argo && same_ver
}

// Windows 리소스 경로의 \\?\ (UNC) 프리픽스 제거 — node가 스크립트 경로 인자로 받지 못해
// 사이드카가 침묵 사망한다 (실측: 같은 서버를 수동 실행하면 578ms에 정상 기동).
fn de_unc(p: String) -> String {
    p.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(p)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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

            // 포트 결정 — ① 후보 중 "같은 버전의" Argo가 떠 있으면 그 포트에 붙는다(같은 앱 이중 기동 방지)
            // ② 아니면 첫 빈 포트에 사이드카 스폰(다른 버전의 상주 Argo는 그대로 두고 공존)
            // ③ 전부 타 앱 점유면 명확한 에러(낯선 서버 부착·무한 대기 방지).
            // 주의(TCC, 분리 검수 M4): ①입양 경로에선 서버가 앱의 자식이 아니라(예: launchd 상주)
            // macOS 폴더 접근 프롬프트가 이 앱 번들(Info.plist 문구·부여 권한)로 귀속되지 않는다.
            // dmg 일반 사용자는 항상 ②스폰 경로라 무영향 — 상주 서버를 쓰는 개발 환경에서
            // "프롬프트가 안 뜬다"고 plist 병합 실패로 오진하지 말 것.
            let adopt = PORTS.iter().copied().find(|&p| tcp_open(p) && is_same_version_argo(p));
            // 빈 포트 판정 = connect 안 됨 **그리고 bind 됨** — connect만 보면 Hyper-V 예약 포트를
            // "빈 포트"로 오판해 스폰 즉사(실사용 신고 2026-07-27).
            let spawn_port = if adopt.is_none() { pick_spawn_port(&[], tcp_open, can_bind) } else { None };
            if let Some(p) = adopt {
                boot_status(app.handle(), "started", "server already running", Some(p));
            } else if spawn_port.is_none() {
                // 원인을 갈라 알린다 — 타 앱 점유(전부 TCP 열림)와 커널 예약(닫혀 있는데 bind 불가)은
                // 사용자가 취할 행동이 다르다(전자=앱 종료, 후자=winnat 재시작).
                let all_taken = PORTS.iter().copied().all(tcp_open);
                let msg = if all_taken {
                    "ports 3001/3011/3021 are all taken by other apps — close them (or restart this computer) and reopen Argo".to_string()
                } else {
                    format!("no usable port among 3001/3011/3021 — {}", reserved_hint())
                };
                boot_error_final(app.handle(), &msg, None);
            } else {
                let port = spawn_port.unwrap();
                let handle = app.handle().clone();
                boot_status(&handle, "starting", "launching local server", Some(port));
                // 데이터 루트 = OS 앱 로컬 데이터 폴더. 여기 workspaces/ 아래 회사 폴더가 쌓인다.
                let data_root = de_unc(app
                    .path()
                    .app_local_data_dir()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default());
                // 번들 리소스의 standalone 서버 경로
                let server_dir = de_unc(app
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
                        let child = sidecar
                            .current_dir(std::path::PathBuf::from(&server_dir))
                            .env("PORT", port.to_string())
                            .env("HOSTNAME", "127.0.0.1")
                            .env("ARGO_ROOT", format!("{data_root}/workspaces"))
                            .env("ARGO_STANDALONE", "1")
                            .env("NODE_ENV", "production")
                            // 부모 감시 — 서버가 이 PID(셸)를 지켜보다 사라지면 스스로 종료(고아 방지)
                            .env("ARGO_PARENT_PID", std::process::id().to_string())
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
                                match pick_spawn_port(&tried, tcp_open, can_bind) {
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

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn can_bind_detects_occupied_and_freed_port() {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(!can_bind(port), "LISTEN 중인 포트는 bind 불가여야 한다");
        drop(l);
        assert!(can_bind(port), "해제된 포트는 bind 가능해야 한다");
    }
}
