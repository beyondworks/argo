const COMMANDS: &[&str] = &["download_and_install", "open_unknown_sources_settings"];

fn main() {
    // android/ 아래 Kotlin 모듈을 gen/android 프로젝트에 끼워 넣는다(web-auth의 ios_path와 같은 자리, Android 판).
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
