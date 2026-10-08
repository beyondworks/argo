// 채널 기억 회수(유건 결정 2026-10-03 — 에이전트는 한 사람, 채널·조직에서 빠지면 그 기억을 회수한다)의 순수 규칙.
// 스레드(chats/<slug>.json)에 departed = { <channelId>: { ts, sids } } 각인을 남기고, ts까지의 그 채널 줄과 sids 세션을 지운다.
//   ts = 지운 줄 가운데 가장 늦은 ts(실제 메시지에 앵커 — 벽시계로 자르면 시계가 다른 기기의 재입장 뒤 줄을 지운다, sync cutTs와 같은 이유)
//   sids = 지운 채널 세션 id — 세션은 시각이 아니라 id로 지운다(다시 들어온 뒤 새 세션은 남는다).
// 각인은 읽을 때(loadThread)와 동기화 병합(sync.mjs mergeThread)에서도 다시 적용된다 — 예전 버전·다른 기기가 든 옛 줄이 되살아나도 쓰이지 않게.
// 다른 크루가 쪽지·위임·세션 메시지로 전해 준 줄과 그 답은 지우지 않는다 — 이 크루가 그 채널에 있었던 기록이 아니라 전해 받은 일이다(설계 검수 M2).
export const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 주인 혼자 1:1 기록인가(유건 결정 2026-10-08 ① — 에이전트는 한 사람) — 사람 구성원이 주인 하나·에이전트도 이 에이전트 하나인 메신저 1:1에서
    주인이 직접 보낸 턴의 줄. 게이트웨이(msgr.mjs)가 방을 확인한 턴에만 contextScope.ownerSolo를 적는다. 표지가 없는 DM 줄(옛 버전·남 낀 방)은 해당 없음.
    이런 줄은 범위 없는 대화(데스크톱)의 맥락·누적 요약(t.summary)에 들어간다 — 회수 때 그 요약도 거둔다(아래 applyDeparted). thread.mjs가 다시 내보낸다. */
export const isOwnerSoloScope = (s) => s?.kind === 'msgr-dm' && s.ownerSolo === true;

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

/* ── 범위 없는 누적 요약(t.summary)이 접은 주인 혼자 1:1 줄(재검수 MEDIUM 2026-10-08) — 요약은 데스크톱 맥락이라 주인 혼자 1:1 줄도 접는다. 그 방에서 빠지면
   요약도 거둬야 한다. 판단 근거는 요약 자신이 든다: summary.solo = { <channelId>: 접은 그 방 1:1 줄 가운데 가장 이른 ts }. 회수 각인의 ts(지운 줄 가운데 가장 늦은 ts)
   이하인 줄을 하나라도 접었으면 그 요약은 회수된 내용을 품는다. 두 값 다 옛 버전(0.1.97)이 보존하는 자리에 있다 — 옛 병합은 요약 객체를 통째로 고르고
   각인의 ts를 남긴다. 그래서 옛 버전이 요약을 되돌리든(병합) 먼저 회수하든(요약을 건드리지 않는다), 그 사본을 그대로 받든 읽는 자리(loadThread·병합)에서 다시 거른다.
   요약은 다시 만들 수 있는 캐시라 넓게 거르는 쪽이 안전하다. ── */
/** 요약이 접은 1:1 방과 가장 이른 줄 ts(순수) — msgs 가운데 기준점(upto) 이하의 주인 혼자 1:1 줄 + prev(이 요약이 이어 접은 앞 요약의 solo)를 방마다 작은 값으로. */
export function foldedSolo(msgs, upto, prev = null) {
  const out = {};
  for (const [k, v] of Object.entries(prev && typeof prev === 'object' ? prev : {})) if (CHANNEL_ID.test(k) && Number.isFinite(Number(v))) out[k.toLowerCase()] = Math.min(out[k.toLowerCase()] ?? Infinity, Number(v));
  const lim = Number(upto) || 0;
  for (const m of msgs ?? []) {
    const c = isOwnerSoloScope(m?.contextScope) ? msgChannel(m) : null; const ts = Number(m?.ts) || 0;
    if (c && ts <= lim) out[c] = Math.min(out[c] ?? Infinity, ts);
  }
  return out;
}
/** 회수된 1:1 줄을 접은 요약인가(순수) — 각인에 있는 방의 solo 값이 그 각인 ts 이하. solo가 없는 요약(1:1 줄을 접지 않았다)은 해당 없음. */
export function summaryRecalled(departed, s) {
  if (!s?.solo || typeof s.solo !== 'object' || !departed || typeof departed !== 'object') return false;
  return Object.entries(s.solo).some(([c, ts]) => { const e = departed[String(c).toLowerCase()]; return !!e && (Number(ts) || 0) <= entry(e).ts; });
}
/** 범위 없는 요약(t.summary)을 거둘 것인가(순수) — 위 summaryRecalled + 옛 버전 요약(withSolo 없음)인데 회수 각인이 하나라도 있을 때(재검수 3차 MEDIUM 2026-10-08).
    옛 버전(0.1.97)은 다시 요약할 때 앞 요약 글을 이어 접고(thread-context threadSummaryPrompt) {text, upto, at}만 저장한다 — 이 버전 요약의 solo 표지가 빠져,
    그 요약이 회수된 1:1 내용을 품었는지 알 길이 없다. 요약은 다시 만들 수 있는 캐시라 회수 각인이 있는 스레드에서는 옛 요약을 쓰지 않는다(다음 턴에 한 번 다시 요약).
    범위 있는(채널) 요약에는 쓰지 않는다 — 그쪽은 scopedSummaries 규칙(upto ≤ 각인 ts, applyDeparted). */
export function unscopedSummaryGone(departed, s) {
  if (!s) return false;
  if (summaryRecalled(departed, s)) return true;
  return !s.withSolo && !!departed && typeof departed === 'object' && Object.keys(departed).some((k) => CHANNEL_ID.test(k));
}

/** 각인 적용(제자리 수정) — 지운 줄 수를 돌려준다. */
export function applyDeparted(t) {
  const d = t?.departed;
  if (!d || typeof d !== 'object' || !Array.isArray(t.messages)) return 0;
  const own = ownChannels(t.messages);
  const before = t.messages.length;
  t.messages = t.messages.filter((m, i) => { const c = own[i]; return !(c && d[c] && (Number(m.ts) || 0) <= entry(d[c]).ts); });
  if (unscopedSummaryGone(d, t.summary)) delete t.summary; // 회수된 주인 혼자 1:1 줄을 접은 범위 없는 요약(위 summary.solo) — 줄이 이미 없어도(옛 버전 사본) 요약 자신의 표지로 거른다. 표지를 잃은 옛 버전 요약도
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
