// 메신저 게이트웨이의 받은 글 조회를 회사(작업 공간) 단위로 묶기 — 2026-10-09 운영 실측(읽기 전용): msgr_crew_inbox RPC 분당 약 2,350회,
// 에이전트 200명 계정 하나가 10분에 10,828회. 원인은 drain이 15초 틱·방송 깨우기마다 에이전트 한 명당 받은 글 RPC 1회(동시 8).
// 바뀐 규칙: 받은 글은 msgr_crew_inbox_many로 묶음(INBOX_BATCH명)마다 한 번. 서버에 함수가 없으면(옛 서버·적용 전 운영) 이 프로세스 동안 에이전트별 옛 경로.
// 이 파일은 makeDb(가짜 supabase 클라이언트의 rpc) → drain 전체를 돌려 요청 수·적재·커서·실패 의미가 옛 에이전트별 경로와 같은지 잠근다.
// 서버 함수 자체의 결과 동일성·권한·유휴 쓰기는 test/msgr-crew-inbox-many-pg.test.mjs(실 Postgres). 실 Supabase·실데이터 미접촉(임시 ARGO_ROOT).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-inbox-batch-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { paths } = await import('../src/workspace.mjs');

const WS = 'inbox-ws';
const OWNER = '11111111-1111-4111-8111-111111111111', FRIEND = '22222222-2222-4222-8222-222222222222';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', ORG2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const p = paths(WS);
for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files]) await mkdir(d, { recursive: true });
await writeFile(p.company, JSON.stringify({ id: WS, name: '받은 글 묶음', lang: 'ko', created: '2026-10-09', ownerId: OWNER }));

const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const crewId = (n) => uuid('cccccccc', n);
const chId = (n) => uuid('bbbbbbbb', n);
const orgCrew = (n, over = {}) => ({ id: crewId(n), org_id: ORG, slug: `c${n}`, display_name: `에이전트${n}`, allow: 'all', allow_users: [], cursor_msg_id: 0, hosting: 'local', ...over });
const userMsg = (id, channel, over = {}) => ({ id, channel_id: channel, author_kind: 'user', author_user_id: OWNER, crew_id: null, kind: 'text', body: `m${id}`,
  mentions: [], reply_to: null, thread_root: null, meta: {}, created_at: new Date().toISOString(), deleted_at: null, ...over });
const to = (n, role = 'to') => ({ kind: 'crew', id: crewId(n), role });

beforeEach(() => M._resetInboxManyForTest());

/** 가짜 서버 — 받은 글은 serverInbox(crew, after, limit)가 정한다(에이전트마다 옛 msgr_crew_inbox와 같은 계약: id 오름차순·앞 limit개).
    rpc('msgr_crew_inbox_many')는 같은 serverInbox로 묶음 응답(글은 한 번씩 + 에이전트별 id)을 만든다 — 실제 서버 함수의 동일성은 pg 시험이 잠근다.
    mode: 'ok' | 'missing'(PGRST202) | 'undefined-fn'(42883) | 'fail'(XX000) | (items) => 위 중 하나 */
function fakeServer({ serverInbox, mode = 'ok', forbidden = new Set() }) {
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'msgr_crew_inbox') {
        if (forbidden.has(args.p_crew)) return { data: null, error: { code: '42501', message: 'msgr_execution_forbidden' } };
        return { data: serverInbox(args.p_crew, args.p_after, args.p_limit), error: null };
      }
      if (name === 'msgr_crew_inbox_many') {
        const m = typeof mode === 'function' ? mode(args.p_items) : mode;
        if (m === 'missing') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.msgr_crew_inbox_many' } };
        if (m === 'undefined-fn') return { data: null, error: { code: '42883', message: 'function public.msgr_crew_inbox_many does not exist' } };
        if (m === 'fail') return { data: null, error: { code: 'XX000', message: 'fake outage' } };
        const messages = new Map();
        const crews = args.p_items.map(({ crew, after }) => {
          if (forbidden.has(crew)) return { crew, forbidden: true };
          const rows = serverInbox(crew, after, args.p_limit);
          for (const r of rows) messages.set(r.id, r);
          return { crew, ids: rows.map((r) => r.id) };
        });
        return { data: { messages: [...messages.values()].sort((a, b) => a.id - b.id), crews }, error: null };
      }
      return { data: null, error: { code: 'PGRST202', message: `no fake rpc ${name}` } };
    },
    from: () => { throw new Error('이 시험은 표를 직접 읽지 않는다'); },
  };
  return { client, calls, inboxCalls: () => calls.filter((c) => c.name === 'msgr_crew_inbox'), manyCalls: () => calls.filter((c) => c.name === 'msgr_crew_inbox_many') };
}

/** drain용 db — 받은 글(crewInbox·crewInboxMany)은 makeDb 그대로(가짜 rpc), 나머지는 기록하는 가짜. */
function drainDb(srv, { crews, channels, rooms, personalInRooms = new Set(), legacy = false }) {
  const calls = [];
  const real = M.makeDb(srv.client);
  const db = {
    calls,
    crewInbox: real.crewInbox,
    ...(legacy ? {} : { crewInboxMany: real.crewInboxMany }),
    async myCrews() { return crews; },
    async personalCrewsInRooms(ids) { return new Set(ids.filter((id) => personalInRooms.has(id))); },
    async crewMemberships(ids) { calls.push(['crewMemberships', ids.length]); return new Map(ids.map((id) => [id, rooms(id)])); },
    async setCursor(id, n) { calls.push(['setCursor', id, n]); },
    async channel(id) { const c = channels[id]; return c ? { id, name: 'ch', crew_memory: true, archived_at: null, excluded_crew_ids: [], kind: c.kind, org_id: c.org_id } : null; },
    async message() { return null; },
    async instructCheck() { return 'ok'; },
    async orgEntitled() { return true; },
    async orgConsentOk() { return true; },
    async personalConsentOk() { return true; },
    async crewOwner() { return OWNER; },
    async insertMessage(row) { calls.push(['insertMessage', row.client_msg_id]); return { id: 9999 }; },
    async approvalsByIds() { return []; },
  };
  return db;
}
const enqueueRec = () => { const jobs = []; const fn = async (_ws, _k, _id, job) => { jobs.push(job); }; fn.jobs = jobs; return fn; };
const run = (db, enq = enqueueRec()) => M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null }).then((r) => ({ r, enq }));
const cursors = (db) => db.calls.filter((c) => c[0] === 'setCursor').map((c) => [c[1], c[2]]);
const jobs = (enq) => enq.jobs.map((j) => [j.msgId, j.slug]);
const notes = (db) => db.calls.filter((c) => c[0] === 'insertMessage').map((c) => c[1]);

/** 조직 에이전트 n명(각자 조직 DM 1개 + 공개 채널) + 방에 든 개인 에이전트 1명(크루 1:1). 받은 글: 조직 에이전트 = 조직 글 전부, 개인 = 자기 방. */
function fixture(n, msgsOf) {
  const PUB = chId(1), PDM = chId(2);
  const channels = { [PUB]: { kind: 'public', org_id: ORG }, [PDM]: { kind: 'dm', org_id: null } };
  const crews = [];
  for (let i = 0; i < n; i++) { channels[chId(1000 + i)] = { kind: 'dm', org_id: ORG }; crews.push(orgCrew(i)); }
  const CP = crewId(9999);
  crews.push(orgCrew(9999, { org_id: null, allow: 'owner' }));
  const rooms = (id) => (id === CP ? { dm: new Set([PDM]), member: new Set([PDM]) } : { dm: new Set([chId(1000 + Number(id.slice(-12)))]), member: new Set([PUB, chId(1000 + Number(id.slice(-12)))]) });
  const all = msgsOf({ PUB, PDM, dmOf: (i) => chId(1000 + i) }).sort((a, b) => a.id - b.id);
  const serverInbox = (crew, after, limit) => {
    const lim = Math.max(1, Math.min(limit ?? 200, 200));
    const mine = crew === CP ? all.filter((m) => m.channel_id === PDM) : all.filter((m) => m.channel_id !== PDM);
    return mine.filter((m) => m.id > after).slice(0, lim).map((m) => structuredClone(m)); // 응답마다 새 객체(JSON 왕복)
  };
  return { PUB, PDM, channels, crews, CP, rooms, serverInbox, personalInRooms: new Set([CP]) };
}

// ① 틱당 받은 글 요청 = 묶음 수(크루 수와 무관). 유휴(받은 글 0)도, 받은 글이 있어도 같다.
for (const [n, want] of [[1, 1], [50, 1], [99, 1], [100, 2], [200, 3]]) {
  test(`받은 글 요청은 묶음 수만큼 — 조직 에이전트 ${n}명 + 개인 1명 → 일괄 ${want}회·에이전트별 0회(종전 ${n + 1}회), 유휴·받은 글 있음 둘 다`, async () => {
    for (const busy of [false, true]) {
      const f = fixture(n, ({ PUB }) => (busy ? [userMsg(201, PUB, { mentions: [to(0)] })] : []));
      const srv = fakeServer({ serverInbox: f.serverInbox });
      const db = drainDb(srv, f);
      const { enq } = await run(db);
      assert.equal(srv.manyCalls().length, want, `일괄 ${srv.manyCalls().length}회`);
      assert.equal(srv.inboxCalls().length, 0, '에이전트별 받은 글 RPC 없음');
      assert.ok(srv.manyCalls().every((c) => c.args.p_items.length <= M.INBOX_BATCH && c.args.p_limit === M.PAGE && c.args.p_ws === WS));
      assert.deepEqual(srv.manyCalls().flatMap((c) => c.args.p_items.map((i) => i.crew)), f.crews.map((c) => c.id), '에이전트마다 한 번씩, 순서대로');
      if (busy) { assert.deepEqual(jobs(enq), [[201, 'c0']]); assert.equal(cursors(db).length, n, '조직 에이전트 모두 커서 전진(개인은 받은 글 없음)'); }
      else { assert.deepEqual(jobs(enq), []); assert.deepEqual(cursors(db), []); }
    }
  });
}

// ② 섞인 픽스처 — 일괄 경로와 옛 에이전트별 경로의 적재·커서·안내가 같다. 한 틱 limit(PAGE)를 넘는 글·DM·참조·개인 1:1·커서가 서로 다른 에이전트 포함
test('적재·커서·안내가 일괄 경로와 옛 에이전트별 경로에서 같다 — 섞인 픽스처(PAGE 초과·DM·참조·개인 1:1·서로 다른 커서), 세 틱 연속', async () => {
  const build = () => fixture(4, ({ PUB, PDM, dmOf }) => {
    const out = [];
    let id = 100;
    for (let i = 0; i < 70; i++) out.push(userMsg(++id, PUB, { mentions: i % 9 === 0 ? [to(i % 4)] : [] })); // PAGE(50)를 넘는 조직 글
    out.push(userMsg(++id, dmOf(1))); // c1 DM — 멘션 없어도 대상
    out.push(userMsg(++id, dmOf(2), { mentions: [to(2, 'cc')] })); // c2 참조 — 적재 없음(봉투 없는 로컬 판정에선 지나간다)
    out.push(userMsg(++id, PUB, { mentions: [to(3), to(0, 'cc')] }));
    out.push(userMsg(++id, PDM)); out.push(userMsg(++id, PDM, { author_user_id: FRIEND }));
    out.push(userMsg(++id, PUB, { kind: 'system', mentions: [to(1)] })); // 시스템 글 — 대상 아님
    return out;
  });
  const states = { batch: build(), legacy: build() };
  for (const s of Object.values(states)) { s.crews[1].cursor_msg_id = 140; s.crews[3].cursor_msg_id = 160; } // 서로 다른 커서
  const out = { batch: [], legacy: [] };
  for (let tick = 0; tick < 3; tick++) {
    for (const k of ['batch', 'legacy']) {
      const f = states[k];
      const srv = fakeServer({ serverInbox: f.serverInbox });
      const db = drainDb(srv, { ...f, legacy: k === 'legacy' });
      const { enq } = await run(db);
      out[k].push({ jobs: jobs(enq), cursors: cursors(db), notes: notes(db) });
      assert.equal((k === 'batch' ? srv.manyCalls() : srv.inboxCalls()).length, k === 'batch' ? 1 : f.crews.length);
      for (const [id, v] of cursors(db)) f.crews.find((c) => c.id === id).cursor_msg_id = v; // 다음 틱은 전진한 커서로
    }
  }
  assert.deepEqual(out.batch, out.legacy);
  assert.ok(out.batch[0].jobs.length > 3 && out.batch[1].jobs.length > 0, `틱마다 적재: ${out.batch.map((t) => t.jobs.length)}`);
  assert.ok(out.batch[0].cursors.some(([, v]) => v === 150), '한 틱에 PAGE(50)개까지 — 커서 0 → 150');
});

// ③ 서버에 일괄 함수가 없으면(옛 서버·적용 전 운영) 옛 경로 — 같은 결과, 이 프로세스에서는 다시 묻지 않는다
for (const mode of ['missing', 'undefined-fn']) {
  test(`서버에 일괄 함수가 없으면(${mode === 'missing' ? 'PGRST202' : '42883'}) 같은 틱에 에이전트별 옛 경로로 — 결과 같음, 다음 틱부터 일괄을 다시 묻지 않는다`, async () => {
    const f = fixture(120, ({ PUB, dmOf }) => [userMsg(301, PUB, { mentions: [to(5)] }), userMsg(302, dmOf(110))]);
    const srv = fakeServer({ serverInbox: f.serverInbox, mode });
    const warns = []; const cw = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    try {
      const db = drainDb(srv, f);
      const { enq } = await run(db);
      assert.equal(srv.manyCalls().length, 1, '첫 묶음에서 없음을 알면 나머지 묶음은 묻지 않는다');
      assert.equal(srv.inboxCalls().length, f.crews.length, '에이전트별 옛 경로');
      const legacy = fakeServer({ serverInbox: f.serverInbox });
      const ldb = drainDb(legacy, { ...f, legacy: true });
      const { enq: le } = await run(ldb);
      assert.deepEqual(jobs(enq), jobs(le)); assert.deepEqual(cursors(db), cursors(ldb));
      assert.deepEqual(jobs(enq).sort(), [[301, 'c5'], [302, 'c110']].sort());
      const db2 = drainDb(srv, f); await run(db2);
      assert.equal(srv.manyCalls().length, 1, '같은 프로세스의 다음 틱은 일괄을 다시 묻지 않는다');
      assert.equal(srv.inboxCalls().length, 2 * f.crews.length);
      assert.equal(warns.filter((w) => w.includes('받은 글 일괄 조회')).length, 1, '안내 로그는 한 번');
    } finally { console.warn = cw; }
  });
}

// ④ 일괄 실패 — 받은 글 조회 실패로 처리(커서 유지). 앞 묶음은 종전처럼 처리되고 실패한 묶음의 첫 에이전트 차례에 던진다
test('일괄 호출이 실패하면 받은 글 조회 실패 — 적재 0·커서 유지·drain 실패, 다음 틱 회복', async () => {
  const f = fixture(3, ({ PUB }) => [userMsg(401, PUB, { mentions: [to(0)] })]);
  const srv = fakeServer({ serverInbox: f.serverInbox, mode: 'fail' });
  const db = drainDb(srv, f); const enq = enqueueRec();
  await assert.rejects(M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null }), (e) => /fake outage/.test(e.message) && e.code === 'XX000');
  assert.deepEqual(jobs(enq), []); assert.deepEqual(cursors(db), [], '커서 유지');
  assert.equal(srv.inboxCalls().length, 0, '실패를 옛 경로 전환으로 오해하지 않는다');
  const ok = fakeServer({ serverInbox: f.serverInbox });
  const db2 = drainDb(ok, f); const { enq: e2 } = await run(db2);
  assert.deepEqual(jobs(e2), [[401, 'c0']]); assert.equal(cursors(db2).length, 3);
});

test('둘째 묶음만 실패 — 첫 묶음 에이전트는 처리·커서 전진, 둘째 묶음 첫 에이전트 차례에 던진다(종전 "실패한 에이전트 차례에 던짐"과 같은 모양)', async () => {
  const f = fixture(150, ({ PUB }) => [userMsg(501, PUB, { mentions: [to(0), to(120)] })]);
  const srv = fakeServer({ serverInbox: f.serverInbox, mode: (items) => (items[0].crew === crewId(M.INBOX_BATCH) ? 'fail' : 'ok') });
  const db = drainDb(srv, f); const enq = enqueueRec();
  await assert.rejects(M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null }), /fake outage/);
  assert.deepEqual(jobs(enq), [[501, 'c0']], '첫 묶음의 c0만 적재');
  assert.equal(cursors(db).length, M.INBOX_BATCH, '첫 묶음 에이전트만 커서 전진');
  assert.ok(cursors(db).every(([id]) => Number(id.slice(-12)) < M.INBOX_BATCH));
});

test('거절된 에이전트(서버 42501 표시)는 그 에이전트 차례에 옛 오류와 같은 코드·문구로 던진다 — 앞 에이전트는 처리', async () => {
  const f = fixture(3, ({ PUB }) => [userMsg(601, PUB, { mentions: [to(0), to(2)] })]);
  const errOf = async (legacy) => {
    const db = drainDb(fakeServer({ serverInbox: f.serverInbox, forbidden: new Set([crewId(1)]) }), { ...f, legacy }); const enq = enqueueRec();
    const e = await M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null }).then(() => null, (x) => x);
    return { e, jobs: jobs(enq), cursors: cursors(db) };
  };
  const a = await errOf(false), b = await errOf(true);
  assert.ok(a.e && b.e); assert.equal(a.e.code, '42501'); assert.equal(a.e.code, b.e.code); assert.equal(a.e.message, b.e.message);
  assert.deepEqual(a.jobs, b.jobs); assert.deepEqual(a.cursors, b.cursors);
  assert.deepEqual(a.jobs, [[601, 'c0']]); assert.deepEqual(a.cursors, [[crewId(0), 601]]);
});

// ⑤ 어댑터 — 요청 모양·응답 풀기
test('makeDb.crewInboxMany — 요청은 { p_ws, p_items:[{crew, after}], p_limit: PAGE }, 응답의 공유 글은 에이전트마다 따로 된 객체, 빠진 글·빈 응답은 오류', async () => {
  const shared = userMsg(701, chId(1), { mentions: [to(0)], meta: { a: 1 } });
  const calls = [];
  const client = (data, error = null) => ({ rpc: async (name, args) => { calls.push({ name, args }); return { data, error }; } });
  const got = await M.makeDb(client({ messages: [shared], crews: [{ crew: crewId(0), ids: [701] }, { crew: crewId(1), ids: [701] }, { crew: crewId(2), ids: [] }, { crew: crewId(3), forbidden: true }] }))
    .crewInboxMany(WS, [0, 1, 2, 3].map((i) => ({ crew: crewId(i), after: i * 10 })));
  assert.deepEqual(calls[0], { name: 'msgr_crew_inbox_many', args: { p_ws: WS, p_items: [0, 1, 2, 3].map((i) => ({ crew: crewId(i), after: i * 10 })), p_limit: M.PAGE } });
  assert.deepEqual(got.get(crewId(0)), [shared]); assert.deepEqual(got.get(crewId(1)), [shared]); assert.deepEqual(got.get(crewId(2)), []);
  assert.notEqual(got.get(crewId(0))[0], got.get(crewId(1))[0], '에이전트마다 다른 객체');
  assert.ok(got.get(crewId(3)) instanceof Error); assert.equal(got.get(crewId(3)).code, '42501'); assert.equal(got.get(crewId(3)).message, 'msgr db: msgr_execution_forbidden');
  await assert.rejects(M.makeDb(client({ messages: [], crews: [{ crew: crewId(0), ids: [9] }] })).crewInboxMany(WS, [{ crew: crewId(0), after: 0 }]), /응답에 없는 글/);
  const none = await M.makeDb(client(null)).crewInboxMany(WS, [{ crew: crewId(0), after: 0 }]);
  assert.ok(none.get(crewId(0)) === undefined, '빈 응답 — 이 에이전트 항목 없음(drain이 실패로 처리)');
  for (const code of ['PGRST202', '42883']) assert.equal(await M.makeDb(client(null, { code, message: 'x' })).crewInboxMany(WS, [{ crew: crewId(0), after: 0 }]), undefined);
  await assert.rejects(M.makeDb(client(null, { code: '57014', message: 'canceling statement due to statement timeout' })).crewInboxMany(WS, [{ crew: crewId(0), after: 0 }]), (e) => e.code === '57014');
});

test('응답에 에이전트 항목이 빠지면 그 에이전트 차례에 실패로 던진다(조용히 "받은 글 없음"으로 보지 않는다)', async () => {
  const f = fixture(2, ({ PUB }) => [userMsg(801, PUB, { mentions: [to(1)] })]);
  const srv = fakeServer({ serverInbox: f.serverInbox });
  const real = srv.client.rpc;
  srv.client.rpc = async (name, args) => { const r = await real(name, args); if (name === 'msgr_crew_inbox_many') r.data.crews = r.data.crews.filter((c) => c.crew !== crewId(1)); return r; };
  const db = drainDb(srv, f); const enq = enqueueRec();
  await assert.rejects(M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null }), /받은 글 응답에 이 에이전트가 없음/);
  assert.deepEqual(cursors(db), [[crewId(0), 801]], 'c0 처리 뒤 c1 차례에 던진다');
});

test('일괄 함수가 Map을 돌려주지 않는 옛 어댑터·테스트 더블(Proxy 등)은 종전 에이전트별 경로 — 서버 없음으로 기억하지는 않는다(방 목록 crewRoomsFor와 같은 규칙)', async () => {
  const f = fixture(3, ({ PUB }) => [userMsg(901, PUB, { mentions: [to(2)] })]);
  const srv = fakeServer({ serverInbox: f.serverInbox });
  let many = 0;
  const mk = () => { const db = drainDb(srv, { ...f, legacy: true }); db.crewInboxMany = async () => { many++; return []; }; return db; };
  const db = mk(); const { enq } = await run(db);
  assert.deepEqual(jobs(enq), [[901, 'c2']]); assert.equal(srv.inboxCalls().length, f.crews.length);
  await run(mk());
  assert.equal(many, 2, '다음 틱에도 일괄을 다시 물어본다(옛 서버로 기억하지 않음)');
});
