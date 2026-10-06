// 앱 안 업데이트가 이 위치에서 저장될 수 있는지 판단할 사실(맥) — 판정과 문구는 화면 쪽(src/update-location.mjs)이 한다.
// 업데이터(tauri-plugin-updater 2.x)는 맥에서 지금 앱 번들을 임시 폴더로 옮긴 뒤 새 번들을 그 자리에 놓는다. 그래서 번들이
// DMG·App Translocation(읽기 전용 — EROFS), 다른 볼륨(EXDEV), 이 계정이 쓸 수 없는 폴더(EACCES — 관리자 소유)에 있으면 설치가 실패한다
// (2026-10-03 GitHub 맥 러너 재현 · 고객 문의 2건). 사실만 모은다: access(2)·stat — 파일을 만들거나 옮기지 않는다.
// Argo 본체(src-tauri/src/update_location.rs)도 같은 내용이다.
use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocation {
    platform: &'static str,
    path: Option<String>,
    translocated: bool,
    parent_errno: Option<i32>,
    bundle_errno: Option<i32>,
    same_volume: Option<bool>,
}

#[tauri::command]
pub fn update_location() -> UpdateLocation {
    #[cfg(target_os = "macos")]
    {
        mac::facts()
    }
    #[cfg(not(target_os = "macos"))]
    {
        UpdateLocation { platform: std::env::consts::OS, ..Default::default() }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::UpdateLocation;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    /// 이 계정이 쓸 수 있으면 None, 아니면 errno(30 = 읽기 전용, 13 = 권한 없음, 1 = 허용 안 됨 …).
    fn write_errno(p: &Path) -> Option<i32> {
        let c = CString::new(p.as_os_str().as_bytes()).ok()?;
        // SAFETY: c는 NUL로 끝나는 유효한 경로 문자열이고 access(2)는 읽기만 한다.
        if unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0 {
            None
        } else {
            std::io::Error::last_os_error().raw_os_error()
        }
    }

    pub fn facts() -> UpdateLocation {
        let exe = std::env::current_exe().ok();
        let Some(bundle) = exe.as_deref().and_then(|p| p.ancestors().find(|a| a.extension().is_some_and(|e| e == "app"))) else {
            return UpdateLocation { platform: "macos", ..Default::default() };
        };
        let path = bundle.to_string_lossy().into_owned();
        // 업데이터가 번들을 옮기는 임시 폴더($TMPDIR)와 같은 볼륨인가 — 다르면 rename이 EXDEV로 실패한다
        let same_volume = match (std::fs::metadata(bundle), std::fs::metadata(std::env::temp_dir())) {
            (Ok(a), Ok(b)) => Some(a.dev() == b.dev()),
            _ => None,
        };
        UpdateLocation {
            platform: "macos",
            translocated: path.contains("/AppTranslocation/"),
            parent_errno: bundle.parent().and_then(write_errno),
            bundle_errno: write_errno(bundle),
            same_volume,
            path: Some(path),
        }
    }
}
