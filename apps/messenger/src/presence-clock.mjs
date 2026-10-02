// 접속 판정의 기준 시각(기능 점검 D2, 2026-10-02) — 에이전트 행을 받아 온 시각(_at)까지만 시간이 흐른 것으로 본다.
// 30초마다 목록을 다시 읽던 때는 last_seen_at이 늘 새로웠다. 주기 다시 읽기를 없애면 지금 시각과 비교하는 순간 켜져 있는 에이전트도 90초 뒤 '꺼짐'이 된다.
// 그래서 받아 온 때의 상태를 다음에 다시 받을 때까지(앞으로 올 때·재연결·그 화면에 들어갈 때) 그대로 둔다. 입력 중·진행·답글 방송은 그 자리에서 last_seen_at·_at을 지금으로 고친다.
// _at이 없는 행(옛 경로·테스트)은 종전대로 지금 시각과 비교한다.
export const presenceNow = (row, now = Date.now()) => (row?._at ? Math.min(now, row._at) : now);
export const seenWithin = (row, awayMs, now = Date.now(), seenAt = row?.last_seen_at) => !!seenAt && presenceNow(row, now) - Date.parse(seenAt) < awayMs;
/** 받아 온 행에 그 시각을 적는다 */
export const stampFetched = (rows, at = Date.now()) => (rows ?? []).map((r) => ({ ...r, _at: at }));
/** 에이전트가 방금 무언가를 보냈다(입력 중·진행·답글) — 그 행만 지금 본 것으로 */
export const markSeen = (rows, crewId, at = Date.now()) => {
  if (!crewId || !rows?.some((r) => r.id === crewId)) return rows;
  const iso = new Date(at).toISOString();
  return rows.map((r) => (r.id === crewId ? { ...r, last_seen_at: iso, _at: at } : r));
};
