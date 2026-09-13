import { randomUUID } from 'node:crypto';
import { loadCompany, getDeviceId } from '../workspace.mjs';
import { loadConnections } from '../connections.mjs';
import { listAgents } from '../hub.mjs';
import { channelSends } from '../channel-events.mjs';
import { resolveTelegramDest } from './routing.mjs';
import { sessionClient } from './msgr.mjs';

const missingRpc = (error) => ['PGRST202', '42883'].includes(error?.code);

// Connections belong to the notification recipient, never to the crew that did
// the work. Advertise labels/readiness only; credentials stay on this Argo node.
export function notificationRoutes(company, connections, agents = []) {
  const label = (String(company.name || '').trim() || company.id || 'Argo').slice(0, 120);
  return [
    { kind: 'telegram', label, ready: !!resolveTelegramDest(connections.telegram, 'routine', connections.telegram?.defaultCrew, agents) },
    { kind: 'slack', label, ready: !!(channelSends('slack', connections.slack, 'routine') && connections.slack.token && connections.slack.channel) },
  ];
}

export async function deliverMessengerNotifications(wsId, {
  session = sessionClient, readCompany = loadCompany, readConnections = loadConnections,
  readAgents = listAgents, readDeviceId = getDeviceId, send, attempt = randomUUID(),
} = {}) {
  const c = await session();
  if (!c) return { available: false, reason: 'signed_out', deliveries: [] };
  const company = await readCompany(wsId);
  // An unowned/legacy workspace must not advertise another user's connections
  // merely because that account happens to be signed in on this computer.
  if (!company.ownerId || company.ownerId !== c.uid) return { available: false, reason: 'owner', deliveries: [] };
  const [connections, agents] = await Promise.all([readConnections(wsId), readAgents(wsId)]);
  const deviceId = await readDeviceId();
  const routes = notificationRoutes({ ...company, id: wsId }, connections, agents);
  const synced = await c.client.rpc('msgr_notification_routes_sync', { p_ws: wsId, p_routes: routes, p_device: deviceId });
  if (missingRpc(synced.error)) return { available: false, reason: 'upgrade', deliveries: [] };
  if (synced.error) throw new Error('Notification connections could not be synchronized');
  // Do not claim work if no sender is installed. Claiming reserves one outbound
  // attempt; an interrupted/ambiguous attempt must not become a duplicate send.
  if (typeof send !== 'function') return { available: true, deliveries: [] };
  const claimed = await c.client.rpc('msgr_notification_claim', { p_ws: wsId, p_attempt: attempt, p_device: deviceId });
  if (missingRpc(claimed.error)) return { available: false, reason: 'upgrade', deliveries: [] };
  if (claimed.error) throw new Error('Notification delivery queue could not be read');
  const deliveries = [];
  for (const row of Array.isArray(claimed.data) ? claimed.data : []) {
    let result;
    // Defense in depth: SQL also binds the route owner and workspace. Never
    // accept an origin/meta payload or let a claimed row choose a local company.
    if (row.ws_id !== wsId || !['telegram', 'slack'].includes(row.kind)) {
      result = { status: 'skipped', reason: 'invalid_destination' };
    } else if ((await readCompany(wsId)).ownerId !== c.uid || (await session())?.uid !== c.uid) {
      result = { status: 'skipped', reason: 'owner_changed' };
    } else {
      // Recheck channel access immediately before each external request, rather
      // than relying on permissions captured before earlier queue items sent.
      const authorized = await c.client.rpc('msgr_notification_authorize', { p_delivery: row.delivery_id, p_attempt: attempt });
      if (authorized.error || authorized.data !== true) {
        deliveries.push({ id: row.delivery_id, status: 'skipped', reason: 'permission_or_connection_changed' });
        continue;
      }
      const emptyBody = company.lang === 'en'
        ? (row.status === 'blocked' ? 'This automation could not run. Check its run history in Argo Messenger.' : 'Check the automation result in Argo Messenger.')
        : (row.status === 'blocked' ? '자동화를 실행하지 못했습니다. 아르고 메신저의 실행 이력을 확인해 주세요.' : '아르고 메신저에서 자동화 실행 결과를 확인해 주세요.');
      const event = {
        type: 'routine', wsId, ok: row.status === 'completed', reply: String(row.body || emptyBody),
        routine: { id: row.run_id, title: row.title, agentSlug: connections[row.kind]?.defaultCrew || agents[0]?.slug,
          lastRun: row.run_id, notifications: { channels: [row.kind] } },
      };
      try { result = await send(event, row.kind); }
      catch { result = { status: 'uncertain', reason: 'delivery_interrupted' }; }
    }
    const status = result?.status === 'sent' ? 'sent'
      : result?.status === 'failed' ? 'failed'
        : result?.status === 'uncertain' ? 'uncertain'
          : ['muted', 'unavailable', 'not_selected', 'skipped'].includes(result?.status) ? 'skipped' : 'uncertain';
    // Persist stable reason codes, never provider errors that may contain URLs,
    // bot tokens or private response bodies.
    const reason = status === 'sent' ? null : String(result?.reason ?? status).replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
    const finished = await c.client.rpc('msgr_notification_finish', {
      p_delivery: row.delivery_id, p_attempt: attempt, p_status: status, p_error: reason,
    });
    if (finished.error || finished.data !== true) {
      // Do not retry the send after a lost receipt. The claim lease records an
      // uncertain delivery for the user's history instead.
      deliveries.push({ id: row.delivery_id, status: 'uncertain', reason: 'receipt_not_saved' });
    } else deliveries.push({ id: row.delivery_id, status, ...(reason ? { reason } : {}) });
  }
  return { available: true, deliveries };
}
