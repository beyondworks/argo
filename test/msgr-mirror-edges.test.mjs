// 크루 인벤토리 미러의 "카드 변화" 규칙(2026-10-05) — 미러는 레벨(행 ≠ 카드면 덮기)이 아니라 이 프로세스가 본 카드 변화로만 직무·상태를 쓴다.
//  · CX-08: 주인이 메신저에서 고친 직무(role_text)를 15초마다 카드 값으로 되돌리던 것 → 카드 직무가 바뀌었을 때만 쓴다. 재시작해도 되돌리지 않는다.
//  · CX-14: 본체에서 해고한 에이전트가 메신저·오피스에서 파견·접속 중으로 남던 것 → 카드가 사라지면 그 slug의 파견 행을 detached로 한 번(행·글·기억은 남긴다),
//           심박도 카드 있는 행만. 다시 영입·복구(카드가 다시 생김)하면 active로 되돌린다. 빈 카드 목록(폴더 읽기 실패)은 변화로 치지 않는다.
//  · 조직 행 얼굴: 새 조직에 파견하는 행도 대표 조직 행의 얼굴·사진으로(개인 행과 같은 규칙) — 넣을 것이 없는 틱은 읽지 않는다.
//  · 유휴(카드·행 그대로)에서는 쓰기 0.
// 라이브 DB 0 — db는 가짜.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-edges-'));
const { mirrorInventory, drain } = await import('../src/gateway/msgr.mjs');
const UID = '11111111-1111-4111-8111-111111111111', O1 = 'aaaaaaaa-0000-4000-8000-000000000001', O2 = 'aaaaaaaa-0000-4000-8000-000000000002', WS = 'ws-edges';

/** 행 상태를 들고 있는 가짜 db — updateCrewInfo가 행을 실제로 바꾼다(다음 틱이 바뀐 행을 본다) */
function db({ orgs = [O1], rows = [], looks = null } = {}) {
  const calls = [];
  const state = { rows: rows.map((r) => ({ ...r })) };
  return { calls, state,
    async myOrgIds() { return orgs; },
    async myCrewRows() { return state.rows.map((r) => ({ ...r })); },
    async orgAllowDefaults(ids) { return Object.fromEntries(ids.map((id) => [id, 'owner'])); },
    async upsertAvailable(r) { calls.push(['upsertAvailable', r]); state.rows.push(...r.map((x, i) => ({ id: `new-${state.rows.length + i}`, ...x }))); },
    async insertPersonal(r) { calls.push(['insertPersonal', r]); state.rows.push(...r.map((x, i) => ({ id: `newp-${state.rows.length + i}`, ...x }))); },
    async updateCrewInfo(id, patch) { calls.push(['updateCrewInfo', id, patch]); Object.assign(state.rows.find((x) => x.id === id), patch); },
    async deleteCrews(ids) { calls.push(['deleteCrews', ids]); state.rows = state.rows.filter((x) => !ids.includes(x.id)); },
    ...(looks ? { async crewLooks(uid, ws, slugs) { calls.push(['crewLooks', slugs]); return looks; } } : {}),
  };
}
const writes = (d) => d.calls.filter(([k]) => ['updateCrewInfo', 'upsertAvailable', 'insertPersonal', 'deleteCrews'].includes(k));
const card = (slug, role, name = slug) => ({ slug, name, role });

test('E1(CX-08). 메신저에서 고친 직무는 미러가 되돌리지 않는다 — 처음 본 틱·재시작 뒤에도, 카드 직무가 그대로면 쓰기 0', async () => {
  const d = db({ rows: [{ id: 'r1', org_id: O1, slug: 'seoyun', display_name: '서윤', role_text: '마케팅 팀장(메신저에서 고침)', status: 'active' },
    { id: 'p1', org_id: null, slug: 'seoyun', display_name: '서윤', role_text: '개인 직무(메신저)', status: 'active' }] });
  const seen = new Map();
  for (let tick = 0; tick < 3; tick++) await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', '마케터', '서윤')], seen });
  assert.deepEqual(writes(d), [], '15초 틱 세 번 — 메신저 직무를 덮지 않고, 유휴 쓰기 0');
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', '마케터', '서윤')], seen: new Map() });
  assert.deepEqual(writes(d), [], '재시작(관찰 기록 없음)도 되돌리지 않는다');
});

test('E2(CX-08). 본체 카드의 직무가 바뀌면 그 slug의 행(조직·개인)에 한 번 쓰고, 다음 틱은 0 — 이름은 직무와 따로(이름만 바뀌면 이름만)', async () => {
  const d = db({ rows: [{ id: 'r1', org_id: O1, slug: 'seoyun', display_name: '서윤', role_text: '메신저 직무', status: 'active' },
    { id: 'p1', org_id: null, slug: 'seoyun', display_name: '서윤', role_text: '메신저 직무', status: 'active' }] });
  const seen = new Map();
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', '마케터', '서윤')], seen });
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', '브랜드 매니저', '서윤')], seen });
  assert.deepEqual(writes(d).map(([, id, p]) => [id, p]).sort(), [['p1', { role_text: '브랜드 매니저' }], ['r1', { role_text: '브랜드 매니저' }]]);
  d.calls.length = 0;
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', '브랜드 매니저', '서윤')], seen });
  assert.deepEqual(writes(d), [], '바뀐 뒤 유휴 틱은 쓰기 0');
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', '브랜드 매니저', '서윤2')], seen });
  assert.deepEqual(writes(d).map(([, id, p]) => [id, p]).sort(), [['p1', { display_name: '서윤2' }], ['r1', { display_name: '서윤2' }]], '이름만 바뀌면 이름만 — 메신저 직무를 같이 덮지 않는다');
});

test('E3(CX-08). 직무 쓰기가 실패하면 다음 틱에 다시 한다(관찰 기록을 옮기지 않는다)', async () => {
  const d = db({ rows: [{ id: 'r1', org_id: O1, slug: 'jun', display_name: '준', role_text: 'a', status: 'active' }] });
  const seen = new Map(); const logs = [];
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', 'a', '준')], seen });
  const ok = d.updateCrewInfo; let fail = true;
  d.updateCrewInfo = async (id, p) => { if (fail) { d.calls.push(['updateCrewInfo-fail', id, p]); throw new Error('boom'); } return ok(id, p); };
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', 'b', '준')], seen, log: (...a) => logs.push(a.join(' ')) });
  fail = false;
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', 'b', '준')], seen });
  assert.equal(d.state.rows[0].role_text, 'b', '실패한 변화는 다음 틱에 다시 쓴다');
  assert.ok(logs.length >= 1);
});

test('E4(CX-14). 해고(카드가 사라짐) — 그 slug의 파견 행(조직·개인)을 detached로 한 번, 행은 지우지 않는다, 다음 틱은 쓰기 0, 다른 크루는 그대로', async () => {
  const d = db({ orgs: [O1, O2], rows: [
    { id: 'a1', org_id: O1, slug: 'luna', display_name: '루나', role_text: null, status: 'active' },
    { id: 'a2', org_id: O2, slug: 'luna', display_name: '루나', role_text: null, status: 'active' },
    { id: 'ap', org_id: null, slug: 'luna', display_name: '루나', role_text: null, status: 'active' },
    { id: 'b1', org_id: O1, slug: 'jun', display_name: '준', role_text: null, status: 'active' },
    { id: 'b2', org_id: O2, slug: 'jun', display_name: '준', role_text: null, status: 'active' },
    { id: 'bp', org_id: null, slug: 'jun', display_name: '준', role_text: null, status: 'active' },
  ] });
  const seen = new Map();
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('luna', null, '루나'), card('jun', null, '준')], seen });
  assert.deepEqual(writes(d), []);
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', null, '준')], seen });
  assert.deepEqual(writes(d).map(([k, id, p]) => [k, id, p]).sort(), [['updateCrewInfo', 'a1', { status: 'detached' }], ['updateCrewInfo', 'a2', { status: 'detached' }], ['updateCrewInfo', 'ap', { status: 'detached' }]]);
  assert.ok(!d.calls.some(([k]) => k === 'deleteCrews'), '기억 데이터 보존 — 행을 지우지 않는다');
  d.calls.length = 0;
  for (let i = 0; i < 3; i++) await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', null, '준')], seen });
  assert.deepEqual(writes(d), [], '해고 뒤 유휴 틱은 쓰기 0(해고 때 1회)');
});

test('E5(CX-14). 해고 판정은 이 프로세스가 본 변화로만 — 처음 본 틱에 카드 없는 행(다른 기기·동기화 덜 됨)·빈 카드 목록(폴더 읽기 실패)은 건드리지 않는다', async () => {
  const d = db({ rows: [{ id: 'x1', org_id: O1, slug: 'other-device', display_name: 'x', role_text: null, status: 'active' },
    { id: 'y1', org_id: O1, slug: 'jun', display_name: '준', role_text: null, status: 'active' }, { id: 'yp', org_id: null, slug: 'jun', display_name: '준', role_text: null, status: 'active' }] });
  const seen = new Map();
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', null, '준')], seen });
  assert.deepEqual(writes(d), [], '처음 본 틱 — 카드 없는 다른 기기 크루를 분리하지 않는다');
  await mirrorInventory(WS, { db: d, uid: UID, agents: [], seen });
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', null, '준')], seen });
  assert.deepEqual(writes(d), [], '빈 목록은 관찰이 아니다 — 준을 분리했다가 되살리지 않는다');
});

test('E6(CX-14). 다시 영입·복구(카드가 다시 생김) — 분리한 행을 active로, 직무는 새 카드 값으로; 메신저가 파견 해제한(available) 행은 그대로', async () => {
  const d = db({ rows: [{ id: 'a1', org_id: O1, slug: 'luna', display_name: '루나', role_text: '옛 직무', status: 'active' },
    { id: 'ap', org_id: null, slug: 'luna', display_name: '루나', role_text: '옛 직무', status: 'active' },
    { id: 'm1', org_id: O1, slug: 'mio', display_name: '미오', role_text: null, status: 'active' }, { id: 'mp', org_id: null, slug: 'mio', display_name: '미오', role_text: null, status: 'active' }] });
  const seen = new Map();
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('luna', '옛 직무', '루나'), card('mio', null, '미오')], seen });
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('mio', null, '미오')], seen });
  assert.equal(d.state.rows.find((r) => r.id === 'a1').status, 'detached');
  d.state.rows.find((r) => r.id === 'm1').status = 'available'; // 주인이 메신저에서 미오를 파견 해제
  d.calls.length = 0;
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('mio', null, '미오'), card('luna', '새 직무', '루나')], seen });
  assert.deepEqual(writes(d).map(([, id, p]) => [id, p]).sort(), [['a1', { role_text: '새 직무', status: 'active' }], ['ap', { role_text: '새 직무', status: 'active' }]]);
  d.calls.length = 0;
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('mio', null, '미오'), card('luna', '새 직무', '루나')], seen });
  assert.deepEqual(writes(d), [], '복구 뒤 유휴 틱 쓰기 0');
});

test('E7(재검수 MEDIUM). 새 조직에 파견하는 행도 대표 조직 행의 얼굴·사진으로 — 넣을 때만 한 번 읽고, 넣을 것이 없는 틱은 읽지 않는다', async () => {
  const looks = [
    { id: 'o-early', org_id: O1, slug: 'seoyun', status: 'active', face: { v: 2, shape: 8, color: 9 }, avatar_url: null, created_at: '2026-09-01T00:00:00+00:00' },
    { id: 'o-late', org_id: 'org-c', slug: 'seoyun', status: 'active', face: { v: 2, shape: 1, color: 1 }, avatar_url: 'https://x/late.jpg', created_at: '2026-09-20T00:00:00+00:00' },
  ];
  const d = db({ orgs: [O1, O2], rows: [{ id: 'o-early', org_id: O1, slug: 'seoyun', display_name: '서윤', role_text: null, status: 'active' }], looks });
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', null, '서윤'), card('newbie', null, '새내기')], seen: new Map() });
  const up = d.calls.find(([k]) => k === 'upsertAvailable')[1];
  const by = Object.fromEntries(up.map((r) => [`${r.org_id}:${r.slug}`, [r.face ?? null, r.avatar_url ?? null]]));
  assert.deepEqual(by[`${O2}:seoyun`], [{ v: 2, shape: 8, color: 9 }, 'https://x/late.jpg'], '새 조직 행 = 대표 행 얼굴 + (대표 행에 사진이 없으면) 다른 조직 행 사진');
  assert.deepEqual(by[`${O1}:newbie`], [null, null], '대표 행이 없는 새 에이전트는 기본값');
  const reads = d.calls.filter(([k]) => k === 'crewLooks');
  assert.deepEqual(reads, [['crewLooks', ['seoyun', 'newbie']]], '넣을 slug만, 개인·조직 삽입을 합쳐 한 번 읽는다');
  d.calls.length = 0;
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', null, '서윤'), card('newbie', null, '새내기')], seen: new Map() });
  assert.deepEqual(d.calls.filter(([k]) => k === 'crewLooks' || k === 'upsertAvailable'), [], '넣을 것이 없는 틱은 얼굴 읽기 0');
});

test('E8. 얼굴 읽기가 실패해도 조직 행은 그대로 넣는다(얼굴 없이)', async () => {
  const d = db({ orgs: [O1], rows: [] });
  d.crewLooks = async () => { throw new Error('boom'); };
  const logs = [];
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('seoyun', null, '서윤')], seen: new Map(), log: (...a) => logs.push(a.join(' ')) });
  assert.equal(d.calls.find(([k]) => k === 'upsertAvailable')[1].length, 1);
  assert.ok(logs.some((l) => /얼굴/.test(l)));
});

test('E9(CX-14). drain 심박 — 카드가 없는 행(해고됐는데 아직 active로 남은 행)은 심박을 보내지 않는다, 카드 목록을 못 읽거나 비면 종전대로 전부', async () => {
  const crews = [{ id: 'c-jun', org_id: O1, slug: 'jun', display_name: '준', allow: 'owner', allow_users: [], cursor_msg_id: 0, hosting: 'local' },
    { id: 'c-gone', org_id: O1, slug: 'gone', display_name: '퇴사', allow: 'owner', allow_users: [], cursor_msg_id: 0, hosting: 'local' }];
  const mk = () => { const calls = []; return { calls, async myCrews() { return crews; }, async personalCrewsInRooms() { return new Set(); }, async crewChannels() { return []; }, async crewScope() { return new Set(); }, async crewInbox() { return []; },
    async heartbeat(ids) { calls.push(['heartbeat', ids]); }, async workHeartbeat(ids) { calls.push(['workHeartbeat', ids]); }, async setCursor() {}, async approvalsByIds() { return []; }, async channelAccess() { return new Map(); }, async crewMemory() { return null; },
    async myOrgIds() { return [O1]; }, async myCrewRows() { return []; }, async orgAllowDefaults() { return {}; }, async upsertAvailable() {}, async updateCrewInfo() {}, async deleteCrews() {} }; };
  const beat = (d) => d.calls.find(([k]) => k === 'heartbeat')?.[1];
  const d1 = mk(); await drain(WS, { db: d1, uid: UID, enqueue: async () => {}, housekeeping: true, inventory: async () => [card('jun', null, '준')], commandsFor: null });
  assert.deepEqual(beat(d1), ['c-jun'], '카드 없는 행은 심박 없음 → 메신저·오피스에서 부재중');
  assert.deepEqual(d1.calls.find(([k]) => k === 'workHeartbeat')?.[1], ['c-jun'], '업무 심박도 같은 행만');
  const d2 = mk(); await drain(WS, { db: d2, uid: UID, enqueue: async () => {}, housekeeping: true, inventory: async () => [], commandsFor: null });
  assert.deepEqual(beat(d2), ['c-jun', 'c-gone'], '빈 목록은 판정하지 않는다(종전)');
  const d3 = mk(); const r = await drain(WS, { db: d3, uid: UID, enqueue: async () => {}, housekeeping: true, inventory: async () => { throw new Error('ENOENT'); }, commandsFor: null });
  assert.deepEqual(beat(d3), ['c-jun', 'c-gone'], '목록을 못 읽으면 종전대로');
  assert.match(r.mirrorError ?? '', /ENOENT/, '카드 목록 읽기 실패도 드레인을 죽이지 않고 미러 오류로 드러낸다');
});

// ── 검수 #fix-cross M3·L4 ──
const M = await import('../src/gateway/msgr.mjs');
const RLS = 'msgr db: new row violates row-level security policy (guest org)';

test('E10(검수 M3b). 한 조직의 파견 insert가 계속 실패해도(손님 역할·잠긴 조직) 틱은 끝까지 가서 기준을 잡고, 직무 변경·해고가 쓰인다 — 다른 조직 insert도 막히지 않는다', async () => {
  const d = db({ orgs: [O1, O2], rows: [
    { id: 'r1', org_id: O1, slug: 'luna', display_name: '루나', role_text: '마케터', status: 'active' }, { id: 'r2', org_id: O1, slug: 'jun', display_name: '준', role_text: '분석', status: 'active' },
    { id: 'p1', org_id: null, slug: 'luna', display_name: '루나', role_text: '마케터', status: 'active' }, { id: 'p2', org_id: null, slug: 'jun', display_name: '준', role_text: '분석', status: 'active' }] });
  const okUpsert = d.upsertAvailable; let guestFails = true;
  d.upsertAvailable = async (rows) => { if (guestFails && rows.some((r) => r.org_id === O2)) { d.calls.push(['upsert-fail', rows.map((r) => r.org_id)]); throw new Error(RLS); } return okUpsert(rows); };
  const seen = new Map(); const logs = [];
  const tick = (agents) => mirrorInventory(WS, { db: d, uid: UID, agents, seen, log: (...a) => logs.push(a.join(' ')) });
  const row = (id) => d.state.rows.find((r) => r.id === id);
  // 틱 1 — 손님 조직 insert가 던져도 기준은 잡힌다. 오류는 그대로 드러난다(브리지가 미러 오류로 표시 — msgr_ws_owned_by_other 등이 이 길로 온다)
  await assert.rejects(tick([card('luna', '마케터', '루나'), card('jun', '분석', '준')]), /row-level security/);
  assert.ok(seen.has(WS), '던진 틱도 기준을 옮긴다(안 그러면 이 조직이 풀릴 때까지 아래 변화가 영영 안 쓰인다)');
  // 틱 2 — 카드 직무 변경이 쓰인다
  await assert.rejects(tick([card('luna', '브랜드 매니저', '루나'), card('jun', '분석', '준')]), /row-level security/);
  assert.deepEqual([row('r1').role_text, row('p1').role_text], ['브랜드 매니저', '브랜드 매니저'], '카드 직무 변경은 insert 실패와 상관없이 쓰인다');
  // 틱 3 — 해고(jun 카드 사라짐)가 쓰인다, 행은 지우지 않는다
  await assert.rejects(tick([card('luna', '브랜드 매니저', '루나')]), /row-level security/);
  assert.deepEqual([row('r2').status, row('p2').status], ['detached', 'detached'], '해고는 insert 실패와 상관없이 쓰인다');
  assert.ok(!d.calls.some(([k]) => k === 'deleteCrews'));
  // 틱 4 — 새 카드: 멀쩡한 조직(O1)의 insert는 손님 조직 때문에 막히지 않는다(묶음이 실패하면 조직별로 다시 넣는다)
  d.calls.length = 0;
  await assert.rejects(tick([card('luna', '브랜드 매니저', '루나'), card('newbie', null, '새내기')]), /row-level security/);
  assert.ok(d.state.rows.some((r) => r.org_id === O1 && r.slug === 'newbie'), 'O1 새 행은 들어간다');
  assert.deepEqual(d.calls.filter(([k]) => k === 'upsert-fail').map(([, orgs]) => [...new Set(orgs)].sort()), [[O1, O2].sort(), [O2]], '묶음이 실패하면 조직마다 다시 넣는다 — 실패한 것은 손님 조직뿐');
  // 틱 5 — 막힘이 풀리면 정상, 이미 쓴 변화는 다시 쓰지 않는다
  guestFails = false; d.calls.length = 0;
  await tick([card('luna', '브랜드 매니저', '루나'), card('newbie', null, '새내기')]);
  assert.deepEqual(writes(d).filter(([k]) => k === 'updateCrewInfo'), [], '이미 쓴 직무·해고는 다시 쓰지 않는다');
  assert.ok(d.state.rows.some((r) => r.org_id === O2 && r.slug === 'luna'), '풀린 조직 행이 들어간다');
  await tick([card('luna', '브랜드 매니저', '루나'), card('newbie', null, '새내기')]);
  const idle = d.calls.length; d.calls.length = 0;
  await tick([card('luna', '브랜드 매니저', '루나'), card('newbie', null, '새내기')]);
  assert.deepEqual(writes(d), [], '유휴 틱 쓰기 0');
  assert.ok(idle >= 0);
});

test('E11(검수 L4). 카드 목록이 비어 있으면(폴더 읽기 실패) 해제(available) 행을 지우지 않는다 — 결재·자동화·실행 기록이 연쇄로 지워진다. 카드가 있으면 종전대로', async () => {
  const rows = [{ id: 'r1', org_id: O1, slug: 'recalled', display_name: 'x', role_text: null, status: 'available' }, { id: 'r2', org_id: O1, slug: 'live', display_name: 'y', role_text: null, status: 'active' }];
  const empty = db({ rows });
  await mirrorInventory(WS, { db: empty, uid: UID, agents: [], seen: new Map() });
  assert.deepEqual(writes(empty), [], '빈 목록 — 아무것도 쓰지 않는다(삭제 포함)');
  assert.equal(empty.state.rows.length, 2);
  const normal = db({ rows });
  await mirrorInventory(WS, { db: normal, uid: UID, agents: [card('live', null, 'y')], seen: new Map() });
  assert.deepEqual(writes(normal).filter(([k]) => k === 'deleteCrews'), [['deleteCrews', ['r1']]], '카드가 있는 틱의 회수는 종전대로(카드 없는 해제 행만)');
});

test('E12(검수 M3a). 해고 라우트가 부르는 detachFiredCrew — 그 slug의 파견 행(조직·개인)을 한 번에 분리하고 기준에서 slug를 빼서, 곧바로 다시 영입해도 미러가 되살린다', async () => {
  const d = db({ orgs: [O1], rows: [{ id: 'a1', org_id: O1, slug: 'luna', display_name: '루나', role_text: null, status: 'active' }, { id: 'ap', org_id: null, slug: 'luna', display_name: '루나', role_text: null, status: 'active' },
    { id: 'b1', org_id: O1, slug: 'jun', display_name: '준', role_text: null, status: 'active' }, { id: 'bp', org_id: null, slug: 'jun', display_name: '준', role_text: null, status: 'active' }] });
  const asked = [];
  d.detachActiveCrews = async (uid, ws, slug) => { asked.push([uid, ws, slug]); const hit = d.state.rows.filter((r) => r.slug === slug && r.status === 'active'); hit.forEach((r) => { r.status = 'detached'; }); return hit.map((r) => r.id); };
  const seen = new Map();
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('luna', null, '루나'), card('jun', null, '준')], seen });
  const r = await M.detachFiredCrew(WS, 'luna', { session: async () => ({ uid: UID, db: d }), load: async () => ({ ownerId: UID }), seen });
  assert.deepEqual(asked, [[UID, WS, 'luna']], '한 번 — 그 slug만');
  assert.deepEqual(r, { detached: 2 });
  assert.deepEqual(d.state.rows.map((x) => [x.id, x.status]).sort(), [['a1', 'detached'], ['ap', 'detached'], ['b1', 'active'], ['bp', 'active']]);
  assert.ok(!seen.get(WS).has('luna') && seen.get(WS).has('jun'), '분리한 slug는 기준에서 뺀다');
  d.calls.length = 0;
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', null, '준')], seen });
  assert.deepEqual(writes(d), [], '다음 미러 틱은 같은 해고를 다시 쓰지 않는다');
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', null, '준'), card('luna', '새 직무', '루나')], seen });
  assert.deepEqual(writes(d).map(([, id, p]) => [id, p]).sort(), [['a1', { role_text: '새 직무', status: 'active' }], ['ap', { role_text: '새 직무', status: 'active' }]], '다시 영입하면 되살린다');
});

test('E13(검수 M3a). detachFiredCrew — 메신저 로그인이 없거나 소유자가 아니거나 DB가 실패하면 던지지 않고 건너뛴다, 기준은 그대로 둬서 다음 미러 틱이 처리한다', async () => {
  const mk = () => db({ orgs: [O1], rows: [{ id: 'a1', org_id: O1, slug: 'luna', display_name: '루나', role_text: null, status: 'active' }] });
  const d = mk(); const asked = []; d.detachActiveCrews = async (...a) => { asked.push(a); return []; };
  const seen = new Map([[WS, new Map([['luna', null]])]]);
  assert.deepEqual(await M.detachFiredCrew(WS, 'luna', { session: async () => null, load: async () => ({ ownerId: UID }), seen }), { skipped: 'session' });
  assert.deepEqual(await M.detachFiredCrew(WS, 'luna', { session: async () => { throw new Error('offline'); }, load: async () => ({ ownerId: UID }), seen }), { skipped: 'session' });
  assert.deepEqual(await M.detachFiredCrew(WS, 'luna', { session: async () => ({ uid: UID, db: d }), load: async () => ({ ownerId: 'someone-else' }), seen }), { skipped: 'owner' });
  assert.deepEqual(await M.detachFiredCrew(WS, 'luna', { session: async () => ({ uid: UID, db: d }), load: async () => { throw new Error('ENOENT'); }, seen }), { skipped: 'company' });
  assert.deepEqual(await M.detachFiredCrew(WS, 'luna', { session: async () => ({ uid: UID, db: d }), load: async () => ({ ownerId: UID, msgr: { nodeOrgId: O1 } }), seen }), { skipped: 'node' }, '회사 노드(서비스 계정)는 미러하지 않는 회사');
  assert.deepEqual(asked, [], 'DB를 부르지 않는다');
  const logs = [];
  d.detachActiveCrews = async () => { throw new Error('boom'); };
  assert.deepEqual(await M.detachFiredCrew(WS, 'luna', { session: async () => ({ uid: UID, db: d }), load: async () => ({ ownerId: UID }), seen, log: (...a) => logs.push(a.join(' ')) }), { failed: 'boom' });
  assert.ok(logs.length === 1);
  assert.ok(seen.get(WS).has('luna'), '건너뛰거나 실패하면 기준을 그대로 둔다 — 다음 미러 틱이 카드가 사라진 변화로 분리한다');
  await mirrorInventory(WS, { db: d, uid: UID, agents: [card('jun', null, '준')], seen });
  assert.equal(d.state.rows[0].status, 'detached', '다음 미러 틱이 처리');
  const bare = mk();
  assert.deepEqual(await M.detachFiredCrew(WS, 'luna', { session: async () => ({ uid: UID, db: bare }), load: async () => ({ ownerId: UID }), seen: new Map() }), { skipped: 'session' }, '옛 어댑터(분리 함수 없음)');
});
