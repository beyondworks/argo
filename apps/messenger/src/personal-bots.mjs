import { seenWithin } from './presence-clock.mjs';
// 개인 공간의 내 외부 에이전트(봇 쌍둥이, 2026-10-01) — 표시 판정. 서버 msgr_personal_room_crews가 주인에게만 bot_kind·org_label·ready·paused를 준다
// (친구에게는 null). 쓸 수 없는 쌍둥이(ready === false)는 이유가 둘이다(paused):
//   'relink'   — 개인 쪽 토큰 고정(핀)이 지금 토큰과 다름(주인 아닌 관리자의 회전·다른 사람이 만든 서버 연결 승인·근거 없는 백필). 다시 연결하면 풀린다.
//   'left_org' — 주인이 그 조직을 나갔거나 조직이 삭제됨(소프트 삭제 포함, 유건 결정 10/1). 다시 연결로는 풀리지 않는다. 조직 연체 잠금은 멈추지 않는다(#779와 같다).
/** '조직을 나가 사용할 수 없음' 표시 */
export const twinLeftOrg = (c) => c?.hosting === 'bot' && c?.paused === 'left_org';
/** '다시 연결 필요' 표시 — 서버가 ready를 false로 준 봇 쌍둥이 중 조직을 나간 경우가 아닌 것(paused 열이 없는 옛 서버 포함). 친구 행은 ready가 없어 표시하지 않는다 */
export const twinRelink = (c) => c?.hosting === 'bot' && c?.ready === false && !twinLeftOrg(c);
/** 같은 에이전트를 여러 조직에 연결했을 때만 붙는 조직 이름 */
export const twinOrgLabel = (c) => (c?.hosting === 'bot' && typeof c?.org_label === 'string' && c.org_label.trim() ? c.org_label.trim() : null);
/** 대화할 수 없는 쌍둥이(다시 연결 필요·조직을 나감) */
export const twinPaused = (c) => twinRelink(c) || twinLeftOrg(c);
/** 방에 넣을 후보 — 대화할 수 없는 쌍둥이는 빼고 이름 조회용으로만 남긴다 */
export const crewAddable = (c) => !twinPaused(c);
/** 접속 점에 쓸 시각 — 대화할 수 없는 쌍둥이는 조직 봇 행의 접속 시각을 빌려도 점을 켜지 않는다 */
export const crewSeenAt = (c) => (twinPaused(c) ? null : (c?.last_seen_at ?? null));
/** 켜짐 판정 'on' | 'off' | 'unknown'(점·'꺼져 있음'·잠든 얼굴) — 메신저 v2 에이전트(_v2)는 행에 접속 시각이 없다(source.mjs: 접속은 Presence v2:pr:).
    신호가 없으니 '꺼짐'으로 단정하지 않는다(crewAway·crewAwayNotice와 같은 규칙, 0.1.65 결함 2 — 답하는 에이전트가 전부 '꺼져 있음'·잠든 얼굴이던 것).
    실제로 꺼져 있으면 일 카드가 '받은 에이전트가 없어 끝났습니다'로 알린다. */
export const crewPresence = (c, awayMs, now = Date.now(), online = null) => (twinPaused(c) ? 'off'
  : c?._v2 ? (online?.get(c.owner_user_id)?.has(c.id) ? 'on' : 'unknown') // v2: 본체가 v2:pr:<주인>에 track한 것만 켜짐(v2/presence.mjs). 신호가 없으면(옛 본체·꺼짐·채널 전) 모름
  : (seenWithin(c, awayMs, now, crewSeenAt(c)) ? 'on' : 'off'));
/** 켜짐 점(mark)을 켤까 — 켜짐 신호가 있을 때만. 꺼짐 표시('꺼져 있음')는 crewPresence === 'off'일 때만 그린다(모름은 둘 다 그리지 않는다). */
export const crewOnline = (c, awayMs, now = Date.now(), online = null) => crewPresence(c, awayMs, now, online) === 'on';
