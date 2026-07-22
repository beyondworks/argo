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
            let adopt = PORTS.iter().copied().find(|&p| tcp_open(p) && is_same_version_argo(p));
            let spawn_port = if adopt.is_none() { PORTS.iter().copied().find(|&p| !tcp_open(p)) } else { None };
            if let Some(p) = adopt {
                boot_status(app.handle(), "started", "server already running", Some(p));
            } else if spawn_port.is_none() {
                // TCP는 열려 있는데 어느 것도 Argo가 아님 — 예전 코드는 여기서 낯선 서버에 붙어
                // "Cannot GET /"를 띄웠다(실사용 2026-07-20). 이제 정직하게 실패를 알린다.
                boot_status(app.handle(), "error",
                    "ports 3001/3011/3021 are all taken by other apps — close them (or restart this computer) and reopen Argo", None);
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
                    let sidecar = match handle.shell().sidecar("node") {
                        Ok(c) => c,
                        Err(e) => {
                            log::error!("[argo] node 사이드카 없음: {e}");
                            boot_status(&handle, "error", &format!("node sidecar missing: {e}"), Some(port));
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
                            while let Some(ev) = rx.recv().await {
                                match ev {
                                    CommandEvent::Stderr(line) | CommandEvent::Stdout(line) => {
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
                                        boot_status(&handle, "error", &format!("server exited (code {code})"), Some(port));
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("[argo] 서버 사이드카 기동 실패: {e}");
                            boot_status(&handle, "error", &format!("failed to launch server: {e}"), Some(port));
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
