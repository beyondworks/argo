// 턴 전체 복사(유건 2026-10-02) — 턴 = 같은 사람이 이어 보낸 묶음(groupFlags의 notail로 이어진 글들). 그 마지막 글 아래 복사 버튼 하나가 턴 본문 전체를 복사한다.
// 순서대로 이어 붙이고 글 사이는 빈 줄 하나. 지운 글·시스템 글·결재 카드(본문이 화면에 보이는 글이 아니다)·첨부만 있는 글(본문 없음)은 뺀다.
export const turnCopyText = (msgs) => msgs
  .filter((m) => !m.deleted_at && m.kind !== 'system' && m.kind !== 'approval_card' && (m.body ?? '').trim())
  .map((m) => m.body.trim())
  .join('\n\n');
/** groupFlags 결과로 글마다 턴을 붙인다 — 턴의 마지막 글(tail)은 그 턴 전체 배열, 나머지는 null. */
export function tailTurns(list, flags) {
  let cur = [];
  return list.map((m, i) => { if (!flags[i].cont) cur = []; cur.push(m); return flags[i].tail ? cur : null; });
}
