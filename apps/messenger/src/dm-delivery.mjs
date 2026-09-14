// Delegation recipients are message-scoped. They never become DM members.
export function dmMentionCrews(participants = [], candidates = []) {
  const seen = new Set();
  return [...participants, ...candidates].filter((crew) => crew?.id && !seen.has(crew.id) && seen.add(crew.id));
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
