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
