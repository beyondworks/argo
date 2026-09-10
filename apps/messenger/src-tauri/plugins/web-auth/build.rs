const COMMANDS: &[&str] = &["start"];

fn main() {
    // ios/ 아래 Swift 패키지를 Rust 빌드 안에서 컴파일·링크한다(tauri-plugin의 link_apple_library).
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
