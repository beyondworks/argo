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
    Ok(path.display().to_string())
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
    fn never_overwrites() {
        let dir = std::env::temp_dir().join(format!("argo-save-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.png"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.png"), dir.join("a (1).png"));
        assert_eq!(unique_path(&dir, "b.png"), dir.join("b.png"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
