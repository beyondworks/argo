fn main() {
  // save_download는 원격 출처(localhost:3001의 Next 화면)에서 부른다 — Tauri 2는 원격 출처의 앱 커맨드를
  // capability에 적힌 것만 허용한다. 매니페스트에 올려야 allow-save-download 권한이 생긴다
  // (실사고 2026-09-17: 권한이 없어 저장이 늘 실패했고, 그 폴백이 창을 파일로 항해시켜 앱이 갇혔다).
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .app_manifest(tauri_build::AppManifest::new().commands(&["save_download"])),
  )
  .expect("failed to run tauri-build")
}
