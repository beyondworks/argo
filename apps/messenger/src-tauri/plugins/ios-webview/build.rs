const COMMANDS: &[&str] = &["set_background"];

fn main() {
    // ios/ 아래 Swift 패키지를 Rust 빌드 안에서 컴파일·링크한다(web-auth와 같은 자리). 생성 프로젝트(gen/apple)가 아니라서
    // `tauri ios init`을 다시 해도 지워지지 않는다.
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
