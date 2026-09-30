// 개인 공간 에이전트 1단계(2026-09-30 유건) — 게이트웨이: 조직 없이 개인 크루 행을 올리고, 개인 방 글을 받아 답한다.
//  · 인벤토리: 조직이 없어도 개인 행(org NULL, 허용 owner)을 올린다. 카드에서 사라진 크루의 개인 행은 지운다(개인 행엔 '파견 해제'가 없다)
//  · 폴링: 개인 방에 든 개인 크루만 받은 글을 본다(방 없는 개인 크루는 조회 0 — DB 위생) / 동의는 방 기준
//  · 친구가 있는 개인 방은 @로 부를 때만(크루 1:1만 모든 글) / 개인 턴의 결재·예약은 이유를 말하고 거절
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-personal-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { messengerOrigin } = await import('../src/gateway/msgr-handoff.mjs');
const { paths } = await import('../src/workspace.mjs');
const WS = 'ws-personal', UID = '11111111-1111-4111-8111-111111111111', FRIEND = '22222222-2222-4222-8222-222222222222';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', PCH = 'bbbbbbbb-0000-4000-8000-00000000000p';
const p = paths(WS); for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files]) await mkdir(d, { recursive: true });
await writeFile(p.company, JSON.stringify({ id: WS, name: '개인', lang: 'ko', created: '2026-09-30' }));
const agents = [{ slug: 'seoyun', name: '서윤', role: '마케터' }, { slug: 'jun', name: '준', role: null }];

function invDb({ orgs = [], rows = [] } = {}) {
  const calls = [];
  return { calls,
    async myOrgIds() { return orgs; }, async myCrewRows() { return rows; },
    async upsertAvailable(r) { calls.push(['upsertAvailable', r]); }, async insertPersonal(r) { calls.push(['insertPersonal', r]); },
    async orgAllowDefaults(ids) { return Object.fromEntries(ids.map((id) => [id, 'owner'])); },
    async updateCrewInfo(id, patch) { calls.push(['updateCrewInfo', id, patch]); }, async deleteCrews(ids) { calls.push(['deleteCrews', ids]); },
  };
}

test('인벤토리: 조직이 없어도 내 크루가 개인 행으로 올라간다(허용 owner, 이름·역할·slug만)', async () => {
  const d = invDb({ orgs: [] });
  const r = await M.mirrorInventory(WS, { db: d, uid: UID, agents });
  assert.deepEqual(r, { orgs: 0, inserted: 2, updated: 0, removed: 0 });
  const rows = d.calls.find(([k]) => k === 'insertPersonal')[1];
  assert.deepEqual(rows.map((x) => [x.org_id, x.slug, x.allow, x.hosting, x.status]), [[null, 'seoyun', 'owner', 'local', 'active'], [null, 'jun', 'owner', 'local', 'active']]);
  assert.ok(!d.calls.some(([k]) => k === 'upsertAvailable'), '조직 행은 없다');
});

test('인벤토리: 조직이 있으면 조직 행과 개인 행을 둘 다, 이미 있는 개인 행은 다시 넣지 않고 이름만 맞추고, 카드에 없는 크루의 개인 행은 지우지 않는다', async () => {
  const d = invDb({ orgs: [ORG], rows: [{ id: 'p1', org_id: null, slug: 'seoyun', display_name: '옛 이름', role_text: '마케터', status: 'active' }, { id: 'p9', org_id: null, slug: 'other-device', display_name: '다른 기기 크루', role_text: null, status: 'active' }] });
  const r = await M.mirrorInventory(WS, { db: d, uid: UID, agents });
  assert.deepEqual(r, { orgs: 1, inserted: 3, updated: 1, removed: 0 }, '개인 1(jun) + 조직 2 삽입, 개인 이름 1 갱신, 회수 없음');
  assert.deepEqual(d.calls.find(([k]) => k === 'insertPersonal')[1].map((x) => x.slug), ['jun']);
  assert.deepEqual(d.calls.find(([k]) => k === 'updateCrewInfo').slice(1), ['p1', { display_name: '서윤', role_text: '마케터' }]);
  assert.ok(!d.calls.some(([k]) => k === 'deleteCrews'), '카드가 다른 기기·동기화 덜 된 카드로 개인 행을 지우지 않는다(분리 검수 H2 — 지우면 크루 답 작성자·1:1 방이 끊긴다)');
  assert.equal(d.calls.find(([k]) => k === 'upsertAvailable')[1].length, 2, '조직 행은 종전대로');
});

test('인벤토리: 개인 미러가 실패해도(옛 서버) 조직 미러는 계속 돈다', async () => {
  const d = invDb({ orgs: [ORG] });
  d.insertPersonal = async () => { throw new Error('msgr db: null value in column "org_id" violates not-null constraint'); };
  const logs = [];
  const r = await M.mirrorInventory(WS, { db: d, uid: UID, agents, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(d.calls.find(([k]) => k === 'upsertAvailable')[1].length, 2, '조직 행 삽입은 된다(분리 검수 M1)');
  assert.equal(r.orgs, 1);
  assert.ok(logs.some((l) => /개인 크루 미러 실패/.test(l)));
});

// makeDb의 supabase 체인 조건을 기록하는 가짜 클라이언트
function chainClient(result = { data: [], error: null }) {
  const log = [];
  const q = new Proxy({}, { get: (_, k) => k === 'then' ? (res) => res(result) : (...a) => { log.push([k, ...a]); return q; } });
  return { log, client: { from: (t) => { log.push(['from', t]); return q; }, rpc: (fn, args) => { log.push(['rpc', fn, args]); return Promise.resolve({ data: true, error: null }); } } };
}

test('crewBySlug: 개인 턴(orgId null)은 개인 행만, 조직 턴은 그 조직만, 옛 호출(undefined)은 거르지 않는다', async () => {
  for (const [orgId, want] of [[null, ['is', 'org_id', null]], [ORG, ['eq', 'org_id', ORG]], [undefined, null]]) {
    const { log, client } = chainClient({ data: null, error: null });
    await M.makeDb(client).crewBySlug(UID, WS, 'seoyun', orgId);
    const filters = log.filter(([k, col]) => (k === 'is' || k === 'eq') && col === 'org_id');
    assert.deepEqual(filters, want ? [want] : [], `orgId=${orgId}`);
  }
});

test('crewChannels: 개인 방은 크루 1:1만 "모든 글" 대상 — 친구가 있는 개인 방은 @로 부를 때만', async () => {
  const rows = [
    { channel_id: 'org-dm', msgr_channels: { kind: 'dm', org_id: ORG, personal_pair: null } },
    { channel_id: 'crew-dm', msgr_channels: { kind: 'dm', org_id: null, personal_pair: 'crew:x' } },
    { channel_id: 'friend-dm', msgr_channels: { kind: 'dm', org_id: null, personal_pair: `${UID}:${FRIEND}` } },
    { channel_id: 'group', msgr_channels: { kind: 'dm', org_id: null, personal_pair: null } },
    { channel_id: 'pub', msgr_channels: { kind: 'public', org_id: ORG, personal_pair: null } },
  ];
  const { client } = chainClient({ data: rows, error: null });
  assert.deepEqual(await M.makeDb(client).crewChannels('c'), ['org-dm', 'crew-dm']);
});

test('폴링: 방에 든 개인 크루만 받은 글을 보고, 동의는 방 기준으로 묻는다', async () => {
  const orgCrew = { id: 'c-org', org_id: ORG, slug: 'seoyun', display_name: '서윤', allow: 'owner', allow_users: [], cursor_msg_id: 0, hosting: 'local' };
  const pIn = { ...orgCrew, id: 'c-pin', org_id: null }, pOut = { ...orgCrew, id: 'c-pout', org_id: null, slug: 'jun' };
  const calls = [];
  const db = {
    async myCrews() { return [orgCrew, pIn, pOut]; },
    async personalCrewsInRooms(ids) { calls.push(['inRooms', ids]); return new Set(['c-pin']); },
    async crewChannels(id) { calls.push(['crewChannels', id]); return id === 'c-pin' ? [PCH] : []; },
    async crewScope(id) { calls.push(['crewScope', id]); return new Set(id === 'c-pin' ? [PCH] : []); },
    async crewInbox(ws, id) { calls.push(['crewInbox', id]); return id === 'c-pin' ? [{ id: 5, channel_id: PCH, author_kind: 'user', author_user_id: FRIEND, kind: 'text', body: '안녕', mentions: [], created_at: new Date().toISOString() }] : []; },
    async channel(id) { return { id, org_id: null, kind: 'dm', name: 'dm', crew_memory: true }; },
    async instructCheck() { return 'ok'; },
    async orgConsentOk(org, u) { calls.push(['orgConsentOk', org, u]); return true; },
    async personalConsentOk(ch, u) { calls.push(['personalConsentOk', ch, u]); return false; },
    async insertMessage(row) { calls.push(['insertMessage', row]); return { id: 99 }; },
    async setCursor(id, n) { calls.push(['setCursor', id, n]); },
    async message() { return null; },
    async approvalsByIds() { return []; },
  };
  const out = await M.drain(WS, { db, uid: UID, enqueue: async () => {}, housekeeping: false, inventory: null, commandsFor: null });
  assert.ok(!calls.some(([k]) => k === 'heartbeat'), '깨우기 틱(housekeeping=false)은 심박을 쓰지 않는다');
  assert.deepEqual(calls.filter(([k]) => k === 'crewInbox').map(([, id]) => id).sort(), ['c-org', 'c-pin'], '방 없는 개인 크루(c-pout)는 조회하지 않는다');
  assert.deepEqual(calls.find(([k]) => k === 'inRooms')[1], ['c-pin', 'c-pout'], '개인 크루 방 확인은 한 번');
  assert.deepEqual(calls.filter(([k]) => k === 'personalConsentOk').map((c) => c.slice(1)), [[PCH, FRIEND]], '개인 방 동의는 방 기준');
  assert.ok(!calls.some(([k, org]) => k === 'orgConsentOk' && org == null), '조직 동의 함수에 null 조직을 넘기지 않는다');
  assert.equal(out.denied, 1);
  assert.match(calls.find(([k]) => k === 'insertMessage')[1].client_msg_id, /^aiconsent:c-pin:/);
});

test('개인 턴에서 결재·예약·긴 작업을 부르면 이유를 말하고 거절한다', () => {
  assert.throws(() => messengerOrigin({ kind: 'msgr', orgId: null, channelId: PCH, crewId: 'c-pin', uid: UID, wsId: WS }), /개인 공간에서는 아직/);
  assert.equal(messengerOrigin({ kind: 'msgr', orgId: ORG, channelId: 'ch', crewId: 'c', uid: UID, wsId: WS }).orgId, ORG, '조직 턴은 그대로');
});

test('자동 켜기: 조직이 없어도 메신저를 쓰는 계정(프로필 있음)이면 켠다, 둘 다 없으면 켜지 않는다', async () => {
  for (const [personal, want] of [[true, true], [false, false]]) {
    const updates = [];
    const company = { id: WS, ownerId: UID, msgr: {} };
    const r = await M.autoEnableMsgr(WS, { company, session: async () => ({ uid: UID, db: { myOrgIds: async () => [], hasAnyCrew: async () => false, hasMsgrProfile: async () => personal } }),
      load: async () => company, update: async (ws, fn) => updates.push(fn(company)), probes: new Map(), orgCache: new Map() });
    assert.equal(r, want, `profile=${personal}`);
    assert.equal(updates.length, want ? 1 : 0);
  }
});

test('심박: 조직 행이 있으면 방 없는 개인 행은 쓰지 않고, 업무 심박은 조직 행만 보낸다', async () => {
  const orgCrew = { id: 'c-org', org_id: ORG, slug: 'seoyun', display_name: '서윤', allow: 'owner', allow_users: [], cursor_msg_id: 0, hosting: 'local' };
  const pOut = { ...orgCrew, id: 'c-pout', org_id: null };
  for (const [crewsList, wantBeat, wantWork] of [[[orgCrew, pOut], ['c-org'], ['c-org']], [[pOut], ['c-pout'], []]]) {
    const calls = [];
    const db = { async myCrews() { return crewsList; }, async personalCrewsInRooms() { return new Set(); }, async crewChannels() { return []; }, async crewScope() { return new Set(); }, async crewInbox() { return []; },
      async heartbeat(ids) { calls.push(['heartbeat', ids]); }, async workHeartbeat(ids) { calls.push(['workHeartbeat', ids]); }, async setCursor() {}, async approvalsByIds() { return []; }, async channelAccess() { return new Map(); }, async crewMemory() { return null; } };
    await M.drain(WS, { db, uid: UID, enqueue: async () => {}, housekeeping: true, inventory: null, commandsFor: null });
    assert.deepEqual(calls.find(([k]) => k === 'heartbeat')?.[1], wantBeat, `심박 ${JSON.stringify(crewsList.map((c) => c.id))}`);
    const work = calls.find(([k]) => k === 'workHeartbeat')?.[1];
    assert.deepEqual(work ?? [], wantWork, '업무 심박은 조직 행만(분리 검수 M3)');
  }
});
