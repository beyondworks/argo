#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pair;

use tauri::{Manager, Url};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

fn external_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel")
}

fn trusted_navigation(url: &Url, development: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let bundled = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")));
    bundled
        || (development
            && url.scheme() == "http"
            && url.host_str() == Some("localhost")
            && url.port() == Some(5192))
}

fn attachment_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = leaf.chars().filter(|c| !c.is_control()).collect();
    if clean.trim().is_empty() || matches!(clean.as_str(), "." | "..") {
        "attachment".into()
    } else {
        clean
    }
}

fn require_office_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if window.label() == "main" && trusted_navigation(&url, cfg!(debug_assertions)) {
        Ok(())
    } else {
        Err("This command is only available in the Office window".into())
    }
}

#[tauri::command]
fn pair_start(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    require_office_window(&window)?;
    pair::pair_start()
}

#[tauri::command]
fn pair_claim(
    window: tauri::WebviewWindow,
    code: String,
    verifier: String,
) -> Result<serde_json::Value, String> {
    require_office_window(&window)?;
    Ok(pair::pair_claim(code, verifier))
}

#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum SaveResult {
    Saved,
    Cancelled,
}

#[tauri::command]
async fn save_attachment(
    window: tauri::WebviewWindow,
    name: String,
    bytes: Vec<u8>,
) -> Result<SaveResult, String> {
    require_office_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(attachment_name(&name))
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(SaveResult::Cancelled);
        };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())?;
        Ok(SaveResult::Saved)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn focus(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| focus(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init()) // 새 메일 알림(15차) — window.Notification을 OS 알림으로
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE
                        & !tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            pair_start,
            pair_claim,
            save_attachment
        ])
        .setup(|app| {
            let navigation_app = app.handle().clone();
            let popup_app = app.handle().clone();
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(move |url| {
                    // WKWebView also calls this hook for the scriptless mail srcdoc frame.
                    if matches!(url.as_str(), "about:blank" | "about:srcdoc") {
                        return true;
                    }
                    if trusted_navigation(url, cfg!(debug_assertions)) {
                        return true;
                    }
                    if external_url(url) {
                        let _ = navigation_app.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .on_new_window(move |url, _| {
                    if external_url(&url) {
                        let _ = popup_app.opener().open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.app_handle().hide();
                api.prevent_close();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("Could not start Argo Office");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            focus(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privileged_navigation_is_only_bundled_or_exact_dev_origin() {
        for url in [
            "https://example.com",
            "http://localhost:5193",
            "file:///etc/passwd",
            "https://localhost:5192",
            "argo-office://auth",
            "javascript:alert(1)",
            "http://tauri.localhost:9999",
            "https://user@tauri.localhost",
            "tauri://localhost:9999",
            "http://user@localhost:5192",
        ] {
            assert!(
                !trusted_navigation(&Url::parse(url).unwrap(), true),
                "{url}"
            );
        }
        assert!(trusted_navigation(
            &Url::parse("tauri://localhost/mail").unwrap(),
            false
        ));
        assert!(trusted_navigation(
            &Url::parse("http://localhost:5192/mail").unwrap(),
            true
        ));
        assert!(!trusted_navigation(
            &Url::parse("http://localhost:5192/mail").unwrap(),
            false
        ));
    }
    #[test]
    fn external_links_cannot_open_executable_or_file_schemes() {
        for url in [
            "https://example.com",
            "mailto:a@example.com",
            "tel:+123",
            "http://localhost:5192",
        ] {
            assert!(external_url(&Url::parse(url).unwrap()));
        }
        for url in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "argo-office://auth",
            "data:text/html,hello",
        ] {
            assert!(!external_url(&Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn attachment_suggestion_never_contains_directories() {
        assert_eq!(attachment_name("../../report.pdf"), "report.pdf");
        assert_eq!(attachment_name("C:\\secret\\report.pdf"), "report.pdf");
        assert_eq!(attachment_name(".."), "attachment");
        assert_eq!(attachment_name("\n\0"), "attachment");
    }
}
