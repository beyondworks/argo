// 설정 값 저장 — 누르는 즉시 바뀐 값으로 보이고, 저장이 실패하면 이전 값으로 되돌린다(F9, 2026-10-05: 크루 응답 언어·기본 러너가
// 저장에 실패해도 화면은 바뀐 값이라, 사용자는 바뀐 줄 알았다). save는 성공 여부(boolean)를 돌려준다(던져도 실패).
export async function saveWithRevert({ prev, next, apply, save }) {
  apply(next);
  let ok = false;
  try { ok = (await save(next)) === true; } catch { ok = false; }
  if (!ok) apply(prev);
  return ok;
}
