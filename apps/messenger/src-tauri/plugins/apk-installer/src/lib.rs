// apk-installer — Android 전용. 스토어 미발행 단계에서 앱이 GitHub 릴리스 APK를 직접 받아 같은 서명으로 겹쳐 설치한다
// (같은 서명 = 데이터·로그인 유지). 다운로드·sha256 대조·설치 인텐트는 전부 Kotlin(android/)에서 한다 — Rust는 JS↔Kotlin
// 사이의 얇은 다리(run_mobile_plugin)만. 호스트 허용 목록은 JS 쪽(update-release.mjs)에서 이미 걸렀지만, Kotlin 쪽도
// 리다이렉트를 직접 따라가며 매 홉의 호스트를 다시 검사한다(응답 변조 방어 — 신뢰 경계를 한 곳에 두지 않는다).
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "android")]
use tauri::Manager;

// Android 플러그인은 iOS와 달리 별도 FFI 바인딩 매크로가 없다 — register_android_plugin이 JNI로 Kotlin 클래스를
// 직접 찾아 로드한다(app-level android_binding!과는 다른 것 — 그건 앱 전체에 하나뿐인 진입점 매크로다).
#[cfg(target_os = "android")]
mod android {
    use serde::{Deserialize, Serialize};
    use tauri::{ipc::Channel, plugin::PluginHandle, AppHandle, Manager, Runtime};

    pub struct ApkInstaller<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DownloadArgs {
        url: String,
        sha256: Option<String>,
        on_event: Channel<serde_json::Value>,
    }

    #[derive(Serialize, Deserialize)]
    pub struct DownloadResult {
        #[serde(default)]
        pub ok: bool,
    }

    /// GitHub 릴리스 자산 URL을 받아 내려받고(진행률은 on_event로) sha256을 대조한 뒤 설치 화면을 띄운다.
    /// "알 수 없는 앱 설치" 권한이 없으면 PERMISSION_REQUIRED로 거부한다(JS가 안내 화면으로 갈라 보여준다).
    #[tauri::command]
    pub async fn download_and_install<R: Runtime>(
        app: AppHandle<R>,
        url: String,
        sha256: Option<String>,
        on_event: Channel<serde_json::Value>,
    ) -> Result<DownloadResult, String> {
        app.state::<ApkInstaller<R>>()
            .0
            .run_mobile_plugin("downloadAndInstall", DownloadArgs { url, sha256, on_event })
            .map_err(|e| e.to_string())
    }

    /// "알 수 없는 앱 설치" 허용 설정 화면을 연다(REQUEST_INSTALL_PACKAGES 권한 없음 안내 버튼에서 호출).
    #[tauri::command]
    pub async fn open_unknown_sources_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
        app.state::<ApkInstaller<R>>()
            .0
            .run_mobile_plugin("openUnknownSourcesSettings", ())
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("apk-installer");
    #[cfg(target_os = "android")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            android::download_and_install,
            android::open_unknown_sources_settings
        ])
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.beyondworks.argo.messenger.apkinstaller", "ApkInstallerPlugin")?;
            app.manage(android::ApkInstaller(handle));
            Ok(())
        });
    builder.build()
}
