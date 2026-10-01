// Delegation recipients are message-scoped. They never become DM members.
export function dmMentionCrews(participants = [], candidates = []) {
  const seen = new Set();
  return [...participants, ...candidates].filter((crew) => crew?.id && !seen.has(crew.id) && seen.add(crew.id));
}

// @ 팝업 후보 — 대화방(DM)은 그 방에 들어온 에이전트만(유건 제보 2026-09-18: 다빈치만 있는 방에서 방 밖 에이전트가 떴다).
// 방 밖 에이전트를 받는이로 부르는 길은 /to·/cc와 본문 @이름 해석(dmMentionCrews)으로 남는다 — 팝업만 좁힌다.
export function mentionPopupCrews({ isDm, roomCrews = null, usable = [] }) {
  return isDm ? (roomCrews ?? []) : (roomCrews ?? usable);
}

export function setDmRecipient(recipients, crew, role) {
  if (!crew?.id || !['to', 'cc'].includes(role)) return recipients;
  const entry = { kind: 'crew', id: crew.id, name: crew.display_name || crew.name, role };
  return recipients.some((r) => r.id === crew.id)
    ? recipients.map((r) => r.id === crew.id ? entry : r)
    : [...recipients, entry];
}

// Explicit To/CC overrides an inline mention of that crew. Legacy inline mentions
// keep their role-less shape and ordered execution. Retry owns this exact snapshot.
export function dmDeliveryMentions(mentions = [], recipients = []) {
  const selected = new Map(recipients.filter((r) => r.kind === 'crew' && ['to', 'cc'].includes(r.role)).map((r) => [r.id, r]));
  const seen = new Set();
  const out = mentions.filter((m) => !seen.has(`${m.kind}:${m.id}`) && seen.add(`${m.kind}:${m.id}`)).map((m) =>
    m.kind === 'crew' && selected.has(m.id) ? { kind: 'crew', id: m.id, role: selected.get(m.id).role } : m);
  for (const r of selected.values()) if (!seen.has(`crew:${r.id}`)) out.push({ kind: 'crew', id: r.id, role: r.role });
  return out;
}

// Readiness is asserted by the server, never inferred from ownership/hosting.
// Legacy messages to existing participants remain usable without the new RPC.
export function dmUnavailableRecipients(mentions, candidates, participantIds = []) {
  const participants = new Set(participantIds);
  return mentions.filter((m) => m.kind === 'crew' && !(m.role === undefined && participants.has(m.id))
    && candidates.find((c) => c.id === m.id)?.delivery_ready !== true);
}

// A message forwarded by the server (msgr_dm_relay) carries meta.relay pointing at the DM it came from.
// via_name wins when a crew forwarded it. Otherwise fall back to the origin DM's own display name
// (sourceName) when the caller resolved it — the human is always a member of that DM. Name-free only
// when neither is known (origin DM not in the caller's loaded channel list).
export function relayCaptionKey(relay, sourceName) {
  const name = relay?.via_name || sourceName;
  return name ? { key: 'dm.relay.from', vars: { name } } : { key: 'dm.relay.fromOther' };
}

// Display name for one relay_to entry — CC gets a role suffix, To does not.
// Server-shaped data only: a malformed/nameless entry renders as '' rather than throwing or printing "undefined".
export function relayToLabel(entry, ccLabel) {
  const name = entry?.name;
  if (!name) return '';
  return entry.role === 'cc' ? `${name} (${ccLabel})` : name;
}

// Joined names for the relay notice sentence, in the order the server sent them. Non-array input (a
// malformed meta.relay_to) yields '' instead of throwing; empty labels are dropped, not left as blanks.
export function relayToNames(sent, ccLabel) {
  return (Array.isArray(sent) ? sent : []).map((e) => relayToLabel(e, ccLabel)).filter(Boolean).join(', ');
}

// "전달했습니다" 안내(system 글)를 누구에게 어떻게 그리나 — 글쓴이(부른 사람)만 그 에이전트 1:1을 열 수 있다. 다른 사람은 그 방에 권한이 없어
// 버튼을 눌러도 아무 일도 없었다(점검 A·B #9). 'sender' = 문장 + 대화 열기 버튼, 'other' = 누가 불렀는지만(버튼 없음).
// 작성자를 모르면(null) 'other' — 눌러도 안 되는 버튼을 보이느니 감춘다.
export function relayNoticeView(m, uid) {
  return { audience: m?.author_user_id && m.author_user_id === uid ? 'sender' : 'other' };
}
