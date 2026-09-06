// Argo 메신저 셸 — 사이드카 없음(Argo 앱과 달리 로컬 서버를 띄우지 않는다). 프론트(Vite 정적 dist)가 Supabase에 직결.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
