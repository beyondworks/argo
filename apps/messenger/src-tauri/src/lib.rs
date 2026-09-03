// Argo 메신저 셸 — 사이드카 없음(Argo 앱과 달리 로컬 서버를 띄우지 않는다). 프론트(Vite 정적 dist)가 Supabase에 직결.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Argo Messenger");
}
