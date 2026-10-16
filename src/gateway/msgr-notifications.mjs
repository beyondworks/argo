import { randomUUID } from 'node:crypto';
import { loadCompany, getDeviceId } from '../workspace.mjs';
import { loadConnections } from '../connections.mjs';
import { listAgents } from '../hub.mjs';
import { channelSends } from '../channel-events.mjs';
import { resolveTelegramDest } from './routing.mjs';
import { sessionClient } from './msgr.mjs';

const missingRpc = (error) => ['PGRST202', '42883'].includes(error?.code);

/* 유휴 호출 줄이기(2026-10-13 로그 수집 과금 — 이 루프가 기기·회사마다 30초에 RPC 2개, 하루 39만 건). DB 위생 규칙 2·3:
   - 경로 동기화(msgr_notification_routes_sync)는 보낼 경로 목록(라벨·ready)이 바뀌었을 때, 또는 ready 경로가 있으면 ROUTE_SYNC_MS마다만.
     서버 판정은 노드 3분 신선도(n.last_seen_at >= now()-3분, 20260923210000)라 120초 ≈ 기한의 2/3이지만 실제 간격은 120~140초(틱 60~70초 단위) — 180초 안(서버 60초 쓰기 생략 기준보다 길게). ready 경로가 없으면 신선도가 필요 없다.
   - 수신함 확인(msgr_notification_claim)은 ready 경로가 있을 때만 틱마다(NOTIFY_TICK_MS 60초 — 첫 알림 지연 30초대→60초대). 없으면 서버 조회가 늘 빈다(노드 ready 조인).
     다만 확인 RPC가 하던 정리(5분 넘은 claimed → uncertain, 24시간 넘은 pending → skipped, 권한 철회 → skipped)는 경로가 꺼져도 남아야 해서
     IDLE_CLAIM_MS(30분)마다 한 번은 부른다 — 정리 시각이 최대 30분 늦을 뿐 결과는 같다.
   - 경로가 막 ready가 되면 목록이 바뀐 것이라 그 틱에 바로 동기화하고 확인한다(첫 알림이 늦지 않게).
   기억은 프로세스 메모리(회사·기기·계정마다) — 재시작하면 첫 틱에 한 번 동기화한다. 동기화가 실패하면 기억을 남기지 않아 다음 틱에 다시 한다. */
// 서버 쓰기 생략 기준(같은 내용·last_seen_at < now()-60초면 쓰기)과 같은 값을 쓰면 안 된다 — 60.0x초에 불러도 서버는 지연 흔들림으로 60초 이하로 보고
// 쓰기를 건너뛰어 실제 갱신이 약 120초 뒤로 밀린다(검수 1, #996). 기준보다 넉넉히 길게: 65초(test/msgr-notifications가 서버 기준 초과를 잠근다).
// 2026-10-16 로그 다이어트 1차: 회사별 알림 틱 30초→60초(NOTIFY_TICK_MS), 동기화 65초→120초. 10초 루프+60초 게이트에서 틱은 60~70초 간격이라 동기화는 120~140초마다(서버 3분=180초 신선도 안,
// 한 번 실패해도 다음 틱에 다시 — 그동안 ready가 잠깐 풀려도 알림은 대기열에 남아 늦을 뿐 사라지지 않는다).
export const ROUTE_SYNC_MS = 120_000;
export const NOTIFY_TICK_MS = 60_000; // 게이트웨이 회사별 알림 틱 최소 간격(gateway.mjs sync 10초 루프의 게이트) — 첫 알림 지연은 최대 60~70초
/** previous = 그 회사의 마지막 틱 기록({ busy, at }). 진행 중이거나 간격 안이면 건너뛴다. */
export function notificationTickDue(previous, t) { return !previous?.busy && t - (previous?.at ?? -Infinity) >= NOTIFY_TICK_MS; }
export const IDLE_CLAIM_MS = 30 * 60_000;
// 행마다 권한 확인(msgr_notification_authorize) 직전 노드 나이 상한 — 서버는 노드 last_seen_at이 3분(180초)을 넘으면 그 행을 skipped(재시도 없음)로 끝낸다
// (20260913110500). 틱 시작의 동기화만으로는 앞 행들의 send가 길어질 때(텔레그램 타임아웃 35초씩) 뒤 행의 나이가 기한을 넘을 수 있어(#1050 검수 1),
// 이 나이를 넘으면 그 행 확인 전에 경로를 다시 동기화한다. 평상시(send가 빠름)에는 추가 요청이 없다. 100초 = 기한까지 80초 여유(send 1회 + RPC).
export const NODE_FRESH_MS = 100_000;
const routeMemo = (globalThis.__argoNotifyRouteMemo ??= new Map()); // `${uid}:${wsId}:${device}` → { routes, syncedAt, claimedAt }
export function notificationPlan(memo, routes, t) {
  const key = JSON.stringify(routes);
  const ready = routes.some((r) => r.ready === true);
  const sync = !memo || memo.routes !== key || (ready && t - memo.syncedAt >= ROUTE_SYNC_MS);
  const claim = ready || !memo || t - (memo.claimedAt ?? -Infinity) >= IDLE_CLAIM_MS;
  return { key, ready, sync, claim };
}

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
  readAgents = listAgents, readDeviceId = getDeviceId, send, attempt = randomUUID(), memo = routeMemo, now = Date.now,
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
  const memoKey = `${c.uid}:${wsId}:${deviceId}`;
  const t = now();
  const plan = notificationPlan(memo.get(memoKey), routes, t);
  const syncRoutes = () => c.client.rpc('msgr_notification_routes_sync', { p_ws: wsId, p_routes: routes, p_device: deviceId });
  if (plan.sync) {
    const synced = await syncRoutes();
    if (missingRpc(synced.error)) return { available: false, reason: 'upgrade', deliveries: [] };
    if (synced.error) throw new Error('Notification connections could not be synchronized');
    memo.set(memoKey, { ...memo.get(memoKey), routes: plan.key, syncedAt: t });
    while (memo.size > 1000) memo.delete(memo.keys().next().value); // 회사·기기·계정 조합 상한
  }
  // 권한 확인 직전 노드 신선도(NODE_FRESH_MS 주석). 실패하면 기억을 남기지 않고 그대로 확인한다 — 판정은 서버가 하고, 이미 잡은 행을 버리지 않는다.
  const keepNodeFresh = async () => {
    const at = now();
    if (!plan.ready || at - (memo.get(memoKey)?.syncedAt ?? -Infinity) < NODE_FRESH_MS) return;
    const synced = await syncRoutes().catch(() => ({ error: true }));
    if (!synced?.error) memo.set(memoKey, { ...memo.get(memoKey), routes: plan.key, syncedAt: at });
  };
  // Do not claim work if no sender is installed. Claiming reserves one outbound
  // attempt; an interrupted/ambiguous attempt must not become a duplicate send.
  if (typeof send !== 'function') return { available: true, deliveries: [] };
  if (!plan.claim) return { available: true, deliveries: [], idle: true }; // ready 경로가 없고 정리 주기 전 — 확인할 것이 없다
  memo.set(memoKey, { ...memo.get(memoKey), claimedAt: t });
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
      await keepNodeFresh();
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
