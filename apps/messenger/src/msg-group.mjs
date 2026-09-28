// 연속 메시지 묶음(순수) — 같은 보낸이가 같은 날 5분 안에 이어 보낸 글은 한 덩어리로 그린다.
// 이름·아바타는 묶음 첫 글에만, 시간·전송 표시는 마지막 글에만(카카오톡·슬랙·텔레그램 공통 — 유건 2026-09-29 "메이저 메신저와 이질감 없게").
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

const who = (m) => (m.author_kind === 'crew' ? `c:${m.crew_id}` : `u:${m.author_user_id}`);
const plain = (m) => !m.deleted_at && (m.kind == null || m.kind === 'text'); // 시스템·결재 카드·지운 글은 묶지 않는다

export function sameGroup(prev, m, windowMs = GROUP_WINDOW_MS) {
  if (!prev || !m || !plain(prev) || !plain(m)) return false;
  if (who(prev) !== who(m)) return false;
  const a = new Date(prev.created_at), b = new Date(m.created_at);
  if (a.toDateString() !== b.toDateString()) return false; // 날짜 줄이 끼는 자리
  const gap = b - a;
  return gap >= 0 && gap <= windowMs;
}

/** list 순서대로 { cont, tail } — breakAt(i)가 참이면 i번째 글 앞에서 묶음을 끊는다("새 메시지" 줄 등). */
export function groupFlags(list, breakAt = () => false, windowMs = GROUP_WINDOW_MS) {
  const cont = list.map((m, i) => i > 0 && !breakAt(i) && sameGroup(list[i - 1], m, windowMs));
  return list.map((_, i) => ({ cont: cont[i], tail: !cont[i + 1] }));
}
