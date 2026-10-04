// ios-webview — iOS 전용. 키보드 위 폼 보조 막대(↑↓✓)를 숨기고(플러그인이 실릴 때 한 번), 네이티브 웹뷰 바탕을 테마 색으로 바꾼다.
// Tauri의 웹뷰 바탕 명령(set_webview_background_color)은 데스크톱에만 등록돼 iOS에서는 호출이 조용히 실패했다(tauri 2.11 webview/plugin.rs).
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "ios")]
use tauri::Manager;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ios_webview);

#[cfg(target_os = "ios")]
mod ios {
    use serde::Serialize;
    use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

    pub struct IosWebview<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    struct BackgroundArgs {
        red: u8,
        green: u8,
        blue: u8,
    }

    /// 웹뷰·스크롤 뷰·페이지 밖 영역·부모 뷰·창 바탕을 같은 색으로. JS는 src/webview-bg.js만 부른다.
    #[tauri::command]
    pub async fn set_background<R: Runtime>(app: AppHandle<R>, red: u8, green: u8, blue: u8) -> Result<(), String> {
        app.state::<IosWebview<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>("setBackground", BackgroundArgs { red, green, blue })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("ios-webview");
    #[cfg(target_os = "ios")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![ios::set_background])
        .setup(|app, api| {
            let handle = api.register_ios_plugin(init_plugin_ios_webview)?;
            app.manage(ios::IosWebview(handle));
            Ok(())
        });
    builder.build()
}
