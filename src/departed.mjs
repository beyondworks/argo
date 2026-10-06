// 채널 기억 회수(유건 결정 2026-10-03 — 에이전트는 한 사람, 채널·조직에서 빠지면 그 기억을 회수한다)의 순수 규칙.
// 스레드(chats/<slug>.json)에 departed = { <channelId>: { ts, sids } } 각인을 남기고, ts까지의 그 채널 줄과 sids 세션을 지운다.
//   ts = 지운 줄 가운데 가장 늦은 ts(실제 메시지에 앵커 — 벽시계로 자르면 시계가 다른 기기의 재입장 뒤 줄을 지운다, sync cutTs와 같은 이유)
//   sids = 지운 채널 세션 id — 세션은 시각이 아니라 id로 지운다(다시 들어온 뒤 새 세션은 남는다).
// 각인은 읽을 때(loadThread)와 동기화 병합(sync.mjs mergeThread)에서도 다시 적용된다 — 예전 버전·다른 기기가 든 옛 줄이 되살아나도 쓰이지 않게.
// 다른 크루가 쪽지·위임·세션 메시지로 전해 준 줄과 그 답은 지우지 않는다 — 이 크루가 그 채널에 있었던 기록이 아니라 전해 받은 일이다(설계 검수 M2).
export const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 메신저 채널 범위 줄이면 그 채널 id(소문자), 아니면 null. 텔레그램·슬랙·범위 없는 줄은 대상이 아니다. */
export const msgChannel = (m) => {
  const s = m?.contextScope;
  return (s?.kind === 'msgr' || s?.kind === 'msgr-dm') && CHANNEL_ID.test(String(s.channelId ?? '')) ? String(s.channelId).toLowerCase() : null;
};

// 다른 크루가 보낸 일 — 쪽지·위임·세션 메시지. 메신저 턴(via:'msgr')·루틴·작업·회의실은 이 크루가 직접 받은 일이다(분리 검수 H-1: via 전체를 건너뛰면 실제 채널 줄이 하나도 안 지워졌다).
const RELAYED = new Set(['crewmail', 'delegate', 'session']);
/** 회수 대상 줄의 채널 — 전해 받은 일(RELAYED 지시와 그 바로 뒤 크루 답)은 null. */
function ownChannels(messages) {
  const out = []; let relayed = null;
  for (const m of messages) {
    const c = msgChannel(m);
    const r = RELAYED.has(m?.via);
    if (m?.who === 'user') relayed = r ? c : null;
    out.push(c && !(r || (m.who === 'crew' && relayed === c)) ? c : null);
  }
  return out;
}

/** 스레드 안의 회수 대상 채널 id — 이 크루가 직접 받은 채널 줄 + 채널 세션 키. */
export function channelIdsOf(t) {
  const out = new Set();
  for (const c of ownChannels(t?.messages ?? [])) if (c) out.add(c);
  for (const k of Object.keys(t?.scopedSessions ?? {})) if (CHANNEL_ID.test(k)) out.add(k.toLowerCase());
  return out;
}

const entry = (v) => ({ ts: Number(v?.ts) || 0, sids: Array.isArray(v?.sids) ? v.sids.filter((s) => typeof s === 'string') : [] });

/** 각인 적용(제자리 수정) — 지운 줄 수를 돌려준다. */
export function applyDeparted(t) {
  const d = t?.departed;
  if (!d || typeof d !== 'object' || !Array.isArray(t.messages)) return 0;
  const own = ownChannels(t.messages);
  const before = t.messages.length;
  t.messages = t.messages.filter((m, i) => { const c = own[i]; return !(c && d[c] && (Number(m.ts) || 0) <= entry(d[c]).ts); });
  for (const [k, v] of Object.entries(t.scopedSessions ?? {})) {
    const e = d[k.toLowerCase()];
    if (e && entry(e).sids.includes(v?.sessionId)) delete t.scopedSessions[k];
  }
  // 그 채널 대화의 누적 요약(thread-context.mjs)도 회수한다 — 각인 시각까지를 덮는 요약만(다시 들어온 뒤의 새 요약은 남는다)
  for (const [k, v] of Object.entries(t.scopedSummaries ?? {})) {
    const e = d[k.toLowerCase()];
    if (e && (Number(v?.upto) || 0) <= entry(e).ts) delete t.scopedSummaries[k];
  }
  return before - t.messages.length;
}

/** 채널들을 빠진 것으로 각인하고 적용한다(제자리 수정). tsByChannel = 다른 파일까지 본 채널별 최대 ts. 반환: 지운 줄 수, 지운 채널 세션 id. */
export function forgetChannels(t, ids, tsByChannel = {}) {
  const want = new Set((ids ?? []).map((x) => String(x).toLowerCase()).filter((c) => CHANNEL_ID.test(c)));
  if (!want.size) return { removed: 0, sessionIds: [] };
  const own = ownChannels(t.messages ?? []);
  t.departed = { ...(t.departed ?? {}) };
  const sessionIds = [];
  for (const c of want) {
    const e = entry(t.departed[c]);
    e.ts = Math.max(e.ts, Number(tsByChannel[c]) || 0); // 다른 파일(보관본)의 그 채널 줄까지 — 호출부가 모아 준다
    t.messages.forEach((m, i) => { if (own[i] === c) e.ts = Math.max(e.ts, Number(m.ts) || 0); });
    for (const [k, v] of Object.entries(t.scopedSessions ?? {})) if (k.toLowerCase() === c && v?.sessionId && !e.sids.includes(v.sessionId)) { e.sids.push(v.sessionId); sessionIds.push(v.sessionId); }
    t.departed[c] = e;
  }
  return { removed: applyDeparted(t), sessionIds };
}

/** 병합용 — 채널마다 ts는 늦은 쪽, sids는 합집합. 둘 다 없으면 null. */
export function mergeDeparted(a, b) {
  const out = {};
  for (const d of [a, b]) for (const [k, v] of Object.entries(d && typeof d === 'object' ? d : {})) {
    if (!CHANNEL_ID.test(k)) continue;
    const c = k.toLowerCase(); const cur = out[c] ?? { ts: 0, sids: [] }; const e = entry(v);
    out[c] = { ts: Math.max(cur.ts, e.ts), sids: [...new Set([...cur.sids, ...e.sids])] };
  }
  return Object.keys(out).length ? out : null;
}
