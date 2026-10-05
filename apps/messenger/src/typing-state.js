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

/** 크루별 마지막 글 기록을 방(채널)별로 셸에 둔다 — 대화 화면(Channel key={chId})은 방을 바꾸면 새로 만들어져 기록이 사라졌고, 방 밖에서 답 방송이
    유실되면 다시 연 방에서 그 답이 목록에 있어도 '입력 중'이 최대 20초 남았다(통합 재검수 MEDIUM, 2026-10-05).
    read(방, 글 목록, 크루 → 그 크루를 겨냥한 내 마지막 글 id) → 입력 중을 내릴 크루. 이 세션에서 처음 여는 방은 '그 크루의 마지막 글 > 그 크루를 겨냥한 내 마지막 글'이면
    (답이 이미 왔다) 내리고, 다시 연 방은 직전 기록과 비교한다. heard(방, 크루, 글 id) = 방 밖에서 받은 크루 글 방송(셸이 이미 내렸다 — 기준만 올린다). */
export function createCrewPostsMemory() {
  const byChannel = new Map();
  return {
    read(chId, msgs = [], askedOf = () => 0) {
      const prev = byChannel.get(chId) ?? null;
      const next = { ...(prev ?? {}) };
      for (const m of msgs) if (m?.author_kind === 'crew' && m.crew_id && Number.isFinite(m.id)) next[m.crew_id] = Math.max(next[m.crew_id] ?? 0, m.id);
      byChannel.set(chId, next);
      return Object.keys(next).filter((k) => (prev ? next[k] !== prev[k] : next[k] > askedOf(k)));
    },
    heard(chId, crewId, id) { const rec = byChannel.get(chId); if (rec && crewId && Number.isFinite(id)) rec[crewId] = Math.max(rec[crewId] ?? 0, id); },
    clear() { byChannel.clear(); },
  };
}
/** 크루 → 그 크루를 겨냥한 내 마지막 글 id. 멘션(참조 cc 제외)·크루 글에 단 답글, 1:1 방이면 내 글 전부(방의 크루가 답한다 — 서버 targetsCrew와 같은 방향).
    애매하면 '겨냥했다'로 본다 — 지금 답하는 중인 크루의 입력 중을 잘못 내리지 않게. */
export function lastAskedIds(msgs = [], { uid, isDm = false } = {}) {
  const asked = {}; let lastMine = 0;
  const byId = new Map(msgs.map((m) => [m.id, m]));
  for (const m of msgs) {
    if (m?.author_kind !== 'user' || m.author_user_id !== uid || !Number.isFinite(m.id)) continue;
    lastMine = Math.max(lastMine, m.id);
    for (const x of Array.isArray(m.mentions) ? m.mentions : []) if (x?.kind === 'crew' && x.role !== 'cc') asked[x.id] = Math.max(asked[x.id] ?? 0, m.id);
    const p = m.reply_to ? byId.get(m.reply_to) : null;
    if (p?.author_kind === 'crew' && p.crew_id) asked[p.crew_id] = Math.max(asked[p.crew_id] ?? 0, m.id);
  }
  return (crewId) => Math.max(asked[crewId] ?? 0, isDm ? lastMine : 0);
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
