// 메신저 게이트웨이의 방 목록(msgr_channel_members) 조회 줄이기 — 2026-10-09 운영 실측(읽기 전용): 받은 글 RPC 1회당 방 목록 2회,
// msgr_channel_members 두 종류가 분당 약 2,312·2,242회. 원인은 drain이 틱마다 에이전트 한 명당 DM 목록(crewChannels)·참여 방(crewScope)을
// 따로 물은 것(에이전트 N명이면 틱당 2N). 바뀐 규칙: 받은 글을 먼저 받고, 받은 글이 있는 에이전트만 모아 방 참여를 한 번에 받는다.
// 이 파일은 실제 supabase-js 클라이언트를 가짜 PostgREST(로컬 HTTP, 최대 행 1000 — Supabase 기본)에 붙여
// 요청 수·잘림·판정 결과가 옛 크루별 방식과 같은지를 잠근다. 실 Supabase·실데이터 미접촉(임시 ARGO_ROOT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-rooms-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { paths } = await import('../src/workspace.mjs');

const WS = 'rooms-ws';
const OWNER = '11111111-1111-4111-8111-111111111111', FRIEND = '22222222-2222-4222-8222-222222222222';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const p = paths(WS);
for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files]) await mkdir(d, { recursive: true });
await writeFile(p.company, JSON.stringify({ id: WS, name: '방 목록', lang: 'ko', created: '2026-10-09', ownerId: OWNER }));

const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const crewId = (n) => uuid('cccccccc', n);
const chId = (n) => uuid('bbbbbbbb', n);
const orgCrew = (n, over = {}) => ({ id: crewId(n), org_id: ORG, slug: `c${n}`, display_name: `에이전트${n}`, allow: 'all', allow_users: [], cursor_msg_id: 100, hosting: 'local', ...over });
const userMsg = (id, channel, over = {}) => ({ id, channel_id: channel, author_kind: 'user', author_user_id: OWNER, crew_id: null, kind: 'text', body: `m${id}`,
  mentions: [], reply_to: null, thread_root: null, meta: {}, created_at: new Date().toISOString(), ...over });
const to = (n) => ({ kind: 'crew', id: crewId(n), role: 'to' });

/* ─── 가짜 PostgREST — msgr_channel_members만. 필터(eq·gt·in, or(…)/and(…) 중첩)·select(왼쪽 결합 / !inner)·order·offset·limit.
   최대 행(db-max-rows, 기본 1000)은 실제 PostgREST처럼 limit보다 작으면 조용히 잘라 주고 Content-Range(0-499/*)만 단다 — 클라이언트는 잘렸는지 모른다.
   order가 없으면 넣은 순서 그대로(실제 Postgres도 ORDER BY 없으면 순서를 보장하지 않는다). 훅: failOn·beforeRequest(방 목록 요청 순번 1부터). ─── */
const splitTop = (s) => { const out = []; let depth = 0, cur = ''; for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; } if (cur) out.push(cur); return out; };
const opOk = (x, op, v) => {
  const s = String(x);
  if (op === 'eq') return s === v;
  if (op === 'gt') return s > v; // 소문자 정규형 uuid는 문자열 순서 = Postgres uuid 순서
  if (op === 'in') return v.slice(1, -1).split(',').map((t) => t.replace(/^"|"$/g, '')).includes(s);
  throw new Error(`fake: 모르는 연산 ${op}`);
};
const condOk = (r, expr) => {
  const m = /^(and|or)\((.*)\)$/.exec(expr);
  if (m) { const parts = splitTop(m[2]); return m[1] === 'and' ? parts.every((x) => condOk(r, x)) : parts.some((x) => condOk(r, x)); }
  const [col, op, ...rest] = expr.split('.');
  return opOk(r[col], op, rest.join('.'));
};
async function fakeRest({ members, channels, hidden = new Set(), maxRows = 1000, failOn = () => false, beforeRequest = () => {}, ignoreKeyset = false }) {
  const hits = []; const state = { fail: false };
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (s, o, headers = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
    const q = u.searchParams;
    const hit = { path: u.pathname, select: q.get('select') ?? '', urlLength: req.url.length, inIds: (q.get('member_id') ?? '').startsWith('in.(') ? q.get('member_id').slice(4, -1).split(',').length : 0, keyset: q.has('or') };
    hits.push(hit);
    if (u.pathname !== '/rest/v1/msgr_channel_members') return json(404, { code: 'PGRST205', message: `no fake route ${u.pathname}` });
    const n = hit.select.includes('channel_id') ? hits.filter((h) => h.path === u.pathname && h.select.includes('channel_id')).length : 0;
    beforeRequest(hit, n);
    if (state.fail || failOn(hit, n)) return json(500, { code: 'XX000', message: 'fake outage' });
    if (n > 50) return json(500, { code: 'XX000', message: 'fake: 방 목록 요청이 50회를 넘었다(끝없는 이어 읽기)' }); // 테스트가 멈추지 않게
    let rows;
    try {
      rows = members.filter((r) => [...q.entries()].every(([k, v]) => {
        if (['select', 'order', 'offset', 'limit'].includes(k)) return true;
        if (k === 'or' || k === 'and') return ignoreKeyset || condOk(r, `${k}${v}`); // ignoreKeyset — 이어 읽기 조건을 무시하는 서버 흉내
        const i = v.indexOf('.');
        return opOk(r[k], v.slice(0, i), v.slice(i + 1));
      }));
    } catch (e) { return json(400, { code: 'PGRST100', message: e.message }); }
    for (const part of (q.get('order') ?? '').split(',').filter(Boolean).reverse()) {
      const [col, dir = 'asc'] = part.split('.');
      rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    const sel = q.get('select') ?? '*';
    const embed = /msgr_channels(!inner)?\(([^)]*)\)/.exec(sel);
    const cols = sel.replace(/,?msgr_channels(!inner)?\([^)]*\)/, '').split(',').filter(Boolean);
    let out = rows.map((r) => {
      const o = Object.fromEntries(cols.map((c) => [c, r[c]]));
      if (embed) { const ch = channels[r.channel_id]; o.msgr_channels = ch && !hidden.has(r.channel_id) ? Object.fromEntries(embed[2].split(',').map((c) => [c, ch[c] ?? null])) : null; }
      return o;
    });
    if (embed?.[1]) out = out.filter((o) => o.msgr_channels);
    const offset = Number(q.get('offset') ?? 0);
    const limit = Math.min(q.has('limit') ? Number(q.get('limit')) : Infinity, maxRows);
    const page = out.slice(offset, offset + limit);
    json(200, page, { 'content-range': page.length ? `${offset}-${offset + page.length - 1}/*` : '*/*' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const client = createClient(`http://127.0.0.1:${srv.address().port}`, 'test-anon-key', { auth: { persistSession: false, autoRefreshToken: false } });
  const roomHits = () => hits.filter((h) => h.path === '/rest/v1/msgr_channel_members' && h.select.includes('channel_id'));
  return { client, hits, roomHits, state, close: () => new Promise((r) => srv.close(r)) };
}

/** drain용 db — 방 목록 함수(crewChannels·crewScope·새 일괄 조회)는 makeDb 그대로(실제 supabase-js → 가짜 PostgREST), 나머지는 기록하는 가짜. */
function drainDb(client, { crews, inbox, channels, personalInRooms = new Set(), envelope = false }) {
  const calls = [];
  const db = {
    ...M.makeDb(client),
    calls,
    // 기본은 서버 봉투 없는 로컬 판정 경로(dm·member 둘 다 쓴다). envelope:true = 운영 makeDb처럼 봉투가 있다 — 그러면 dm 집합(targetsCrew)이 대상 여부를 가른다
    crewContext: envelope ? async (_ws, _crew, sourceId, channelId) => { const c = channels[channelId]; return { source: inbox(_crew).find((m) => m.id === sourceId), channel: { id: channelId, kind: c.kind, org_id: c.org_id, name: 'ch', crew_memory: true, archived_at: null, excluded_crew_ids: [] }, root: { id: sourceId }, delivery_role: 'to', auto_turns: 0, peers: [], settled_root: true, settled_root_before_source: true }; } : undefined,
    async myCrews() { return crews; },
    async personalCrewsInRooms(ids) { return new Set(ids.filter((id) => personalInRooms.has(id))); },
    async crewInbox(_ws, id, after) { calls.push(['crewInbox', id, after]); const m = inbox(id); if (m instanceof Error) throw m; return m.filter((x) => x.id > after); },
    // 받은 글 일괄(2026-10-09, makeDb.crewInboxMany와 같은 계약 — Map(크루 id → 글 | Error)). 받은 글은 같은 inbox(id)에서, 요청 수만 다르다
    async crewInboxMany(_ws, items) { calls.push(['crewInboxMany', items.length]); return new Map(items.map(({ crew, after }) => { const m = inbox(crew); return [crew, m instanceof Error ? m : m.filter((x) => x.id > after)]; })); },
    async setCursor(id, n) { calls.push(['setCursor', id, n]); },
    async channel(id) { const c = channels[id]; return c ? { id, name: c.name ?? 'ch', crew_memory: true, archived_at: c.archived_at ?? null, excluded_crew_ids: [], kind: c.kind, org_id: c.org_id } : null; },
    async message() { return null; },
    async instructCheck() { return 'ok'; },
    async orgEntitled() { return true; },
    async orgConsentOk() { return true; },
    async personalConsentOk() { return true; },
    async crewOwner() { return OWNER; },
    async insertMessage(row) { calls.push(['insertMessage', row]); return { id: 9999 }; },
    async approvalsByIds() { return []; },
  };
  return db;
}
/** 옛 어댑터(일괄 조회 함수 없음) — 크루별 crewChannels·crewScope로 돌아가는 경로. */
const legacy = (db) => { const { crewMemberships: _drop, ...rest } = db; return rest; };
const enqueueRec = () => { const jobs = []; const fn = async (_ws, _k, _id, job) => { jobs.push(job); }; fn.jobs = jobs; return fn; };
const run = (db, enq = enqueueRec()) => M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null }).then((r) => ({ r, enq }));
const cursors = (db) => db.calls.filter((c) => c[0] === 'setCursor').map((c) => [c[1], c[2]]);
const jobs = (enq) => enq.jobs.map((j) => [j.msgId, j.slug]);

/** 조직 에이전트 N명 — 각자 조직 DM 1개 + 공개 채널 PUB 참여. 사람 참여 행도 섞는다(member_kind 필터 확인). */
function orgFixture(n) {
  const PUB = chId(1);
  const channels = { [PUB]: { kind: 'public', org_id: ORG, personal_pair: null, name: 'general' } };
  const members = [{ channel_id: PUB, member_kind: 'user', member_id: OWNER }];
  const crews = [];
  for (let i = 0; i < n; i++) {
    const dm = chId(1000 + i);
    channels[dm] = { kind: 'dm', org_id: ORG, personal_pair: null, name: `dm:${i}` };
    members.push({ channel_id: dm, member_kind: 'crew', member_id: crewId(i) }, { channel_id: dm, member_kind: 'user', member_id: OWNER }, { channel_id: PUB, member_kind: 'crew', member_id: crewId(i) });
    crews.push(orgCrew(i));
  }
  return { PUB, channels, members, crews };
}

// ① 받은 글이 0건인 틱 — 대상 후보가 없으니 방 목록을 묻지 않는다(커서·적재도 그대로)
for (const n of [1, 3, 50]) {
  test(`받은 글이 전부 0건인 틱은 방 목록 조회 0회 — 조직 에이전트 ${n}명 + 방에 든 개인 에이전트 1명(일괄 경로·옛 어댑터 경로 모두), 커서·적재 없음`, async () => {
    const f = orgFixture(n); const srv = await fakeRest(f);
    f.crews.push(orgCrew(9999, { org_id: null, allow: 'owner' })); f.personalInRooms = new Set([crewId(9999)]);
    try {
      const db = drainDb(srv.client, { ...f, inbox: () => [] });
      const { r, enq } = await run(db);
      assert.equal(r.crews, n + 1);
      assert.equal(db.calls.filter((c) => c[0] === 'crewInboxMany').length, 1, '받은 글은 회사 단위 한 번(2026-10-09 일괄 — test/msgr-inbox-batch.test.mjs)');
      assert.equal(db.calls.filter((c) => c[0] === 'crewInbox').length, 0);
      assert.equal(srv.roomHits().length, 0, `방 목록을 ${srv.roomHits().length}회 물었다`);
      assert.deepEqual(cursors(db), [], '커서를 쓰지 않는다'); assert.deepEqual(jobs(enq), []);
      const old = legacy(drainDb(srv.client, { ...f, inbox: () => [] }));
      await run(old);
      assert.equal(srv.roomHits().length, 0, '옛 어댑터 경로도 받은 글이 없으면 방 목록을 묻지 않는다');
    } finally { await srv.close(); }
  });
}

// ② 받은 글이 있는 틱 — 방 목록은 에이전트 수와 무관하다: 에이전트 id 100명 묶음마다 (페이지 수 + 끝을 확인하는 빈 페이지 1회)
for (const [n, want] of [[1, 2], [3, 2], [50, 2], [200, 4]]) {
  test(`받은 글이 있는 틱은 방 목록 조회 ${want}회 — 에이전트 ${n}명, 부른 에이전트만 적재하고 모두 커서 전진`, async () => {
    const f = orgFixture(n); const srv = await fakeRest(f);
    try {
      const m = userMsg(201, f.PUB, { mentions: [to(0)] }); // 조직 에이전트의 받은 글 = 조직 글 전부(서버 msgr_crew_inbox) — 모두가 이 글을 받는다
      const db = drainDb(srv.client, { ...f, inbox: () => [m] });
      const { enq } = await run(db);
      assert.equal(srv.roomHits().length, want, `방 목록을 ${srv.roomHits().length}회 물었다(종전 ${2 * n}회)`);
      assert.ok(Math.max(...srv.roomHits().map((h) => h.urlLength)) < 8000, 'id 묶음 URL이 8KB 아래');
      assert.deepEqual(jobs(enq), [[201, 'c0']]);
      assert.equal(cursors(db).length, n); assert.ok(cursors(db).every(([, v]) => v === 201), '모든 에이전트 커서 201');
    } finally { await srv.close(); }
  });
}

// ③ 판정이 옛 크루별 방식과 같다 — 조직 DM·개인 크루 1:1·친구 있는 개인 방·개인 그룹 방·공개·비공개·보관·채널 행을 못 읽는 참여
function mixedFixture() {
  const C1 = crewId(1), C2 = crewId(2), CP = crewId(3);
  const ch = { ORG_DM1: chId(11), ORG_DM2: chId(12), PUB: chId(13), PRIV: chId(14), ARCH: chId(15), HIDDEN: chId(16), P_CREW: chId(17), P_FRIEND: chId(18), P_GROUP: chId(19) };
  const channels = {
    [ch.ORG_DM1]: { kind: 'dm', org_id: ORG, personal_pair: null }, [ch.ORG_DM2]: { kind: 'dm', org_id: ORG, personal_pair: null },
    [ch.PUB]: { kind: 'public', org_id: ORG, personal_pair: null }, [ch.PRIV]: { kind: 'private', org_id: ORG, personal_pair: null },
    [ch.ARCH]: { kind: 'private', org_id: ORG, personal_pair: null, archived_at: '2026-10-01T00:00:00Z' },
    [ch.HIDDEN]: { kind: 'dm', org_id: ORG, personal_pair: null },
    [ch.P_CREW]: { kind: 'dm', org_id: null, personal_pair: `crew:${CP}` }, [ch.P_FRIEND]: { kind: 'dm', org_id: null, personal_pair: `${OWNER}:${FRIEND}` },
    [ch.P_GROUP]: { kind: 'dm', org_id: null, personal_pair: null },
  };
  const crewRow = (id, channelIds) => channelIds.map((c) => ({ channel_id: c, member_kind: 'crew', member_id: id }));
  const members = [
    ...crewRow(C1, [ch.ORG_DM1, ch.PUB, ch.ARCH, ch.HIDDEN]), ...crewRow(C2, [ch.ORG_DM2, ch.PRIV]), ...crewRow(CP, [ch.P_CREW, ch.P_FRIEND, ch.P_GROUP]),
    ...Object.values(ch).map((c) => ({ channel_id: c, member_kind: 'user', member_id: OWNER })), { channel_id: ch.P_FRIEND, member_kind: 'user', member_id: FRIEND },
  ];
  const crews = [orgCrew(1), orgCrew(2), orgCrew(3, { org_id: null, allow: 'owner' })];
  return { C1, C2, CP, ch, channels, members, crews, hidden: new Set([ch.HIDDEN]) };
}

test('일괄 조회의 DM 집합·참여 집합이 옛 crewChannels·crewScope와 같다 — 개인 방 규칙(crew:만 1:1)·채널 행을 못 읽는 참여 포함', async () => {
  const f = mixedFixture(); const srv = await fakeRest(f);
  try {
    const db = M.makeDb(srv.client);
    assert.equal(typeof db.crewMemberships, 'function', 'makeDb에 일괄 조회 함수가 있다');
    const ids = [f.C1, f.C2, f.CP];
    const got = await db.crewMemberships(ids);
    assert.equal(srv.roomHits().length, 2, '세 에이전트 한 묶음 — 행 1페이지 + 빈 페이지');
    for (const id of ids) {
      const old = { dm: new Set(await db.crewChannels(id)), member: await db.crewScope(id) };
      assert.deepEqual([...got.get(id).dm].sort(), [...old.dm].sort(), `DM 집합(${id})`);
      assert.deepEqual([...got.get(id).member].sort(), [...old.member].sort(), `참여 집합(${id})`);
    }
    assert.deepEqual([...got.get(f.CP).dm], [f.ch.P_CREW], '개인 방은 크루 1:1만 DM');
    assert.ok(got.get(f.C1).member.has(f.ch.HIDDEN) && !got.get(f.C1).dm.has(f.ch.HIDDEN), '채널 행을 못 읽는 참여 — 범위엔 있고 DM은 아니다(옛 방식과 같음)');
    assert.deepEqual(await db.crewMemberships([]), new Map(), '빈 목록은 조회하지 않는다');
    assert.equal(srv.roomHits().length, 2 + 2 * ids.length);
  } finally { await srv.close(); }
});

test('drain 결과(적재·커서·안내)가 일괄 경로와 옛 크루별 경로에서 같다 — 섞인 방 픽스처', async () => {
  const f = mixedFixture(); const srv = await fakeRest(f);
  const msgs = [
    userMsg(101, f.ch.ORG_DM1), // C1의 조직 DM — 멘션 없어도 대상
    userMsg(102, f.ch.PUB, { author_user_id: FRIEND, mentions: [to(1)] }), // C1 참여 공개 채널 멘션
    userMsg(103, f.ch.PRIV, { mentions: [to(1)] }), // C1이 참여하지 않은 비공개 채널 — 답하지 않는다
    userMsg(104, f.ch.P_CREW), // 개인 크루 1:1 — 멘션 없어도 대상
    userMsg(105, f.ch.P_FRIEND, { author_user_id: FRIEND }), // 친구 있는 개인 방 — 부르지 않으면 대상 아님
    userMsg(106, f.ch.P_FRIEND, { author_user_id: FRIEND, mentions: [to(3)] }), // 친구 방에서 부름 — 대상
    userMsg(107, f.ch.HIDDEN), // 채널 행을 못 읽는 DM — DM 집합 밖이라 멘션 없으면 대상 아님
    userMsg(108, f.ch.ARCH, { mentions: [to(1)] }), // 보관된 비공개 채널(참여 중) — 종전 판정 그대로
    userMsg(109, f.ch.P_GROUP, { mentions: [] }), // 개인 그룹 방 — DM 아님
    userMsg(110, f.ch.ORG_DM2, { mentions: [to(2)] }), // C2의 조직 DM
  ];
  try {
    const mk = () => drainDb(srv.client, { crews: f.crews, channels: f.channels, inbox: () => msgs, personalInRooms: new Set([f.CP]) });
    const a = mk(); const { enq: ea } = await run(a);
    const roomsBatch = srv.roomHits().length;
    const b = legacy(mk()); const { enq: eb } = await run(b);
    assert.equal(roomsBatch, 2, '일괄 경로는 방 목록 한 묶음(행 + 빈 페이지)');
    assert.equal(srv.roomHits().length - roomsBatch, 2 * f.crews.length, '옛 경로는 에이전트마다 2회');
    assert.deepEqual(jobs(ea), jobs(eb), '적재가 같다');
    assert.deepEqual(jobs(ea).sort(), [[101, 'c1'], [102, 'c1'], [104, 'c3'], [106, 'c3'], [108, 'c1'], [110, 'c2']].sort());
    assert.deepEqual(cursors(a), cursors(b), '커서가 같다');
    const notes = (db) => db.calls.filter((c) => c[0] === 'insertMessage').map((c) => c[1].client_msg_id);
    assert.deepEqual(notes(a), notes(b), '안내 글이 같다');
  } finally { await srv.close(); }
});

// ④ 방 목록 조회 실패 — 받은 글이 있는 에이전트는 이번 틱 보류(커서 유지, 같은 로그 문구), 받은 글이 없는 에이전트는 영향 없음
test('방 목록 조회가 실패하면 받은 글이 있는 에이전트(조직·개인)는 커서를 올리지 않고 보류, 실패 요청은 에이전트 수와 무관하게 1회 — 다음 틱에 회복', async () => {
  const f = orgFixture(5); const srv = await fakeRest(f);
  f.crews.push(orgCrew(9999, { org_id: null, allow: 'owner' })); f.personalInRooms = new Set([crewId(9999)]); // 방에 든 개인 에이전트도 같은 규칙
  const m = userMsg(301, chId(1000)); // c0의 조직 DM — 멘션 없는 1:1
  const inbox = (id) => (id === crewId(4) ? [] : [m]); // c4는 받은 글 없음
  const errs = []; const ce = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    srv.state.fail = true;
    const db = drainDb(srv.client, { ...f, inbox });
    const { enq } = await run(db);
    assert.equal(srv.roomHits().length, 1, `실패한 방 목록 요청 ${srv.roomHits().length}회(종전: 받은 글이 있는 에이전트마다)`);
    assert.deepEqual(jobs(enq), [], '적재하지 않는다'); assert.deepEqual(cursors(db), [], '커서 보류');
    assert.equal(errs.filter((e) => e.includes('[argo] msgr DM 채널 조회 실패 — 이 에이전트는 이 틱에 답하지 않음(커서 보류):')).length, 5, '종전과 같은 로그 문구, 보류한 에이전트마다(조직 4 + 개인 1)');
    srv.state.fail = false;
    const db2 = drainDb(srv.client, { ...f, inbox });
    const { enq: e2 } = await run(db2);
    assert.deepEqual(jobs(e2), [[301, 'c0']], '회복 틱에 답한다');
    assert.deepEqual(cursors(db2).map(([id]) => id).sort(), [0, 1, 2, 3, 9999].map(crewId).sort());
  } finally { console.error = ce; await srv.close(); }
});

test('받은 글 조회 실패는 종전처럼 그 에이전트 차례에 던진다 — 앞 에이전트는 처리·커서 전진(인접 동작 핀)', async () => {
  const f = orgFixture(3); const srv = await fakeRest(f);
  const m = userMsg(401, f.PUB, { mentions: [to(0)] });
  try {
    const db = drainDb(srv.client, { ...f, inbox: (id) => (id === crewId(1) ? new Error('inbox down') : [m]) });
    const enq = enqueueRec();
    await assert.rejects(M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null }), /inbox down/);
    assert.deepEqual(jobs(enq), [[401, 'c0']]); assert.deepEqual(cursors(db), [[crewId(0), 401]], 'c0 처리 뒤 c1 차례에 던진다');
  } finally { await srv.close(); }
});

test('방 목록과 받은 글이 같은 틱에 둘 다 실패하면 받은 글 실패를 던지고 커서는 모두 보류 — 종전엔 방 목록 실패 때 받은 글을 묻지 않아 조용히 지나갔다(의도한 변경)', async () => {
  const f = orgFixture(3); const srv = await fakeRest(f);
  const m = userMsg(402, f.PUB, { mentions: [to(0)] });
  const ce = console.error; console.error = () => {};
  try {
    srv.state.fail = true;
    const db = drainDb(srv.client, { ...f, inbox: (id) => (id === crewId(1) ? new Error('inbox down') : [m]) });
    const enq = enqueueRec();
    await assert.rejects(M.drain(WS, { db, uid: OWNER, enqueue: enq, housekeeping: false, inventory: null, commandsFor: null }), /inbox down/);
    assert.deepEqual(jobs(enq), []); assert.deepEqual(cursors(db), [], '커서는 종전처럼 모두 보류');
  } finally { console.error = ce; await srv.close(); }
});

// ⑤ 최대 행 1000을 넘는 참여 정보도 잘리지 않는다
test('참여 행 2,500개(최대 행 1000)도 끝까지 받는다 — 마지막 페이지의 DM에 온 글에도 답한다', async () => {
  const n = 50, per = 50; // 에이전트 50명 × 방 50개
  const channels = {}; const members = []; const crews = [];
  for (let i = 0; i < n; i++) {
    crews.push(orgCrew(i));
    for (let j = 0; j < per; j++) {
      const id = chId(10_000 + i * per + j);
      channels[id] = { kind: j === per - 1 ? 'dm' : 'private', org_id: ORG, personal_pair: null };
      members.push({ channel_id: id, member_kind: 'crew', member_id: crewId(i) });
    }
  }
  const srv = await fakeRest({ members, channels });
  try {
    const got = await M.makeDb(srv.client).crewMemberships(crews.map((c) => c.id));
    assert.equal([...got.values()].reduce((s, v) => s + v.member.size, 0), n * per, '참여 행 전부');
    assert.equal(srv.roomHits().length, 4, '1000·1000·500·빈 페이지');
    const lastDm = chId(10_000 + (n - 1) * per + per - 1);
    assert.ok(got.get(crewId(n - 1)).dm.has(lastDm), '마지막 페이지의 DM');
    const before = srv.roomHits().length;
    const db = drainDb(srv.client, { crews, channels, inbox: () => [userMsg(501, lastDm)] }); // 모두가 받은 글이 있다 → 2,500행을 한 틱에 받는다
    const { enq } = await run(db);
    assert.equal(srv.roomHits().length - before, 4, 'drain도 네 요청');
    assert.deepEqual(jobs(enq), [[501, `c${n - 1}`]], '마지막 페이지에만 있는 1:1 방의 글에 답한다(잘리면 DM을 몰라 지나간다)');
    assert.equal(cursors(db).length, n);
  } finally { await srv.close(); }
});

/* ─── 키 기준 이어 읽기 — 서버 최대 행이 1000보다 작아도, 페이지 사이에 앞쪽 행이 지워져도 잘리지 않는다(분리 검수 #893 MEDIUM-1·LOW-1·LOW-2) ─── */
/** 에이전트 n명 × 방 per개(마지막 방이 그 에이전트의 조직 DM). 참여 행은 정렬 순서가 아닌 섞인 순서로 넣는다 — 서버에 order를 안 보내면 이어 읽기가 깨지게(순서 잠금). */
function bigFixture(n, per) {
  const channels = {}; const members = []; const crews = [];
  for (let i = 0; i < n; i++) {
    crews.push(orgCrew(i));
    for (let j = 0; j < per; j++) {
      const id = chId(10_000 + i * per + j);
      channels[id] = { kind: j === per - 1 ? 'dm' : 'private', org_id: ORG, personal_pair: null };
      members.push({ channel_id: id, member_kind: 'crew', member_id: crewId(i) });
    }
  }
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = members.length - 1; k > 0; k--) { const r = Math.floor(rnd() * (k + 1)); [members[k], members[r]] = [members[r], members[k]]; }
  return { channels, members, crews, lastDmOf: (i) => chId(10_000 + i * per + per - 1) };
}
const byKey = (a, b) => (a.member_id < b.member_id ? -1 : a.member_id > b.member_id ? 1 : a.channel_id < b.channel_id ? -1 : a.channel_id > b.channel_id ? 1 : 0);
const totalRows = (got) => [...got.values()].reduce((s, v) => s + v.member.size, 0);
const slugOf = (id) => `c${Number(id.slice(-12))}`;

for (const maxRows of [500, 999]) {
  test(`서버 최대 행 ${maxRows}(1000보다 작음)에도 참여 1,500행을 끝까지 받고, 정렬 맨 뒤 에이전트의 멘션 없는 1:1 글에 답한다 — 빈 페이지가 와야 끝`, async () => {
    const f = bigFixture(30, 50);
    const srv = await fakeRest({ ...f, maxRows });
    try {
      const got = await M.makeDb(srv.client).crewMemberships(f.crews.map((c) => c.id));
      assert.equal(totalRows(got), 1500, '참여 행 전부');
      assert.equal(srv.roomHits().length, Math.ceil(1500 / maxRows) + 1, '잘린 페이지들 + 끝을 확인하는 빈 페이지');
      assert.ok(got.get(crewId(29)).dm.has(f.lastDmOf(29)), '마지막 에이전트의 1:1 방');
      const before = srv.roomHits().length;
      const msg = userMsg(501, f.lastDmOf(29)); // 모두가 받는 조직 글 — 멘션 없는 c29의 1:1
      const db = drainDb(srv.client, { ...f, inbox: () => [msg], envelope: true });
      const { enq } = await run(db);
      assert.deepEqual(jobs(enq), [[501, 'c29']], '잘린 집합으로 판정하면 이 글은 적재 없이 커서만 넘어간다');
      assert.equal(cursors(db).length, 30);
      assert.equal(srv.roomHits().length - before, Math.ceil(1500 / maxRows) + 1);
    } finally { await srv.close(); }
  });
}

test('페이지 사이에 앞쪽 참여 행이 지워져도 경계 행을 건너뛰지 않는다 — 마지막 키 뒤부터 이어 읽는다', async () => {
  const f = bigFixture(26, 40); // 1,040행 — 1쪽 1000행, 경계 = 정렬 1000번째 행(2쪽 첫 행)
  const boundary = [...f.members].sort(byKey)[1000];
  f.channels[boundary.channel_id] = { kind: 'dm', org_id: ORG, personal_pair: null }; // 경계 행을 그 에이전트의 1:1 방으로
  let removed = false;
  const srv = await fakeRest({ ...f, beforeRequest: (_hit, n) => {
    if (n === 2 && !removed) { f.members.splice(f.members.findIndex((r) => r.member_id === crewId(0)), 1); removed = true; } // 2쪽 직전 — 다른 기기에서 앞쪽(c0) 참여 하나가 빠졌다
  } });
  try {
    const db = drainDb(srv.client, { ...f, inbox: () => [userMsg(601, boundary.channel_id)], envelope: true });
    const { enq } = await run(db);
    assert.ok(removed, '페이지 사이에 행이 지워졌다');
    assert.deepEqual(jobs(enq), [[601, slugOf(boundary.member_id)]], 'offset 페이지면 경계 행이 빠져 이 글의 커서만 넘어간다');
  } finally { await srv.close(); }
});

test('일괄 조회 도중 실패(둘째 페이지·둘째 id 묶음) — 받은 글 있는 에이전트 전원 보류(적재 0·커서 유지), 다음 틱 회복', async () => {
  const cases = [
    { label: '둘째 페이지', f: bigFixture(30, 50), failOn: (_h, n) => n === 2, last: 29 },
    { label: '둘째 id 묶음', f: bigFixture(150, 2), failOn: (h) => h.inIds === 50, last: 149 },
  ];
  const ce = console.error; console.error = () => {};
  try {
    for (const { label, f, failOn, last } of cases) {
      let fail = true;
      const srv = await fakeRest({ ...f, failOn: (h, n) => fail && failOn(h, n) });
      try {
        const msgs = [userMsg(701, f.lastDmOf(0)), userMsg(702, f.lastDmOf(last))];
        const a = drainDb(srv.client, { ...f, inbox: () => msgs, envelope: true });
        const { enq } = await run(a);
        assert.ok(srv.roomHits().length >= 2, `${label}: 실패 전에 받은 페이지가 있다`);
        assert.deepEqual(jobs(enq), [], `${label}: 앞 페이지·앞 묶음만으로 처리하지 않는다`);
        assert.deepEqual(cursors(a), [], `${label}: 커서 유지`);
        fail = false;
        const b = drainDb(srv.client, { ...f, inbox: () => msgs, envelope: true });
        const { enq: e2 } = await run(b);
        assert.deepEqual(jobs(e2).sort(), [[701, 'c0'], [702, `c${last}`]].sort(), `${label}: 회복 틱에 답한다`);
      } finally { await srv.close(); }
    }
  } finally { console.error = ce; }
});

test('정확히 페이지 크기만큼이면 빈 페이지까지 읽고 끝난다 — 둘째 요청부터는 마지막 키 뒤만 묻는다(offset 아님)', async () => {
  for (const [maxRows, want] of [[1000, 2], [500, 3]]) {
    const f = bigFixture(20, 50); // 1,000행
    const srv = await fakeRest({ ...f, maxRows });
    try {
      const got = await M.makeDb(srv.client).crewMemberships(f.crews.map((c) => c.id));
      assert.equal(totalRows(got), 1000);
      assert.equal(srv.roomHits().length, want, `최대 행 ${maxRows}: ${want}요청`);
      assert.ok(!srv.roomHits()[0].keyset && srv.roomHits().slice(1).every((h) => h.keyset), '첫 요청만 키 조건 없음');
    } finally { await srv.close(); }
  }
});

test('서버가 이어 읽기 조건을 무시해 같은 행을 다시 주면 끝없이 묻지 않고 실패로 멈춘다 — 호출부는 이 틱을 보류', async () => {
  const f = bigFixture(3, 5); // 15행, 최대 행 10
  const srv = await fakeRest({ ...f, maxRows: 10, ignoreKeyset: true });
  try {
    await assert.rejects(M.makeDb(srv.client).crewMemberships(f.crews.map((c) => c.id)), /이어 읽기가 앞으로 가지 않음/);
    assert.equal(srv.roomHits().length, 2, '둘째 요청에서 멈춘다');
  } finally { await srv.close(); }
});
