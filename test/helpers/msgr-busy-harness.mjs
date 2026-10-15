// 바쁜 크루 보류(F2) 시나리오 하네스 — 같은 계정 기기 A·B가 서버 하나(커서·실행권·답글)를 나눠 쓴다.
// 실제 drain·makeMsgrHandler·큐 워커(startQueueWorker, 기기 A)를 쓰고 서버만 가짜다(네트워크·실 Supabase·러너 0).
// 배포본 코드와 새 코드에 같은 시나리오를 돌려 칸별로 비교한다(게이트 B — 경우 표는 PR 본문). 호출 전에 ARGO_ROOT를 임시 폴더로 둔다.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OWNER = '11111111-1111-4111-8111-111111111111', MEMBER = '22222222-2222-4222-8222-222222222222';
export const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', CH = 'bbbbbbbb-0000-4000-8000-000000000001', CREW = 'cccccccc-0000-4000-8000-000000000001';
const WS = 'lean-ax-t1';
const crew = (over = {}) => ({ id: CREW, org_id: ORG, slug: 'seoyun', display_name: '서윤', allow: 'all', allow_users: [], cursor_msg_id: 10, hosting: 'local', ...over });
function fakeDb({ crews = [crew()], messages = [], dm = [], member = null, chCrews = null, attachments = [], approvals = [], parent = null, dupReply = false, canDecide = true, approvalRows = [{ id: 'ap-row-1' }], canInstructThrows = false, channelPolicy = {}, docs = [], orgInfo = { id: ORG, slug: 'lean', name: '린 컴퍼니' }, crewRequests = [], crewDefaults = { runner: 'openrouter', model: 'm/x:free' }, context = [], peers = null, settledFn = () => false, autoTurns = 0, aiConsent = true, aiConsentMap = null, names = {}, stopRequestedBy = null, orgEntitled = true, orgEntitlementMarker = '2026-09-01T00:00:00.000Z' } = {}) {
  const calls = [];
  const executions = new Map();
  const rec = (k, ...a) => { calls.push([k, ...a]); };
  return {
    calls,
    // 조직 자격(2026-09-27 M6) — 기본 true(대부분 테스트는 자격과 무관). throw면 판정 실패를 흉내(호출부가 열어 둬야 한다).
    async orgEntitled(orgId) { rec('orgEntitled', orgId); if (orgEntitled === 'throw') throw new Error('rpc down'); return orgEntitled; },
    // 자격 만료 마커(2026-09-27 L2) — 안내 client_msg_id에 섞여 재만료 시 새 안내가 다시 뜨게 한다.
    async orgEntitlementMarker(orgId) { rec('orgEntitlementMarker', orgId); return orgEntitlementMarker; },
    async myCrews() { rec('myCrews'); return crews; },
    async crewBySlug(uid, ws, slug) { rec('crewBySlug', slug); return crews.find((c) => c.slug === slug) ?? null; },
    async heartbeat(ids) { rec('heartbeat', ids); },
    async myOrgIds() { return []; }, // 부록 M 인벤토리 미러 — 이 파일의 관심 밖(test/msgr-inventory.test.mjs)
    async nodeHeartbeat(org, info = null) { rec('nodeHeartbeat', org, info); },
    async pendingCrewRequests(org) { rec('pendingCrewRequests', org); return crewRequests; },
    async finishCrewRequest(id, patch) { rec('finishCrewRequest', id, patch); },
    async upsertCrew(row) { rec('upsertCrew', row); return { id: `crew-${row.slug}` }; },
    async crewDefaults(org) { rec('crewDefaults', org); return crewDefaults; },
    async setCursor(id, n) { rec('setCursor', id, n); },
    async messagesAfter(org, after) { rec('messagesAfter', org, after); return messages.filter((m) => m.id > after); },
    async message(id) { rec('message', id); return typeof parent === 'function' ? parent(id) : parent; },
    async crewChannels() { return dm; },
    async crewScope() { rec('crewScope'); return new Set(member ?? [...(dm ?? []), CH]); }, // 구성원 채널(기본 = DM + 기본 채널에 초대됨 — 2026-09-16부터 공개 채널도 초대된 에이전트만 답한다)
    async channelCrewMembers(ch) { rec('channelCrewMembers', ch); return new Set(chCrews ?? (peers ?? crews).map((c) => c.id)); }, // 기본 = 조직 크루 전원이 구성원(범위 테스트만 chCrews로 좁힌다)
    async channel(id) { rec('channel', id); return { id, org_id: ORG, kind: 'public', name: 'general', crew_memory: true, ...(this.channelOverride ?? {}) }; },
    async memberName(orgId, uid) { rec('memberName', orgId, uid); return names[uid] ?? '민수'; },
    // 크루 작업 중단(유건 확정 2026-09-26) — msgr_executions.stop_requested_by 조회 흉내.
    async executionStopInfo(crewId, sourceId) { rec('executionStopInfo', crewId, sourceId); return stopRequestedBy ? { stop_requested_by: stopRequestedBy, stop_requested_at: new Date().toISOString() } : null; },
    async contextOf(ch, before, n, after = [], opts = {}) { rec('contextOf', ch, before, n, after, opts); return context.filter((r) => opts.threadRoot == null || r.id === opts.threadRoot || r.thread_root === opts.threadRoot).filter((r) => r.id < before || (r.reply_to === before && after.includes(r.crew_id))).sort((a, b) => a.id - b.id).slice(-n); },
    async orgCrews(org) { rec('orgCrews', org); return (peers ?? crews).map((c) => ({ id: c.id, slug: c.slug, display_name: c.display_name, owner_user_id: c.owner_user_id ?? OWNER, ws_id: c.ws_id ?? WS })); },
    async settled(crewId, msgId, channelId, beforeId = null) { rec('settled', crewId, msgId, channelId, beforeId); if (!channelId) throw new Error('settled: channelId 필수(인덱스 선두열)'); return settledFn(crewId, msgId, beforeId); },
    async autoTurnsIn(rootId, channelId) { rec('autoTurnsIn', rootId, channelId); if (!channelId) throw new Error('autoTurnsIn: channelId 필수'); return autoTurns; },
    async crewOwner(id) { rec('crewOwner', id); return crews.find((c) => c.id === id)?.owner_user_id ?? OWNER; },
    async insertMessage(row) { rec('insertMessage', row); return dupReply && row.client_msg_id?.startsWith('reply:') ? null : { id: 900 + calls.length }; },
    async claimExecution(key) {
      rec('claimExecution', key);
      const id = `${key.crewId}:${key.msgId}`, previous = executions.get(id);
      if (dupReply) return { acquired: false, state: 'completed', reply_id: 899 };
      if (previous) return { acquired: false, state: previous.row ? 'completed' : 'running', reply_id: previous.row?.id, heartbeat_at: new Date().toISOString() };
      executions.set(id, { attempt: key.attempt });
      return { acquired: true, state: 'running', heartbeat_at: new Date().toISOString() };
    },
    async finishExecution(key, row) {
      const execution = executions.get(`${key.crewId}:${key.msgId}`);
      if (!execution || execution.attempt !== key.attempt) throw new Error('execution owner mismatch');
      if (!execution.row) execution.row = await this.insertMessage(row);
      return execution.row;
    },
    async heartbeatExecution(key) { rec('heartbeatExecution', key); return true; },
    async attachmentsOf() { return attachments; },
    async insertAttachment(row) { rec('insertAttachment', row); },
    async download(path) { rec('download', path); return Buffer.from('PNGDATA'); },
    async upload(path, buf, ct) { rec('upload', path, buf.length, ct); },
    async insertApproval(row) { rec('insertApproval', row); return { id: 'ap-row-1' }; },
    async updateApproval(id, patch) { rec('updateApproval', id, patch); return approvalRows; },
    async approvalsByIds(ids) { rec('approvalsByIds', ids); return approvals; },
    // H-2: 서버 판정 흉내 — 실제 msgr_can_instruct와 같은 규칙(크루 행 기준). throw 시 브리지는 로컬 판정으로 폴백한다.
    async instructCheck(crewId, authorId, channelId) { rec('instructCheck', crewId, authorId, channelId); return 'ok'; }, // 하네스는 makeServer에서 다시 덮어쓴다 — 지시 권한은 관심 밖
    // App Store 5.1.2 재설계(2026-09-27) — 기본 동의됨(기존 시나리오 회귀 방지). aiConsentMap으로 사람별, aiConsent:false로 전원 미동의를 흉내낸다.
    async orgConsentOk(orgId, userId) { rec('orgConsentOk', orgId, userId); return aiConsentMap ? !!aiConsentMap[userId] : aiConsent; },
    async canDecide(apId) { rec('canDecide', apId); return canDecide; },
    // G-2 조직 문서 미러 — 기본은 문서 0(드레인 테스트가 미러로 오염되지 않게)
    async org(orgId) { rec('org', orgId); return orgInfo; },
    async docsIndex(orgId) { rec('docsIndex', orgId); return docs.map(({ id, channel_id, path, version, updated_at }) => ({ id, channel_id, path, version, updated_at })); },
    async docsByIds(ids) { rec('docsByIds', ids); return docs.filter((d) => ids.includes(d.id)); },
  };
}


export async function seedCompany(paths, ws) {
  const p = paths(ws);
  for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files]) await mkdir(d, { recursive: true });
  await writeFile(p.company, JSON.stringify({ id: ws, name: '린', lang: 'ko', created: '2026-09-03' }));
  await writeFile(join(p.root, 'agents', 'seoyun.md'), '---\nname: 서윤\nrole: 마케터\n---\n');
}

/** 서버 하나 — 크루 행(커서)·받은 글·실행권·답글을 기기들이 나눠 쓴다. 기기별 호출을 센다. */
export function makeServer() {
  const row = crew();
  const messages = []; const executions = new Map(); const posted = []; const counts = {};
  const bump = (who, k) => { counts[who] ??= {}; counts[who][k] = (counts[who][k] ?? 0) + 1; };
  const dbFor = (who) => {
    const db = fakeDb({ crews: [row], messages });
    const wrap = (k, fn) => async (...a) => { bump(who, k); return fn(...a); };
    db.myCrews = wrap('myCrews', async () => [row]);
    db.messagesAfter = wrap('inbox', async (_org, after) => messages.filter((m) => m.id > after));
    db.setCursor = wrap('setCursor', async (_id, n) => { if (n > row.cursor_msg_id) row.cursor_msg_id = n; });
    db.heartbeat = wrap('heartbeat', async () => {});
    db.instructCheck = wrap('instructCheck', async () => 'ok'); // 지시 권한은 이 하네스의 관심 밖 — 작성자는 허용 멤버
    db.claimExecution = wrap('claimExecution', async (key) => {
      const id = `${key.crewId}:${key.msgId}`, prev = executions.get(id);
      if (prev) return { acquired: false, state: prev.row ? 'completed' : 'running', reply_id: prev.row?.id, heartbeat_at: new Date().toISOString() };
      executions.set(id, { attempt: key.attempt, who, beat: Date.now() });
      return { acquired: true, state: 'running', heartbeat_at: new Date().toISOString() };
    });
    db.heartbeatExecution = wrap('heartbeatExecution', async (key) => { const ex = executions.get(`${key.crewId}:${key.msgId}`); if (ex) ex.beat = Date.now(); return true; });
    db.crewRunningBeat = wrap('crewRunningBeat', async (crewId) => { // 실제 쿼리처럼 기기 구분 없이 이 크루의 실행 중 행 중 최근 심박
      const beats = [...executions.entries()].filter(([k, ex]) => k.startsWith(`${crewId}:`) && !ex.row).map(([, ex]) => ex.beat);
      return beats.length ? new Date(Math.max(...beats)).toISOString() : null;
    });
    db.finishExecution = wrap('finishExecution', async (key, r) => {
      const ex = executions.get(`${key.crewId}:${key.msgId}`);
      if (!ex || ex.attempt !== key.attempt) throw new Error('execution owner mismatch');
      if (!ex.row) { ex.row = { id: 5000 + posted.length }; posted.push({ who, msgId: key.msgId, at: Date.now(), body: r.body }); }
      return ex.row;
    });
    db.insertMessage = wrap('insertMessage', async (r) => ({ id: 9000 + (counts[who].insertMessage ?? 0), ...r }));
    return db;
  };
  let nextId = 11;
  const send = () => { const m = { id: nextId++, channel_id: CH, author_kind: 'user', author_user_id: MEMBER, crew_id: null, kind: 'text', body: `m${nextId - 1}`, mentions: [{ kind: 'crew', id: CREW }], reply_to: null, thread_root: null, created_at: new Date().toISOString() }; messages.push(m); return m.id; };
  return { row, messages, executions, posted, counts, dbFor, send };
}
export { WS };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (text) => Number(String(text).match(/\bm(\d+)\b/)?.[1]);

/** 기기 하나 — 실제 drain·핸들러. queue=true면 실제 큐 워커(파일 큐), 아니면 적재 즉시 핸들러(한가한 기기 B).
    브리지 흉내: 글 도착(방송) 때 drain, 직전 drain이 보류(held)면 pollMs마다 drain. 새 코드의 턴 끝 깨우기(setMsgrWake)가 있으면 그것도 drain. */
export async function startDevice({ M, Q, server, who, ws, turnMs, pollMs, queue = true }) {
  const db = server.dbFor(who);
  const starts = [];
  const runChat = async (_ws, _slug, text) => { starts.push({ id: idOf(text), at: Date.now() }); await sleep(turnMs); return { reply: `답 ${idOf(text)}`, sessionId: null, artifacts: [] }; };
  const handler = M.makeMsgrHandler(ws, { session: async () => ({ db, uid: OWNER }), runChat, linkPreview: async () => null });
  let alive = true, held = false, drains = 0, running = null, again = false;
  const enqueue = queue ? undefined : async (_ws, _key, _id, job) => { if (alive) await handler(job, {}); };
  const drainOnce = async () => {
    if (!alive) return;
    if (running) { again = true; return running; }
    running = (async () => { do { again = false; drains++; const rep = {}; await M.drain(ws, { db, uid: OWNER, report: rep, ...(enqueue ? { enqueue } : {}) }); held = !!rep.held; } while (again && alive); })().finally(() => { running = null; });
    return running;
  };
  const stopWorker = queue ? Q.startQueueWorker(ws, M.MSGR_KEY, handler) : () => {};
  const iv = setInterval(() => { if (held) drainOnce().catch(() => {}); }, pollMs); iv.unref?.(); // 시험이 실패해도 프로세스를 붙잡지 않게
  if (M.setMsgrWake) M.setMsgrWake(ws, () => { drainOnce().catch(() => {}); });
  const kill = () => { if (!alive) return; alive = false; clearInterval(iv); stopWorker(); if (M.setMsgrWake) M.setMsgrWake(ws, null); };
  const dev = { db, starts, drainOnce, kill, stats: () => ({ drains }) };
  live.add(dev);
  return dev;
}

const live = new Set();
/** 시험 하나가 끝날 때(실패해도) 켠 기기를 모두 끈다 — afterEach에서 부른다. */
export function killAll() { for (const d of live) d.kill(); live.clear(); }

/** 서버가 답을 n개 받을 때까지(또는 시간 상한) 기다린다. */
export async function waitPosted(server, n, limitMs = 60_000) {
  const t0 = Date.now();
  while (server.posted.length < n && Date.now() - t0 < limitMs) await sleep(50);
  return server.posted.length >= n;
}
/** 기기가 턴을 n개 시작할 때까지(또는 시간 상한) 기다린다. 상한 없는 대기는 턴이 안 시작되는 환경에서 CI를 한 시간 넘게 붙잡았다(메신저 0.1.62 빌드 run 38670345810, 맥 두 잡). */
export async function waitStarted(dev, n = 1, limitMs = 20_000) {
  const t0 = Date.now();
  while (dev.starts.length < n && Date.now() - t0 < limitMs) await sleep(50);
  return dev.starts.length >= n;
}
export { sleep };
