// Argo 메신저 셸 — 사이드카 없음(Argo 앱과 달리 로컬 서버를 띄우지 않는다). 프론트(Vite 정적 dist)가 Supabase에 직결.
//
// 로그인 브리지(pair.rs): 웹뷰는 Google·GitHub 창을 못 띄우므로(임베디드 웹뷰 차단) 앱이 루프백에 일회용 HTTP 서버를
// 열어 진짜 브라우저를 그리로 돌려받는다. Argo 앱의 /api/auth/pair·/auth/paired와 같은 계약을 셸 안에 담은 것이다 —
// 메신저는 Next 서버가 없고(argo.ceo는 랜딩), 셀프호스트에도 서버 의존이 0이어야 한다.
mod pair;
mod agents; // 외부 에이전트 원클릭 연결(헤르메스·오픈클로 플러그인 설치·설정·게이트웨이)

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![pair::pair_start, pair::pair_claim, agents::agent_connect, agents::agent_list])
        .setup(|app| {
            // 인앱 업데이터 + 설치 뒤 재시작 — 데스크톱만(모바일 타깃에는 크레이트 자체가 없다)
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Argo Messenger");
}
