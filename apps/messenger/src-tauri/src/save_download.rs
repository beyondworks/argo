// 첨부 저장(데스크톱, 2026-10-02) — 웹뷰가 받은 바이트를 다운로드 폴더에 쓴다.
// 왜 Rust 명령인가: macOS WKWebView(wry)는 다운로드 처리기를 단 웹뷰에서만 <a download>를 받는다. 메신저 창은 설정 파일로 만들어
// 처리기가 없고, 그래서 브라우저처럼 링크를 눌러도 아무 일이 없었다(D54와 같은 뿌리). 대화 상자 없이 브라우저 다운로드처럼 바로 저장한다.
// JS: invoke('save_download', Uint8Array, { headers: { 'x-file-name': encodeURIComponent(name) } }) → 저장한 경로(media-io.js saveAttachment).
use std::path::{Path, PathBuf};
use tauri::{ipc::{InvokeBody, Request}, AppHandle, Manager, Runtime};

const MAX_BYTES: usize = 26_214_400; // 첨부 상한 25MB(앱·게이트웨이·저장소 정책과 같다)

/// %XX 풀기 — 깨진 바이트는 그대로 두고, 결과가 UTF-8이 아니면 대체 문자로.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 파일 이름으로 쓸 수 있게 — 경로 구분자·예약 문자·제어 문자를 '_'로, 앞뒤 점·공백 제거, 120자, 비면 "file".
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let limited: String = trimmed.chars().take(120).collect();
    if limited.is_empty() { "file".into() } else { limited }
}

/// 같은 이름이 있으면 "이름 (1).확장자"처럼 — 덮어쓰지 않는다(브라우저 다운로드와 같은 관례).
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() { return first; }
    let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 => (&name[..i], &name[i..]), _ => (name, "") };
    (1..10_000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

#[tauri::command]
pub fn save_download<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("raw body required".into()) };
    if bytes.len() > MAX_BYTES { return Err("file too large".into()); }
    let raw = request.headers().get("x-file-name").and_then(|v| v.to_str().ok()).unwrap_or("file");
    let name = safe_file_name(&percent_decode(raw));
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = unique_path(&dir, &name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    mark_from_internet(&path);
    Ok(path.display().to_string())
}

// 출처 표시(검수 2026-10-02) — 다른 사람이 보낸 파일이므로 브라우저 다운로드처럼 "인터넷에서 받은 파일" 표시를 붙여
// 열 때 Gatekeeper(macOS)·SmartScreen/보호된 보기(Windows)가 확인하게 한다. 표시를 못 붙여도(외장 FAT 디스크 등) 저장은 성공으로 둔다.
// macOS: Info.plist LSFileQuarantineEnabled 대신 저장한 파일 하나에만 붙인다 — 그 키는 앱이 만드는 모든 파일(업데이터가 받은 새 앱·설정·캐시)을 격리한다.
fn mark_from_internet(path: &Path) {
    #[cfg(target_os = "macos")]
    if let Err(e) = quarantine_mac(path) { eprintln!("[save_download] quarantine: {e}"); }
    #[cfg(windows)]
    if let Err(e) = std::fs::write(zone_identifier_path(path), ZONE_INTERNET) { eprintln!("[save_download] Zone.Identifier: {e}"); }
    let _ = path;
}

/// macOS 브라우저 다운로드와 같은 형식(실측: Chromium 계열 "0081;<16진 초>;<앱>;") — 0x0001 다운로드, 0x0040(사용자 승인) 없음.
pub fn quarantine_value(now_secs: u64) -> String { format!("0081;{now_secs:08x};Argo Messenger;") }

#[cfg(target_os = "macos")]
fn quarantine_mac(path: &Path) -> std::io::Result<()> {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::os::unix::ffi::OsStrExt;
    extern "C" { // libSystem(std가 이미 링크) — 새 크레이트 없이
        fn setxattr(path: *const c_char, name: *const c_char, value: *const c_void, size: usize, position: u32, options: c_int) -> c_int;
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let value = quarantine_value(now);
    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let name = c"com.apple.quarantine";
    let rc = unsafe { setxattr(c_path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
    if rc == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

/// Windows MOTW — `<파일>:Zone.Identifier` 대체 데이터 스트림, ZoneId=3(인터넷). 브라우저가 쓰는 것과 같은 형식.
#[cfg_attr(not(windows), allow(dead_code))] // 테스트는 모든 OS에서 형식을 잠근다
pub const ZONE_INTERNET: &str = "[ZoneTransfer]\r\nZoneId=3\r\n";
#[cfg_attr(not(windows), allow(dead_code))]
pub fn zone_identifier_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(":Zone.Identifier");
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_and_keeps_broken_sequences() {
        assert_eq!(percent_decode("%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf"), "보고서.pdf");
        assert_eq!(percent_decode("a%2Fb%"), "a/b%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn strips_paths_and_reserved_characters() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("C:\\Users\\a\\x.png"), "x.png");
        assert_eq!(safe_file_name("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(safe_file_name("..."), "file");
        assert_eq!(safe_file_name(" .hidden "), "hidden");
        assert_eq!(safe_file_name(&"가".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn origin_marks_match_browser_downloads() {
        assert_eq!(quarantine_value(0x6a1b_2c3d), "0081;6a1b2c3d;Argo Messenger;");
        assert_eq!(zone_identifier_path(Path::new(r"C:\Users\a\Downloads\x.pdf")).as_os_str(), r"C:\Users\a\Downloads\x.pdf:Zone.Identifier");
        assert_eq!(ZONE_INTERNET, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn saved_file_gets_quarantine_on_macos() {
        let dir = std::env::temp_dir().join(format!("argo-qtn-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("받은 파일.pdf");
        std::fs::write(&f, b"x").unwrap();
        mark_from_internet(&f);
        let out = std::process::Command::new("/usr/bin/xattr").arg("-p").arg("com.apple.quarantine").arg(&f).output().unwrap();
        let v = String::from_utf8_lossy(&out.stdout);
        assert!(v.starts_with("0081;") && v.trim_end().ends_with(";Argo Messenger;"), "quarantine = {v:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_overwrites() {
        let dir = std::env::temp_dir().join(format!("argo-save-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.png"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.png"), dir.join("a (1).png"));
        assert_eq!(unique_path(&dir, "b.png"), dir.join("b.png"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
