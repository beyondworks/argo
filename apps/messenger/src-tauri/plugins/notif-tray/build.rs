const COMMANDS: &[&str] = &["clear_read"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
