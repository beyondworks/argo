// '입력 중'·실행 카드 상태(키 = 채널:크루). 크루 답글이 도착하면 그 크루의 표시를 즉시 지우고,
// 답글 직전에 떠난 방송이 뒤늦게 와도 SETTLE_IGNORE_MS 동안은 다시 띄우지 않는다(유건 제보 2026-09-23: 답변 뒤 입력 중 창이 한 번 더 떴다 사라짐).
// ponytail: 시간창 방식 — 같은 크루가 곧바로 다음 턴을 시작하면 새 표시는 다음 typing 주기(서버 4초)에 뜬다.
export const SETTLE_IGNORE_MS = 1500;
export const typingKey = (p) => `${p?.channel_id}:${p?.crew_id}`;

/** 방송을 받아들일지 — 방금 답한 크루의 늦은 방송이면 false */
export function acceptTyping(settled, payload, now = Date.now()) {
  const at = settled[typingKey(payload)];
  return at === undefined || now - at >= SETTLE_IGNORE_MS;
}

/** 크루 답글 도착 — 그 키를 표시 목록에서 뺀 새 객체(같으면 원본) */
export function withoutKey(map, key) {
  if (!(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return rest;
}
