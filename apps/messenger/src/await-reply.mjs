// 보낸 뒤 대기 표시(2026-10-05 운영 실측: 턴은 2초 뒤 시작했는데 사용자는 "1분 반응 없음 → 답변 중 → 사라지고 30초 뒤 답"을 겪었다).
// 입력 중 방송만 보고 그리면 방송이 늦거나 끊긴 동안 아무것도 안 보인다. 그래서 '내 글이 크루를 겨냥했고 그 크루가 아직 뒤에 글을 안 올렸다'는
// 사실(이미 받은 글 목록)로 표시를 세우고, 방송은 단계(준비 중 → 답변 중)만 바꾼다. 네트워크·저장 0 — 화면 계산뿐.
//   preparing  전달됨 · 준비 중 (저장 직후, 방송 전)
//   answering  답변 중 (입력 중·진행 방송을 받음 — 끊겨도 30초까지 유지)
//   slow       조금 오래 걸리고 있어요 (켜져 있는데 30초 무신호)
//   offline    기기가 꺼져 있어 기다리는 중 (접속 90초 넘음, 받은 신호 없음)
// 그 크루가 내 글 뒤에 글(답·실패·거절 안내)을 올리면 사라진다. 상한 5분.
export const AWAIT_MAX_MS = 5 * 60_000;
export const AWAIT_SLOW_MS = 30_000;
export const AWAIT_SKEW_MS = 5_000; // 서버 created_at(서버 시계)과 방송 수신 시각(기기 시계)의 어긋남 허용 — 이보다 앞선 방송은 지난 턴의 잔여로 본다

/** 이 내 글이 겨냥한 크루 — 서버 targetsCrew(src/gateway/msgr.mjs)와 같은 규칙. 멘션(to)이 있으면 그 크루들, 없고 1:1 방이면 방의 크루,
    1:1이 아닌 방에서 크루 글에 단 답글이면 그 크루. 참조(cc)는 답하지 않는다. 방 밖 크루는 답하지 않으므로 방 크루로 거른다. */
export function awaitTargets(m, { uid, isDm, roomCrewIds = [], parentOf = () => null }) {
  if (!m || m.pending || m.deleted_at || m.kind !== 'text' || m.author_kind !== 'user' || m.author_user_id !== uid) return [];
  const crews = (Array.isArray(m.mentions) ? m.mentions : []).filter((x) => x?.kind === 'crew');
  const to = crews.filter((x) => x.role == null || x.role === 'to').map((x) => x.id);
  const out = [...to];
  if (!to.length && isDm) out.push(...roomCrewIds);
  if (!isDm && m.reply_to) { const p = parentOf(m.reply_to); if (p?.author_kind === 'crew' && p.crew_id) out.push(p.crew_id); }
  const inRoom = new Set(roomCrewIds);
  return [...new Set(out)].filter((id) => inRoom.has(id));
}

/** 신호 → 단계. base = 내 글 시각, sig = { typingAt, progressAt, receivedAt }(받은 기기 시각), away = 접속 90초 넘음. null = 상한 지남. */
export function awaitPhase({ base, sig = {}, away = false, now }) {
  if (now - base > AWAIT_MAX_MS) return null;
  const fresh = (t) => (Number.isFinite(t) && t >= base - AWAIT_SKEW_MS ? t : null);
  const answered = [fresh(sig.typingAt), fresh(sig.progressAt)].filter((t) => t != null);
  const received = fresh(sig.receivedAt);
  const last = Math.max(base, ...answered, ...(received != null ? [received] : []));
  const heard = answered.length > 0 || received != null;
  if (now - last > AWAIT_SLOW_MS) return away && !heard ? 'offline' : 'slow';
  if (answered.length) return 'answering';
  if (away && !heard) return 'offline';
  return 'preparing';
}

/** 방의 대기 표시 목록 — 크루마다 하나(그 크루를 겨냥한 내 마지막 글). 순서 = 글 순서 → 멘션 순서. */
export function awaitingReplies({ msgs = [], uid, isDm, roomCrewIds = [], signals = () => ({}), away = () => false, now = Date.now() }) {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const lastCrewPost = new Map(); // 크루 → 그 크루가 이 방에 올린 마지막 글 id
  for (const m of msgs) if (m.author_kind === 'crew' && m.crew_id && Number.isFinite(m.id)) lastCrewPost.set(m.crew_id, Math.max(lastCrewPost.get(m.crew_id) ?? 0, m.id));
  const latest = new Map(); // 크루 → { msg, order }
  let order = 0;
  for (const m of msgs) {
    if (!Number.isFinite(m.id)) continue;
    for (const crewId of awaitTargets(m, { uid, isDm, roomCrewIds, parentOf: (id) => byId.get(id) ?? null })) latest.set(crewId, { m, order: order++ });
  }
  const out = [];
  for (const [crewId, { m, order: o }] of latest) {
    if ((lastCrewPost.get(crewId) ?? 0) > m.id) continue; // 내 글 뒤에 그 크루가 글을 올렸다 — 답이 왔다
    const base = Date.parse(m.created_at);
    if (!Number.isFinite(base)) continue;
    const phase = awaitPhase({ base, sig: signals(crewId) ?? {}, away: !!away(crewId), now });
    if (phase) out.push({ crewId, msgId: m.id, phase, o });
  }
  return out.sort((a, b) => a.msgId - b.msgId || a.o - b.o).map(({ crewId, msgId, phase }) => ({ crewId, msgId, phase }));
}
