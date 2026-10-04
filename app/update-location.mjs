// 앱 안 업데이트가 저장될 수 없는 설치 위치 판정(맥) — 사실은 Rust update_location 명령이 모은다(src-tauri/src/update_location.rs).
// 업데이터(tauri-plugin-updater 2.x)는 맥에서 지금 앱 번들을 임시 폴더로 옮긴 뒤 새 번들을 그 자리에 놓는다. 그래서 DMG·다운로드 폴더에서
// 바로 열어 macOS가 읽기 전용 자리에서 실행 중이면(App Translocation), 외장 디스크에 있으면, 관리자 소유 폴더면 설치가 실패한다
// (2026-10-03 GitHub 맥 러너 재현 · 고객 문의 2건: "업데이트를 눌러도 안 되고, 재설치하면 되다가 껐다 켜면 예전 버전").
// 메신저도 같은 판정을 쓴다(apps/messenger/src/update-location.mjs — 앱 묶음이 달라 사본, 테스트가 각각 잠근다).

/** 옮기기 전에는 설치가 성공할 수 없는 이유. needs_admin은 관리자 암호로 설치될 수 있어 설치 버튼을 남긴다. */
export const MOVE_REQUIRED = new Set(['translocated', 'read_only', 'other_volume']);

/** Rust 사실 → 'translocated' | 'read_only' | 'other_volume' | 'needs_admin' | null(문제 없음·판단할 수 없음)
    errno: 30 = 읽기 전용(EROFS), 13 = 권한 없음(EACCES), 1 = 허용 안 됨(EPERM). sameVolume = 번들과 임시 폴더가 같은 볼륨인가. */
export function updateLocationIssue(facts) {
  if (!facts || facts.platform !== 'macos' || !facts.path) return null;
  if (facts.translocated) return 'translocated';
  const errs = [facts.bundleErrno, facts.parentErrno];
  if (errs.includes(30)) return 'read_only';
  if (facts.sameVolume === false) return 'other_volume';
  if (errs.includes(13) || errs.includes(1)) return 'needs_admin';
  return null;
}

/** 설치 실패 원문 → 이유 키(문구는 화면이 고른다) | null(모르는 오류 — 원문만 보인다)
    'failed to move the new app into place' = 업데이터 2.10·2.11이 관리자 암호 창을 취소하거나 실패했을 때 돌려주는 유일한 문구(errno 없음). */
export function updateErrorReason(message) {
  const m = String(message ?? '');
  if (/os error 30\b|read-only file system/i.test(m)) return 'read_only';
  if (/os error 18\b|cross-device link/i.test(m)) return 'other_volume';
  if (/os error 28\b|no space left on device/i.test(m)) return 'disk_full';
  if (/os error (13|1)\b|permission denied|operation not permitted|not authorized|user cancel+ed|failed to move the new app into place/i.test(m)) return 'needs_admin';
  // invalid symbol·input length·padding = latest.json의 서명(base64)이 깨짐
  if (/signature|minisign|public key|invalid symbol|invalid input length|invalid padding/i.test(m)) return 'signature';
  if (/error sending request|request or response body error|error decoding response body|download request failed with status|error following redirect|dns|timed? ?out|network|connection (refused|reset)|offline/i.test(m)) return 'network';
  return null;
}
