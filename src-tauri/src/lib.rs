// Argo 데스크톱 셸 — 앱 실행 = 회사 서버 자동 기동.
// 번들에 내장된 Node + Next standalone 서버를 사이드카로 띄운다. 포트에 이미 뜬 서버는 /api/ping
// 신원 마커로 "진짜 Argo인가"를 확인한 뒤에만 붙는다(실사용 2026-07-20: 타 앱이 3001을 선점한
// Windows에서 TCP 열림만 보고 낯선 Express 서버에 웹뷰가 붙어 "Cannot GET /" 표시 — 사이드카는
// 아예 안 떴다). Argo가 아니면 다음 후보 포트로 폴백해 스폰하고, 선택 포트를 boot 이벤트로
// 프론트(public/boot.js)에 알린다.
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
// 포트 결정(입양·상주 대기·스폰 포트) — tauri 없이 표준 라이브러리만 써서 CI가 따로 컴파일해 테스트한다.
mod boot_port;
use boot_port::{can_bind, is_same_version_argo, probe_port, tcp_open, Boot, BootPlanner, SpawnPlan, PORTS, RESIDENT_POLL};
#[cfg(target_os = "macos")]
mod no_dock;
mod update_notes;
mod update_location;

// 부트 화면(public/index.html)에 실시간 상태를 알린다 — 실패도 화면에 보이게(무한 대기 방지).
// port: 프론트가 이동할 서버 포트(선택 확정 후) — boot.js가 후보 목록 맨 앞에 넣는다.
fn boot_status(app: &tauri::AppHandle, phase: &str, detail: &str, port: Option<u16>) {
    // version — boot.js가 프로브 시 "같은 버전의 Argo인가"를 대조한다(boot_port::is_same_version_argo와 한 쌍).
    let _ = app.emit("boot", serde_json::json!({ "phase": phase, "detail": detail, "port": port, "version": env!("CARGO_PKG_VERSION") }));
}

// Recomputed from the actual sidecar bind, never inherited from the parent.
fn local_bind_proof(host: &str) -> &str {
    match host { "127.0.0.1" | "::1" | "localhost" => host, _ => "" }
}

// 앱이 띄운 사이드카 핸들 — 종료 시 함께 죽인다.
// (실측: Windows에서 앱을 닫아도 node가 고아로 남아 3001을 점유 → 다음 실행이 구버전/죽은 서버에 붙는다)
struct Sidecar(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

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

            // 포트 결정 — boot_port::BootPlanner::step 주석 참고. 상주가 없으면 지금과 같이 여기서 바로 정한다.
            // 주의(TCC, 분리 검수 M4): 입양 경로에선 서버가 앱의 자식이 아니라(예: launchd 상주)
            // macOS 폴더 접근 프롬프트가 이 앱 번들(Info.plist 문구·부여 권한)로 귀속되지 않는다.
            // dmg 일반 사용자는 항상 스폰 경로라 무영향 — 상주 서버를 쓰는 개발 환경에서
            // "프롬프트가 안 뜬다"고 plist 병합 실패로 오진하지 말 것.
            let handle = app.handle().clone();
            let boot_started = Instant::now();
            let mut planner = BootPlanner::for_home(app.path().home_dir().ok());
            match planner.step(Duration::ZERO, probe_port) {
                Some(boot) => start_boot(&handle, boot),
                // 상주가 아직 안 떴거나 준비 중(실사고 2026-10-08: 재시동 직후 앱이 먼저 3001을 차지해 상주가 2시간 50분
                // EADDRINUSE 재시작). 설정 단계를 붙잡으면 창이 늦게 뜨므로 별도 스레드에서 기다린다. 매 간격 상태를
                // 다시 보낸다 — boot.js의 이벤트 등록이 첫 emit보다 늦어도 버전·문구가 도착한다.
                None => {
                    std::thread::spawn(move || {
                        let boot = planner.settle(probe_port, || boot_started.elapsed(), || {
                            boot_status(&handle, "resident", "waiting for the Argo background service", None);
                            std::thread::sleep(RESIDENT_POLL);
                        });
                        if let Boot::Spawn(plan) = boot {
                            if let Some(r) = plan.keep_free() {
                                log::warn!("[argo] 상주(포트 {r})를 {}초 기다렸지만 같은 버전으로 답하지 않아 앱 서버를 다른 포트에 띄운다", boot_started.elapsed().as_secs());
                            }
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
    let plan = match boot {
        Boot::Adopt(p) => {
            boot_status(handle, "started", "server already running", Some(p));
            return;
        }
        Boot::Spawn(plan) => plan,
    };
    // 빈 포트 판정 = connect 안 됨 **그리고 bind 됨** — connect만 보면 Hyper-V 예약 포트를
    // "빈 포트"로 오판해 스폰 즉사(실사용 신고 2026-07-27).
    let Some(port) = plan.port(&[], tcp_open, can_bind) else {
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
    spawn_sidecar(handle.clone(), plan, port);
}

// 즉사 폴백 루프도 같은 계획(plan)으로 다음 포트를 고른다 — 상주 자리는 마지막 수단.
fn spawn_sidecar(handle: tauri::AppHandle, plan: SpawnPlan, port: u16) {
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
                    match plan.port(&tried, tcp_open, can_bind) {
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
    fn local_asset_proof_follows_actual_bind() {
        assert_eq!(local_bind_proof("127.0.0.1"), "127.0.0.1");
        assert_eq!(local_bind_proof("::1"), "::1");
        assert_eq!(local_bind_proof("0.0.0.0"), "");
        assert_eq!(local_bind_proof(""), "");
    }
    // 포트 결정(입양·상주 대기·스폰 포트) 테스트는 boot_port.rs에 있다 — CI가 그 파일을 따로 컴파일해 돌린다.
}
