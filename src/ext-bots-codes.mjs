// 외부 봇 호출기(ext-bots.mjs)의 세부 오류 코드 → work.error 코드(약속 v1.1: bot_unreachable·bot_limit). 의존성 없는 파일 — 연결부가 봇 모듈을 읽지 않고도 쓴다.
const LIMIT = new Set(['rate_limited', 'bot_rate_limited', 'bot_turn_cap', 'bot_hop_cap']);
const PASS = new Set(['timeout', 'tier_denied', 'cancelled']);
/** 봇 세부 코드 → work.error 코드. 속도·연쇄 상한은 bot_limit, 그 밖(꺼짐·키 없음·주소 거절·인증·응답 이상)은 bot_unreachable. */
export function workErrorCodeFor(code) {
  if (LIMIT.has(code)) return 'bot_limit';
  if (PASS.has(code)) return code;
  return 'bot_unreachable';
}
