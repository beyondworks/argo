// 사진 올리기 → 저장 순서(검수 D1, 2026-10-25) — 파일을 먼저 올리고 저장(프로필·에이전트 행)이 실패하면 방금 올린 파일을 Storage API로 지운다.
// 종전엔 저장이 실패해도(v2 에이전트 저장 v2_unsupported 등) 올린 파일이 버킷 msgr-avatars에 남았다. storage.objects SQL 삭제는 쓰지 않는다(DB 위생 규칙).
// upload() → { url, path }, save(url) → 저장했으면 true, remove(path) → Storage API 지우기. 반환 = 저장했는가. 올리기 실패는 그대로 던진다(지울 파일 없음).
export async function uploadThenSave({ upload, save, remove }) {
  const { url, path } = await upload();
  let ok = false;
  try { ok = !!(await save(url)); } finally {
    if (!ok) { try { await remove(path); } catch { /* 지우기 실패는 화면 오류를 덮지 않는다 */ } }
  }
  return ok;
}
