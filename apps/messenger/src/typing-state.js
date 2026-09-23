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

export const TYPING_WINDOW_MS = 6000;
/** 그 방에서 TYPING_WINDOW_MS 안에 typing이 온 크루가 있나 — 목록의 '답변 중' 표시 */
export const typingIn = (typing, channelId, now = Date.now()) => Object.entries(typing).some(([k, at]) => k.startsWith(`${channelId}:`) && now - at < TYPING_WINDOW_MS);

/** 방 토픽(dm:<방>)을 구독할 방 — 개인 공간은 전부, 조직은 비공개 방(DM·비공개 채널)만. 열린 방은 항상 포함, 상한 max(Realtime 연결당 채널 상한 여유). */
export function roomTopicIds(channels, openId, isPersonal, max = 50) {
  const priv = (c) => isPersonal || (c.kind && c.kind !== 'public');
  const open = channels.find((c) => c.id === openId);
  const ids = [...(open && priv(open) ? [openId] : []), ...channels.filter(priv).map((c) => c.id)];
  return [...new Set(ids)].slice(0, max).sort();
}
