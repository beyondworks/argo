// 개인 공간의 내 외부 에이전트(봇 쌍둥이, 2026-10-01) — 표시 판정. 서버 msgr_personal_room_crews가 주인에게만 bot_kind·org_label·ready를 준다
// (친구에게는 null). ready === false = 다른 관리자가 토큰을 바꿨거나 주인이 조직을 떠나 개인 공간에서 답하지 않는 상태.
/** '다시 연결 필요' 표시 — 서버가 ready를 false로 준 봇 쌍둥이만(옛 서버·친구 행은 ready가 없어 표시하지 않는다) */
export const twinRelink = (c) => c?.hosting === 'bot' && c?.ready === false;
/** 같은 에이전트를 여러 조직에 연결했을 때만 붙는 조직 이름 */
export const twinOrgLabel = (c) => (c?.hosting === 'bot' && typeof c?.org_label === 'string' && c.org_label.trim() ? c.org_label.trim() : null);
/** 방에 넣을 후보 — 답할 수 없는 쌍둥이는 빼고 이름 조회용으로만 남긴다 */
export const crewAddable = (c) => !twinRelink(c);
