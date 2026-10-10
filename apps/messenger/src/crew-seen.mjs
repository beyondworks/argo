// 에이전트 접속 시각 읽기(기기 단위 심박, 유건 2026-10-10 — 마이그레이션 20261010120000).
// Argo 0.1.101부터 기기 하나가 심박 1건을 쓰고, 에이전트 행의 last_seen_at은 옛 메신저 호환으로만 덜 자주 고쳐 쓴다.
// 그래서 행 시각 대신 계산 열 msgr_crew_seen(행 시각과 그 에이전트를 맡은 기기의 마지막 심박 중 늦은 것)을 열 이름 last_seen_at 그대로 받는다
// — 접속 판정 코드(presence-clock·crew-status·crew-face)는 그대로다.
// 옛 서버(함수 없음)면 PostgREST가 '열이 없다'(42703 "column msgr_crews.msgr_crew_seen does not exist")로 거절한다 → 행 시각으로 다시 읽고 10분 기억(face 열 폴백과 같은 모양).
export const seenCol = { missingAt: 0 };
export const SEEN_SELECT = 'last_seen_at:msgr_crew_seen';
const RECHECK_MS = 600_000;
export const withSeenCols = (cols, now = Date.now()) => (now - seenCol.missingAt > RECHECK_MS ? cols.replace(/\blast_seen_at\b/, SEEN_SELECT) : cols);
export const seenMissing = (err) => /msgr_crew_seen/.test(String(err?.message ?? err ?? ''));
/** run(cols) — 계산 열로 먼저 읽고, 옛 서버면 행 시각으로 한 번 더. 다른 오류는 그대로 던진다. */
export async function readWithSeen(cols, run, now = Date.now) {
  const sel = withSeenCols(cols, now());
  if (sel === cols) return run(cols);
  try { return await run(sel); } catch (e) {
    if (!seenMissing(e)) throw e;
    seenCol.missingAt = now();
    return run(cols);
  }
}
