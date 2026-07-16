// Argo 데스크톱 셸 — 앱 실행 = 회사 서버 자동 기동.
// 번들에 내장된 Node + Next standalone 서버를 사이드카로 띄운다. 이미 3001이 떠 있으면(상주
// 서비스·개발 서버) 스폰하지 않는다. 서버가 준비되면 프론트(public/index.html)가 3001로 이어진다.
use std::net::TcpStream;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

const PORT: u16 = 3001;

fn port_open() -> bool {
    TcpStream::connect_timeout(&(([127, 0, 0, 1], PORT).into()), Duration::from_millis(300)).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init()) // 앱에서 외부 브라우저 열기(로그인 핸드오프)
        .setup(|app| {
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
            if !port_open() {
                let handle = app.handle().clone();
                // 데이터 루트 = OS 앱 로컬 데이터 폴더. 여기 workspaces/ 아래 회사 폴더가 쌓인다.
                let data_root = app
                    .path()
                    .app_local_data_dir()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                // 번들 리소스의 standalone 서버 경로
                let server_dir = app
                    .path()
                    .resolve("server", tauri::path::BaseDirectory::Resource)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                tauri::async_runtime::spawn(async move {
                    let sidecar = match handle.shell().sidecar("node") {
                        Ok(c) => c,
                        Err(e) => { log::error!("[argo] node 사이드카 없음: {e}"); return; }
                    };
                    let child = sidecar
                        .current_dir(std::path::PathBuf::from(&server_dir))
                        .env("PORT", PORT.to_string())
                        .env("HOSTNAME", "127.0.0.1")
                        .env("ARGO_ROOT", format!("{data_root}/workspaces"))
                        .env("ARGO_STANDALONE", "1")
                        .env("NODE_ENV", "production")
                        .args([format!("{server_dir}/server.js")])
                        .spawn();
                    match child {
                        Ok((mut rx, _child)) => {
                            log::info!("[argo] 회사 서버 사이드카 기동 (포트 {PORT})");
                            while let Some(ev) = rx.recv().await {
                                if let CommandEvent::Stderr(line) | CommandEvent::Stdout(line) = ev {
                                    log::info!("[server] {}", String::from_utf8_lossy(&line).trim_end());
                                }
                            }
                        }
                        Err(e) => log::error!("[argo] 서버 사이드카 기동 실패: {e}"),
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
