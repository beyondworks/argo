// '입력 중'·실행 카드 상태(키 = 채널:크루). 크루 답글이 도착하면 그 크루의 표시를 즉시 지우고,
// 답글 직전에 떠난 방송이 뒤늦게 와도 SETTLE_IGNORE_MS 동안은 다시 띄우지 않는다(유건 제보 2026-09-23: 답변 뒤 입력 중 창이 한 번 더 떴다 사라짐).
// ponytail: 시간창 방식 — 같은 크루가 곧바로 다음 턴을 시작하면 새 표시는 다음 typing 주기(서버 4초)에 뜬다.
// 6초(2026-10-05, 1.5초에서 늘림) — 서버가 답을 게시한 뒤 입력 중을 멈추므로 늦은 방송은 4초 주기 1건 + 전송 지연뿐이다(검수 재현: 답 2.2초 뒤 도착).
export const SETTLE_IGNORE_MS = 6000;
export const typingKey = (p) => `${p?.channel_id}:${p?.crew_id}`;

/** 방송을 받아들일지 — 방금 답한 크루의 늦은 방송이면 false */
export function acceptTyping(settled, payload, now = Date.now()) {
  const at = settled[typingKey(payload)];
  return at === undefined || now - at >= SETTLE_IGNORE_MS;
}

/** 방의 크루별 마지막 글 id를 이전과 비교 — 방송이 아닌 경로(재연결·복귀·새로고침으로 다시 읽음)로 들어온 크루 글도 그 크루의 '입력 중'을 내리게.
    prev = null(처음 읽음)이면 기록만 하고 changed는 비운다. */
export function crewPostsChanged(prev, msgs = []) {
  const next = {};
  for (const m of msgs) if (m?.author_kind === 'crew' && m.crew_id && m.id != null) next[m.crew_id] = m.id; // 목록은 글 순서 — 마지막 것이 최신
  if (!prev) return { next, changed: [] };
  return { next, changed: Object.keys(next).filter((k) => next[k] !== prev[k]) };
}

/** 크루 답글 도착 — 그 키를 표시 목록에서 뺀 새 객체(같으면 원본) */
export function withoutKey(map, key) {
  if (!(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return rest;
}

// 20초(2026-10-05, 6초에서 넓힘) — 턴 실행 중 서버 4초 주기 방송이 몇 번 늦거나 빠져도 '답변 중'이 깜빡이며 사라지지 않게. 답이 오면 settleCrew가 그 자리에서 내린다.
export const TYPING_WINDOW_MS = 20_000;
/** 그 방에서 TYPING_WINDOW_MS 안에 typing이 온 크루가 있나 — 목록의 '답변 중' 표시 */
export const typingIn = (typing, channelId, now = Date.now()) => Object.entries(typing).some(([k, at]) => k.startsWith(`${channelId}:`) && now - at < TYPING_WINDOW_MS);

/** 방 토픽(dm:<방>)을 구독할 방 — 개인 공간은 전부, 조직은 비공개 방(DM·비공개 채널)만. 열린 방은 항상 포함, 상한 max(Realtime 연결당 채널 상한 여유).
    상한을 넘으면 최근 대화(lastAt) → 최근에 만든 방 순으로 고른다(목록은 만든 순 오름차순이라 그대로 자르면 옛 방만 남았다 — 검수 #690 M1). */
export function roomTopicIds(channels, openId, isPersonal, max = 50, lastAt = {}) {
  const priv = (c) => isPersonal || (c.kind && c.kind !== 'public');
  const open = channels.find((c) => c.id === openId);
  const recent = channels.filter(priv).map((c, i) => [c, i]).sort((a, b) => ((lastAt[b[0].id] ?? 0) - (lastAt[a[0].id] ?? 0)) || (b[1] - a[1])).map(([c]) => c.id);
  const ids = [...(open && priv(open) ? [openId] : []), ...recent];
  return [...new Set(ids)].slice(0, max).sort();
}
