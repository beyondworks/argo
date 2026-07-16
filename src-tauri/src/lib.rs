// Argo 데스크톱 셸 — 앱 실행 = 회사 서버 자동 기동.
// 번들에 내장된 Node + Next standalone 서버를 사이드카로 띄운다. 이미 3001이 떠 있으면(상주
// 서비스·개발 서버) 스폰하지 않는다. 서버가 준비되면 프론트(public/index.html)가 3001로 이어진다.
use std::net::TcpStream;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

// 부트 화면(public/index.html)에 실시간 상태를 알린다 — 실패도 화면에 보이게(무한 대기 방지).
fn boot_status(app: &tauri::AppHandle, phase: &str, detail: &str) {
    let _ = app.emit("boot", serde_json::json!({ "phase": phase, "detail": detail }));
}

const PORT: u16 = 3001;

// 앱이 띄운 사이드카 핸들 — 종료 시 함께 죽인다.
// (실측: Windows에서 앱을 닫아도 node가 고아로 남아 3001을 점유 → 다음 실행이 구버전/죽은 서버에 붙는다)
struct Sidecar(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn port_open() -> bool {
    TcpStream::connect_timeout(&(([127, 0, 0, 1], PORT).into()), Duration::from_millis(300)).is_ok()
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

            // 이미 서버가 떠 있으면(상주 서비스·개발 서버) 스폰하지 않는다 — 이중 기동 방지.
            if port_open() {
                boot_status(app.handle(), "started", "server already running");
            } else {
                let handle = app.handle().clone();
                boot_status(&handle, "starting", "launching local server");
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
                            boot_status(&handle, "error", &format!("node sidecar missing: {e}"));
                            return;
                        }
                    };
                    let child = sidecar
                        .current_dir(std::path::PathBuf::from(&server_dir))
                        .env("PORT", PORT.to_string())
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
                            log::info!("[argo] 회사 서버 사이드카 기동 (포트 {PORT})");
                            boot_status(&handle, "started", "local server process launched");
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
                                        boot_status(&handle, "error", &format!("server error: {e}"));
                                    }
                                    CommandEvent::Terminated(t) => {
                                        let code = t.code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
                                        boot_status(&handle, "error", &format!("server exited (code {code})"));
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("[argo] 서버 사이드카 기동 실패: {e}");
                            boot_status(&handle, "error", &format!("failed to launch server: {e}"));
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
