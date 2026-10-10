// 게이트웨이 응답 지연 시나리오(#943 게이트 B — 유건 10/11 "어떤 경우에도 지금보다 답이 늦으면 안 된다").
// 실제 startMsgrBridge(새 코드든 main 사본이든 같은 모듈 모양)를 가짜 시계(setInterval·Date)와 가짜 서버로 돌려
// "글(이벤트)이 생긴 때 → 게이트웨이가 그것을 처음 읽은 때"를 잰다. 가짜 서버는 운영 방송 규칙을 따른다:
//   공개 채널 글·조직 크루 요청 = org:<조직>, 비공개 방·DM·개인 공간·에이전트 1:1 글·결재 = 주인 u:<uid>, 중단 = u: stop_request,
//   에이전트 active 전환·조직 가입 = u: crew_sync(20261010232100 — serverWakes가 참일 때만 보낸다).
// 방송은 그 토픽에 붙어 있는(joined) 채널에만 닿고, 못 받은 방송은 다시 오지 않는다. Realtime이 내려가면 채널은 errored로 남고
// realtime-js처럼 스스로 다시 붙지 않는다(disconnect → connect를 불러야 붙는다 — 2026-10-10 실측).

export const KINDS = ['공개 채널', '비공개 방', 'DM', '개인 공간', '에이전트 1:1', '결재', '크루 요청', '중단'];
export const STATES = ['정상 연결', '새 조직 직후', '재개 직후', '토큰 회전 직후', '끊김 중', '끊김→복구 직후'];
const UID = '11111111-1111-4111-8111-111111111111';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', ORG2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const crewRow = (n, org, slug) => ({ id: `cccccccc-0000-4000-8000-00000000000${n}`, org_id: org, slug, display_name: slug, role_text: null, allow: 'all', allow_users: [], cursor_msg_id: 0, hosting: 'local', status: 'active' });
const POLL = 15_000;

/** 한 칸 — 걸린 시간(ms). M = msgr 모듈, mock = node:test mock, ws = 이미 만든 회사(카드 'c1' 있음), serverWakes = 서버가 crew_sync를 보내나 */
export async function latencyCell(M, { kind, state, offset, mock, ws, serverWakes = true }) {
  const CREW = crewRow(1, ORG, 'c1'), CREW2 = crewRow(2, ORG2, 'c1');
  const S = { up: true, members: [ORG], rows: [CREW], active: new Set([CREW.id]), inbox: [], seen: new Map(), stopSeen: null, drains: [], nextId: 100, clients: [] };
  const crews = () => S.rows.filter((r) => S.active.has(r.id));
  const now = () => Date.now();
  const deliver = (topic, event, payload = {}) => { for (const cl of S.clients) for (const ch of cl.chans) if (ch.topic === topic && ch.state === 'joined') ch.handlers[event]?.({ payload }); };
  const wakeOwner = () => { if (serverWakes) deliver(`u:${UID}`, 'crew_sync'); };
  const impl = {
    myCrews: async () => { S.drains.push(now()); return crews(); },
    crewInbox: async (_ws, crewId) => { const got = S.inbox.filter((m) => m.crew === crewId); for (const m of got) if (!S.seen.has(m.id)) S.seen.set(m.id, now()); return got; },
    crewMemberships: async (ids) => new Map(ids.map((id) => [id, { dm: new Set(), member: new Set() }])),
    setCursor: async (crewId, max) => { S.inbox = S.inbox.filter((m) => !(m.crew === crewId && m.id <= max)); },
    heartbeat: async () => ({ device: true }),
    channelAccess: async () => new Map(), crewPresence: async () => new Map(),
    myOrgIds: async () => S.members, myCrewRows: async () => S.rows, canInsertCrews: async () => true,
    upsertAvailable: async (rows) => { for (const r of rows) if (r.org_id === ORG2 && !S.rows.some((x) => x.id === CREW2.id)) { S.rows.push(CREW2); S.active.add(CREW2.id); wakeOwner(); } return rows; }, // 서버 insert 트리거 → crew_sync
    insertPersonal: async (rows) => rows,
    executionStopInfo: async () => { S.stopSeen ??= now(); return null; },
    wakeProtocol: async () => (serverWakes ? 1 : 0),
  };
  const db = new Proxy({}, { get: (_, k) => (typeof k !== 'string' || k === 'then') ? undefined : async (...a) => (impl[k] ? impl[k](...a) : []) });
  const newClient = () => {
    const cl = { chans: [], realtime: null };
    cl.channel = (topic) => {
      const ch = { topic, state: 'closed', handlers: {}, on(_t, { event }, fn) { this.handlers[event] = fn; return this; },
        subscribe(cb) { this.cb = cb ?? this.cb; this.state = 'joining'; if (S.up) queueMicrotask(() => { if (this.state === 'joining') { this.state = 'joined'; this.cb?.('SUBSCRIBED'); } }); return this; },
        unsubscribe() { this.state = 'closed'; } };
      cl.chans.push(ch); return ch;
    };
    cl.rpc = async () => ({ data: [], error: null });
    cl.realtime = { isConnected: () => S.up && cl.sockUp !== false, async disconnect() { cl.sockUp = false; }, connect() { if (!S.up) return; cl.sockUp = true; for (const ch of cl.chans) if (ch.state === 'errored') { ch.state = 'joined'; ch.cb?.('SUBSCRIBED'); } } };
    S.clients.push(cl); return cl;
  };
  let client = newClient();
  const stop = M.startMsgrBridge(ws, { session: async () => ({ uid: UID, db, client }), pollMs: POLL, runnerReady: null, localState: async () => 'L0' });
  const settle = async () => { for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 8)); await new Promise((r) => setImmediate(r)); } };
  const tick = async (ms, unit = 1000) => { for (let t = 0; t < ms;) { const step = Math.min(unit, ms - t); mock.timers.tick(step); t += step; await settle(); } };
  try {
    for (let i = 0; i < 400 && !client.chans.some((c) => c.topic === `u:${UID}`); i++) await new Promise((r) => setTimeout(r, 25));
    await settle(); await tick(60_000, POLL); // 시작·구독·쉬는 주기 진입
    const down = () => { S.up = false; for (const cl of S.clients) { cl.sockUp = false; for (const ch of cl.chans) if (ch.state === 'joined' || ch.state === 'joining') { ch.state = 'errored'; ch.cb?.('CHANNEL_ERROR'); } } };
    let target = { crew: CREW.id, org: ORG };
    if (state === '새 조직 직후') { S.members = [ORG, ORG2]; wakeOwner(); target = { crew: CREW2.id, org: ORG2 }; await tick(1_000); } // 초대 수락 → 미러가 새 조직에 파견해야 받는다
    else if (state === '재개 직후') { S.rows.push(CREW2); await tick(0); S.active.add(CREW2.id); wakeOwner(); target = { crew: CREW2.id, org: ORG2 }; await tick(1_000); } // paused → active(서버)
    else if (state === '토큰 회전 직후') { for (const ch of client.chans) ch.state = 'closed'; client = newClient(); await tick(1_000); }
    else if (state === '끊김 중') { down(); await tick(5_000); }
    else if (state === '끊김→복구 직후') { down(); await tick(45_000, POLL); S.up = true; await tick(1_000); }
    await tick(offset);
    const t0 = now(); const id = S.nextId++;
    const uTopic = `u:${UID}`, orgTopic = `org:${target.org}`;
    if (kind === '중단') deliver(uTopic, 'stop_request', { crew_id: CREW.id, source_msg_id: 1 }); // 중단은 이미 돌던 턴 — 예전부터 있던 에이전트
    else if (kind === '결재') deliver(uTopic, 'approval', { id });
    else if (kind === '크루 요청') deliver(orgTopic, 'crew_request', { id });
    else { S.inbox.push({ id, crew: target.crew, channel_id: 'bbbbbbbb-0000-4000-8000-000000000001', author_kind: 'user', author_user_id: UID, crew_id: null, kind: 'text', body: 'x', mentions: [], reply_to: null, thread_root: null, created_at: new Date(t0).toISOString() });
      deliver(kind === '공개 채널' ? orgTopic : uTopic, 'message', { id }); }
    await settle();
    for (let i = 0; i < 200; i++) {
      const done = kind === '중단' ? S.stopSeen != null : (kind === '결재' || kind === '크루 요청') ? S.drains.some((d) => d >= t0) : S.seen.has(id);
      if (done) break;
      await tick(1_000);
    }
    const at = kind === '중단' ? S.stopSeen : (kind === '결재' || kind === '크루 요청') ? S.drains.find((d) => d >= t0) : S.seen.get(id);
    return at == null ? Infinity : at - t0; // Infinity = 200초 안에 못 읽음(못 받은 방송을 다시 보지 않는 경로 — 중단)
  } finally { stop(); }
}
