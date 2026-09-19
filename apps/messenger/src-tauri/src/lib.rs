// Argo 메신저 셸 — 사이드카 없음(Argo 앱과 달리 로컬 서버를 띄우지 않는다). 프론트(Vite 정적 dist)가 Supabase에 직결.
//
// 로그인 브리지(pair.rs): 웹뷰는 Google·GitHub 창을 못 띄우므로(임베디드 웹뷰 차단) 앱이 루프백에 일회용 HTTP 서버를
// 열어 진짜 브라우저를 그리로 돌려받는다. Argo 앱의 /api/auth/pair·/auth/paired와 같은 계약을 셸 안에 담은 것이다 —
// 메신저는 Next 서버가 없고(argo.ceo는 랜딩), 셀프호스트에도 서버 의존이 0이어야 한다.
#[cfg(desktop)]
mod pair;
#[cfg(desktop)]
mod agents; // 외부 에이전트 원클릭 연결(헤르메스·오픈클로 플러그인 설치·설정·게이트웨이)
#[cfg(target_os = "macos")]
mod notify_mac; // OS 알림 — UNUserNotificationCenter 직결(플러그인의 폐기 API 경로 대체)

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_notification::init());
    // 창 위치·크기 기억(D53, 설치본 T8: 옮긴 창이 재실행 때 기본 자리로 돌아갔다). 표시 여부(VISIBLE)는 저장하지 않는다 —
    // 닫기가 가리기라 숨긴 채 ⌘Q하면 다음 실행에 창이 안 보이는 채로 뜬다. 빌더에 달아야 설정 파일로 만든 main 창에도 복원이 걸린다.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default()
        .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE).build());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_push_notifications::init()); // APNs·FCM 기기 토큰 + 알림 탭 — 발송은 서버(msgr-push)
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_web_auth::init());
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        pair::pair_start, pair::pair_claim, agents::agent_connect, agents::agent_list,
        notify_mac::notify_status, notify_mac::notify_request, notify_mac::notify_send
    ]);
    #[cfg(all(desktop, not(target_os = "macos")))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![pair::pair_start, pair::pair_claim, agents::agent_connect, agents::agent_list]);
    builder
        // macOS: 창 닫기(빨간 버튼·cmd+W) = 앱 가리기 — Argo 본체·Claude Desktop과 같은 관례(유건 요청 2026-09-15).
        // NSApp hide라 독 아이콘이 남고, 독 클릭이 OS 표준 unhide로 창을 복원한다(별도 Reopen 코드 불요).
        // cmd+Q·메뉴 Quit은 CloseRequested가 아니라 ExitRequested 경로라 그대로 종료. 가려진 동안에도 알림·푸시 토큰·업데이트 확인은 계속 돈다.
        // Windows/Linux는 기본 동작 유지(트레이가 없어 숨기면 복귀 수단이 없다 — 트레이 도입 시 재검토). 모바일은 창 닫기 개념이 없다.
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = tauri::Manager::app_handle(window).hide();
                api.prevent_close();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .setup(|_app| {
            // 앱이 앞에 있어도 다른 방 알림 배너를 띄운다(UN 기본은 전면 앱 알림을 숨김) — 번들 밖(cargo run)이면 조용히 건너뛴다
            #[cfg(target_os = "macos")]
            if let Some(mtm) = objc2::MainThreadMarker::new() { notify_mac::install_delegate(mtm); }
            // 인앱 업데이터 + 설치 뒤 재시작 — 데스크톱만(모바일 타깃에는 크레이트 자체가 없다)
            #[cfg(desktop)]
            {
                _app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                _app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Argo Messenger");
}
