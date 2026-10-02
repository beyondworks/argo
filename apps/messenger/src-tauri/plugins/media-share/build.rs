const COMMANDS: &[&str] = &["share", "save", "open"];

fn main() {
    // iOS는 ios/ Swift 패키지, Android는 android/ Kotlin 모듈을 앱 빌드에 끼워 넣는다(web-auth·apk-installer와 같은 자리).
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").android_path("android").build();
}
