// Notification destinations are independent of the conversation that runs a routine.
export const ROUTINE_NOTIFICATION_CHANNELS = Object.freeze(['telegram', 'slack', 'msgr']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRoutineNotifications(value) {
  if (value === undefined) return undefined; // old routines keep their existing routing
  if (!value || typeof value !== 'object' || !Array.isArray(value.channels)
    || value.channels.some((kind) => !ROUTINE_NOTIFICATION_CHANNELS.includes(kind))) throw new Error('Invalid routine notification channels');
  const channels = ROUTINE_NOTIFICATION_CHANNELS.filter((kind) => value.channels.includes(kind));
  if (!channels.includes('msgr')) return { channels };
  if (!UUID.test(value.msgr?.orgId ?? '') || !UUID.test(value.msgr?.channelId ?? '')) throw new Error('Select a messenger notification channel');
  return { channels, msgr: { orgId: value.msgr.orgId, channelId: value.msgr.channelId } };
}

const unwrap = ({ data, error }) => { if (error) throw new Error('Messenger notification destinations unavailable'); return data ?? []; };

/** Owner JWT/RLS, current membership and crew scope all constrain selectable destinations. */
export async function messengerNotificationChannels(wsId, agentSlug, { session } = {}) {
  const bridge = await import('./gateway/msgr.mjs');
  const c = await (session ?? bridge.sessionClient)();
  if (!c) return [];
  const { loadCompany } = await import('./workspace.mjs');
  const company = await loadCompany(wsId);
  if (company.ownerId !== c.uid) return []; // 소유자 = 로그인 계정일 때만(배달 쪽 게이트와 같은 규칙 — 선택지만 보이고 배달은 거부되던 어긋남, 검수 LOW)
  const now = new Date().toISOString();
  const memberships = unwrap(await c.client.from('msgr_org_members').select('org_id, expires_at, msgr_orgs(id, name, deleted_at)')
    .eq('user_id', c.uid).is('removed_at', null));
  const orgs = memberships.filter((m) => m.msgr_orgs && !m.msgr_orgs.deleted_at && (!m.expires_at || m.expires_at > now));
  if (!orgs.length) return [];
  const crews = (await c.db.myCrews(c.uid, wsId)).filter((r) => r.slug === agentSlug && orgs.some((o) => o.org_id === r.org_id));
  if (!crews.length) return [];
  const channels = unwrap(await c.client.from('msgr_channels').select('id, org_id, kind, name, archived_at, excluded_crew_ids')
    .in('org_id', crews.map((r) => r.org_id)).is('archived_at', null));
  const scopes = new Map(await Promise.all(crews.map(async (r) => [r.id, await c.db.crewScope(r.id)])));
  return channels.filter((ch) => crews.some((r) => r.org_id === ch.org_id && bridge.crewInScope(ch, r.id, scopes.get(r.id).has(ch.id))))
    .map((ch) => ({ orgId: ch.org_id, channelId: ch.id, name: ch.name, orgName: orgs.find((o) => o.org_id === ch.org_id).msgr_orgs.name }));
}

export async function routineNotificationOptions(wsId, agentSlug, { session } = {}) {
  const [{ loadConnections }, { loadCompany }, { listAgents }, { resolveTelegramDest }, { channelSends }] = await Promise.all([
    import('./connections.mjs'), import('./workspace.mjs'), import('./hub.mjs'), import('./gateway/routing.mjs'), import('./channel-events.mjs'),
  ]);
  const [all, company, agents] = await Promise.all([loadConnections(wsId), loadCompany(wsId), listAgents(wsId)]);
  const slug = agentSlug || agents[0]?.slug;
  let messengerChannels = []; let msgrReason = 'not_connected';
  try { messengerChannels = await messengerNotificationChannels(wsId, slug, { session }); }
  catch { msgrReason = 'unavailable'; }
  const muted = (kind) => (kind === 'msgr' ? company.msgr?.mutedEvents : all[kind]?.mutedEvents)?.includes('routine');
  const ready = {
    telegram: !!resolveTelegramDest(all.telegram, 'routine', slug, agents, { widen: false }),
    slack: !!(all.slack.token && all.slack.channel && channelSends('slack', all.slack, 'routine')),
    msgr: !!company.msgr?.enabled && !muted('msgr') && messengerChannels.length > 0,
  };
  return { channels: ROUTINE_NOTIFICATION_CHANNELS.map((kind) => ({ kind, ready: ready[kind], ...(!ready[kind] ? { reason: muted(kind) ? 'muted' : kind === 'msgr' ? msgrReason : 'not_connected' } : {}) })), messengerChannels };
}

export async function validateRoutineNotifications(wsId, agentSlug, value, options = {}) {
  const normalized = normalizeRoutineNotifications(value);
  if (!normalized?.channels.length) return normalized;
  const available = await routineNotificationOptions(wsId, agentSlug, options);
  for (const kind of normalized.channels) {
    if (!available.channels.find((r) => r.kind === kind)?.ready) throw new Error(`Notification channel unavailable: ${kind}`);
  }
  if (normalized.msgr && !available.messengerChannels.some((r) => r.orgId === normalized.msgr.orgId && r.channelId === normalized.msgr.channelId)) throw new Error('Messenger notification channel unavailable');
  return normalized;
}
