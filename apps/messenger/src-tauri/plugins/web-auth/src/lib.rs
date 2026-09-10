// web-auth — iOS 전용. 외부 브라우저(opener)로 로그인 페이지를 열면 Chrome 등 서드파티 브라우저가 서버 리디렉션의
// 커스텀 스킴(argo-messenger://)을 앱에 넘기지 않는다(2026-09-10 실기 확인: Safari만 동작). 애플 표준
// ASWebAuthenticationSession은 콜백 URL을 앱에 직접 돌려주므로 기본 브라우저 설정과 무관하다.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "ios")]
use tauri::Manager;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_web_auth);

#[cfg(target_os = "ios")]
mod ios {
    use serde::{Deserialize, Serialize};
    use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

    pub struct WebAuth<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct StartArgs {
        url: String,
        callback_scheme: String,
    }

    #[derive(Deserialize, Serialize)]
    pub struct StartResult {
        #[serde(default)]
        pub url: Option<String>,
        #[serde(default)]
        pub cancelled: bool,
    }

    /// 로그인 창을 띄우고 콜백 URL(또는 취소)이 올 때까지 기다린다. async라 메인 스레드를 막지 않는다.
    #[tauri::command]
    pub async fn start<R: Runtime>(
        app: AppHandle<R>,
        url: String,
        callback_scheme: String,
    ) -> Result<StartResult, String> {
        app.state::<WebAuth<R>>()
            .0
            .run_mobile_plugin("start", StartArgs { url, callback_scheme })
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("web-auth");
    #[cfg(target_os = "ios")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![ios::start])
        .setup(|app, api| {
            let handle = api.register_ios_plugin(init_plugin_web_auth)?;
            app.manage(ios::WebAuth(handle));
            Ok(())
        });
    builder.build()
}
