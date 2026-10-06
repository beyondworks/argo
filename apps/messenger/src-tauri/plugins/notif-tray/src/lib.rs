// notif-tray — Android 전용. 앱 아이콘 숫자(런처 배지·점)는 트레이에 남은 알림에서 나온다. 앱 안에서 읽어도 FCM이 띄운 알림은
// 트레이에 그대로 남아 숫자가 안 사라졌다(유건 제보 2026-10-01, iOS와 같은 증상). JS(app-badge.mjs)가 서버 배지에서 아직 안 읽은
// 채널의 태그 목록(keep)을 보내면, Kotlin이 그 밖의 메시지 알림(태그 ch-<채널>)을 지운다. 다른 태그(신고 알림 report-…)는 건드리지 않는다.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
mod android {
    use serde::{Deserialize, Serialize};
    use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

    pub struct NotifTray<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    struct ClearArgs {
        keep: Vec<String>,
    }

    #[derive(Serialize, Deserialize)]
    pub struct ClearResult {
        #[serde(default)]
        pub cleared: u32,
    }

    /// keep에 없는 메시지 알림(태그 ch-<채널>)을 트레이에서 지운다.
    #[tauri::command]
    pub async fn clear_read<R: Runtime>(app: AppHandle<R>, keep: Vec<String>) -> Result<ClearResult, String> {
        app.state::<NotifTray<R>>()
            .0
            .run_mobile_plugin("clearRead", ClearArgs { keep })
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("notif-tray");
    #[cfg(target_os = "android")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![android::clear_read])
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.beyondworks.argo.messenger.notiftray", "NotifTrayPlugin")?;
            app.manage(android::NotifTray(handle));
            Ok(())
        });
    builder.build()
}
