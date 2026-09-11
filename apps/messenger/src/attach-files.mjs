// 첨부 목록 수용 — 파일 선택창과 드래그앤드롭이 같은 규칙을 쓴다(유건 제보 2026-09-11 밤: 드롭 안 됨·붙인 파일 취소 불가).
// 크기 상한 초과는 거절 목록으로 돌려주고(보낸 사람이 이유를 알게), 같은 파일(이름+크기)은 한 번만, 기존 목록에 누적한다.
export function acceptFiles(existing, incoming, max) {
  const rejected = []; const next = [...existing];
  for (const f of incoming ?? []) {
    if (!f || typeof f.size !== 'number') continue;
    if (f.size > max) { rejected.push(f); continue; }
    if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
    next.push(f);
  }
  return { files: next, rejected };
}
export const withoutFile = (files, target) => files.filter((f) => f !== target);
