// 채널 기억 회수(유건 결정 2026-10-03 — 에이전트는 한 사람, 채널·조직에서 빠지면 그 기억을 회수한다)의 순수 규칙.
// 스레드(chats/<slug>.json)에 departed = { <channelId>: { ts, sids, sum? } } 각인을 남기고, ts까지의 그 채널 줄과 sids 세션을 지운다.
//   ts = 지운 줄 가운데 가장 늦은 ts(실제 메시지에 앵커 — 벽시계로 자르면 시계가 다른 기기의 재입장 뒤 줄을 지운다, sync cutTs와 같은 이유)
//   sids = 지운 채널 세션 id — 세션은 시각이 아니라 id로 지운다(다시 들어온 뒤 새 세션은 남는다).
//   sum = (있으면) 그 채널의 주인 혼자 1:1 줄을 접고 있어 거둔 범위 없는 요약의 {at, upto} — summaryRecalled 참고.
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

// sum = 회수가 거둔 범위 없는 요약의 {at(만든 시각), upto(기준점)} — 옛 버전 사본이 병합으로 되돌린 요약을 다시 거르는 표지(summaryRecalled). 옛 버전 병합은 이 필드를 버리지만
// 회수한 기기의 사본이 들고 있다가 다음 병합에서 다시 합친다(mergeDeparted가 큰 값으로 보존).
const sumOf = (v) => (v && typeof v === 'object' && Number.isFinite(Number(v.at)) && Number.isFinite(Number(v.upto)) ? { at: Number(v.at), upto: Number(v.upto) } : null);
const maxSum = (a, b) => (!a ? b : !b ? a : { at: Math.max(a.at, b.at), upto: Math.max(a.upto, b.upto) });
const entry = (v) => { const sum = sumOf(v?.sum); return { ts: Number(v?.ts) || 0, sids: Array.isArray(v?.sids) ? v.sids.filter((s) => typeof s === 'string') : [], ...(sum ? { sum } : {}) }; };

/** 회수가 거둔 범위 없는 요약이거나 그보다 먼저 만든 요약인가(순수, 재검수 MEDIUM 2026-10-08) — 옛 버전(주인 혼자 1:1 표지를 모른다) 사본은 줄은 지우지만 요약은
    병합으로 되돌린다. 그때는 지울 줄이 이미 없어 줄로는 다시 못 거른다. 그래서 거둔 요약의 at·upto를 각인에 남기고, 둘 다 그 값 이하인 요약을 같은 요약(또는 그 앞
    요약 — 같은 1:1 줄을 접었을 수 있다)으로 본다. 회수 뒤 새로 만든 요약은 at이 더 커서 남는다. 요약은 다시 만들 수 있는 캐시라 넓게 거르는 쪽이 안전하다. */
export function summaryRecalled(departed, s) {
  if (!s || !departed || typeof departed !== 'object') return false;
  const at = Number(s.at) || 0, upto = Number(s.upto) || 0;
  return Object.values(departed).some((v) => { const r = entry(v).sum; return !!r && at <= r.at && upto <= r.upto; });
}

/** 각인 적용(제자리 수정) — 지운 줄 수를 돌려준다. */
export function applyDeparted(t) {
  const d = t?.departed;
  if (!d || typeof d !== 'object' || !Array.isArray(t.messages)) return 0;
  const own = ownChannels(t.messages);
  const before = t.messages.length;
  const gone = (m, i) => { const c = own[i]; return !!(c && d[c] && (Number(m.ts) || 0) <= entry(d[c]).ts); };
  // 주인 혼자 1:1 줄은 범위 없는 누적 요약(t.summary)에도 접혀 있다 — 지우는 1:1 줄을 덮는 요약(upto가 그 줄 이후)은 통째로 거둔다(다시 만들 수 있는 캐시).
  // 다른 기기의 옛 사본이 병합으로 되살린 줄을 거를 때도 같다(mergeThread가 병합 결과에 이 함수를 다시 적용한다). 거둔 요약은 그 채널 각인에 남긴다(sum —
  // 옛 버전 사본이 줄 없이 요약만 되돌려도 summaryRecalled로 다시 거른다).
  if (t.summary) {
    const upto = Number(t.summary.upto) || 0;
    const hit = new Set(); t.messages.forEach((m, i) => { if (gone(m, i) && isOwnerSoloScope(m.contextScope) && (Number(m.ts) || 0) <= upto) hit.add(own[i]); });
    if (hit.size) {
      const mark = { at: Number(t.summary.at) || 0, upto };
      for (const c of hit) d[c] = { ...entry(d[c]), sum: maxSum(entry(d[c]).sum, mark) };
      delete t.summary;
    } else if (summaryRecalled(d, t.summary)) delete t.summary;
  }
  t.messages = t.messages.filter((m, i) => !gone(m, i));
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

/** 병합용 — 채널마다 ts는 늦은 쪽, sids는 합집합, sum(거둔 요약)은 큰 값. 둘 다 없으면 null. */
export function mergeDeparted(a, b) {
  const out = {};
  for (const d of [a, b]) for (const [k, v] of Object.entries(d && typeof d === 'object' ? d : {})) {
    if (!CHANNEL_ID.test(k)) continue;
    const c = k.toLowerCase(); const cur = out[c] ?? { ts: 0, sids: [] }; const e = entry(v); const sum = maxSum(cur.sum ?? null, e.sum ?? null);
    out[c] = { ts: Math.max(cur.ts, e.ts), sids: [...new Set([...cur.sids, ...e.sids])], ...(sum ? { sum } : {}) };
  }
  return Object.keys(out).length ? out : null;
}
