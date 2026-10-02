// media-share — 모바일(iOS·Android) 첨부 저장·공유. 웹뷰 안에서는 사진 앱 저장·시스템 공유 시트를 부를 수 없다:
// Android WebView는 Web Share API가 없고 <a download>도 처리하지 않으며, iOS WKWebView도 다운로드 위임 없이는 <a download>를 무시한다.
// JS(media-io.js)는 서명 URL·이름·mime만 넘기고, 내려받기·저장·공유는 기기 쪽(ios/·android/)이 한다 — 25MB 바이트를 IPC로 넘기지 않는다.
// 명령: share(공유 시트) · save(사진은 사진 앱/갤러리, 파일은 iOS '파일에 저장'·Android Download/Argo) · open(Android 앱 선택, iOS 공유 시트)
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(mobile)]
use tauri::Manager;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_media_share);

#[cfg(mobile)]
mod mobile {
    use serde::Serialize;
    use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

    pub struct MediaShare<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    struct MediaArgs {
        url: String,
        name: String,
        mime: String,
    }

    fn call<R: Runtime>(app: &AppHandle<R>, cmd: &str, url: String, name: String, mime: String) -> Result<serde_json::Value, String> {
        app.state::<MediaShare<R>>().0.run_mobile_plugin(cmd, MediaArgs { url, name, mime }).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn share<R: Runtime>(app: AppHandle<R>, url: String, name: String, mime: String) -> Result<serde_json::Value, String> {
        call(&app, "share", url, name, mime)
    }

    #[tauri::command]
    pub async fn save<R: Runtime>(app: AppHandle<R>, url: String, name: String, mime: String) -> Result<serde_json::Value, String> {
        call(&app, "save", url, name, mime)
    }

    #[tauri::command]
    pub async fn open<R: Runtime>(app: AppHandle<R>, url: String, name: String, mime: String) -> Result<serde_json::Value, String> {
        call(&app, "open", url, name, mime)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("media-share");
    #[cfg(mobile)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![mobile::share, mobile::save, mobile::open])
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_media_share)?;
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin("com.beyondworks.argo.messenger.mediashare", "MediaSharePlugin")?;
            app.manage(mobile::MediaShare(handle));
            Ok(())
        });
    builder.build()
}
