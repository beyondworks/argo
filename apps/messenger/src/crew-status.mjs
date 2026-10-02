import { presenceNow } from './presence-clock.mjs';
// 에이전트 시트의 상태 한 줄 — "파견"(이 조직에서 쓰도록 켜 둠)과 "접속"(마지막 접속이 최근인가)을 합쳐
// 지금 대화할 수 있는지 하나로 말한다. 부재 판정은 앱의 crewAway(AWAY_MS 이상 접속 없음)와 같다.
export function crewAvailability(crew, { now = Date.now(), awayMs = 90_000 } = {}) {
  if (crew?.status === 'available') return { state: 'recalled', ready: false }; // 파견 해제 — 지시·답글·채널 참여를 받지 않는다
  const seen = crew?.last_seen_at ? Date.parse(crew.last_seen_at) : 0;
  if (seen && presenceNow(crew, now) - seen < awayMs) return { state: 'ready', ready: true }; // 받아 온 때 기준(presence-clock.mjs)
  return { state: 'away', ready: false, lastSeen: crew?.last_seen_at ?? null };
}
