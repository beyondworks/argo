// 개인 공간 에이전트 1단계(2026-09-30 유건) — 게이트웨이: 조직 없이 개인 크루 행을 올리고, 개인 방 글을 받아 답한다.
//  · 인벤토리: 조직이 없어도 개인 행(org NULL, 허용 owner)을 올린다. 카드에서 사라진 크루의 개인 행은 지운다(개인 행엔 '파견 해제'가 없다)
//  · 폴링: 개인 방에 든 개인 크루만 받은 글을 본다(방 없는 개인 크루는 조회 0 — DB 위생) / 동의는 방 기준
//  · 친구가 있는 개인 방은 @로 부를 때만(크루 1:1만 모든 글) / 개인 턴의 결재·예약은 crew 1:1 주인 턴만 열고 나머지는 이유를 말하고 거절(2026-10-08 PR-C)
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
  const r = await M.mirrorInventory(WS, { blocked: new Map(), db: d, uid: UID, agents });
  assert.deepEqual(r, { orgs: 0, inserted: 2, updated: 0, removed: 0 });
  const rows = d.calls.find(([k]) => k === 'insertPersonal')[1];
  assert.deepEqual(rows.map((x) => [x.org_id, x.slug, x.allow, x.hosting, x.status]), [[null, 'seoyun', 'owner', 'local', 'active'], [null, 'jun', 'owner', 'local', 'active']]);
  assert.ok(!d.calls.some(([k]) => k === 'upsertAvailable'), '조직 행은 없다');
});

test('인벤토리: 조직이 있으면 조직 행과 개인 행을 둘 다, 이미 있는 개인 행은 다시 넣지 않고 이름만 맞추고, 카드에 없는 크루의 개인 행은 지우지 않는다', async () => {
  const d = invDb({ orgs: [ORG], rows: [{ id: 'p1', org_id: null, slug: 'seoyun', display_name: '옛 이름', role_text: '마케터', status: 'active' }, { id: 'p9', org_id: null, slug: 'other-device', display_name: '다른 기기 크루', role_text: null, status: 'active' }] });
  const r = await M.mirrorInventory(WS, { blocked: new Map(), db: d, uid: UID, agents });
  assert.deepEqual(r, { orgs: 1, inserted: 3, updated: 1, removed: 0 }, '개인 1(jun) + 조직 2 삽입, 개인 이름 1 갱신, 회수 없음');
  assert.deepEqual(d.calls.find(([k]) => k === 'insertPersonal')[1].map((x) => x.slug), ['jun']);
  assert.deepEqual(d.calls.find(([k]) => k === 'updateCrewInfo').slice(1), ['p1', { display_name: '서윤' }], '이름만 — 직무는 카드 변화로만(CX-08)');
  assert.ok(!d.calls.some(([k]) => k === 'deleteCrews'), '카드가 다른 기기·동기화 덜 된 카드로 개인 행을 지우지 않는다(분리 검수 H2 — 지우면 크루 답 작성자·1:1 방이 끊긴다)');
  assert.equal(d.calls.find(([k]) => k === 'upsertAvailable')[1].length, 2, '조직 행은 종전대로');
});

test('인벤토리: 개인 미러가 실패해도(옛 서버) 조직 미러는 계속 돈다', async () => {
  const d = invDb({ orgs: [ORG] });
  d.insertPersonal = async () => { throw new Error('msgr db: null value in column "org_id" violates not-null constraint'); };
  const logs = [];
  const r = await M.mirrorInventory(WS, { blocked: new Map(), db: d, uid: UID, agents, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(d.calls.find(([k]) => k === 'upsertAvailable')[1].length, 2, '조직 행 삽입은 된다(분리 검수 M1)');
  assert.equal(r.orgs, 1);
  assert.ok(logs.some((l) => /개인 에이전트 미러 실패/.test(l)));
});

// 에이전트 = 한 사람(유건 2026-10-05): 같은 에이전트의 개인 행은 조직 행과 같은 얼굴·사진이어야 한다. 새 개인 행을 넣을 때만
// 대표 조직 행(가장 먼저 만든 살아 있는 조직 행)의 face·avatar_url을 한 번 읽어 복사한다 — 넣을 것이 없는 틱은 읽지 않는다(주기 읽기 열 그대로).
test('인벤토리: 새 개인 행은 대표 조직 행(가장 먼저 만든 행)의 얼굴·사진을 복사해서 넣는다', async () => {
  const d = invDb({ orgs: [ORG], rows: [{ id: 'p1', org_id: null, slug: 'seoyun', display_name: '서윤', role_text: '마케터', status: 'active' }] });
  const asked = [];
  d.crewLooks = async (uid, ws, slugs) => { asked.push([uid, ws, slugs]); return [
    { id: 'o-late', org_id: 'org-b', slug: 'jun', status: 'active', face: { v: 2, shape: 1, color: 1 }, avatar_url: 'https://x/late.jpg', created_at: '2026-09-20T00:00:00+00:00' },
    { id: 'o-early', org_id: ORG, slug: 'jun', status: 'active', face: { v: 2, shape: 8, color: 9 }, avatar_url: null, created_at: '2026-09-01T00:00:00+00:00' },
  ]; };
  await M.mirrorInventory(WS, { blocked: new Map(), db: d, uid: UID, agents });
  assert.deepEqual(asked, [[UID, WS, ['seoyun', 'jun']]], '이 틱에 넣을 slug(개인 jun + 조직 행이 없는 seoyun·jun)를 한 번에 읽는다(조직 행도 얼굴을 복사 — 재검수 MEDIUM)');
  const ins = d.calls.find(([k]) => k === 'insertPersonal')[1];
  assert.deepEqual(ins.map((x) => [x.slug, x.face, x.avatar_url]), [['jun', { v: 2, shape: 8, color: 9 }, 'https://x/late.jpg']], '얼굴은 대표 행, 대표 행에 사진이 없으면 다른 조직 행 사진');
});

test('인벤토리: 넣을 개인 행이 없으면 얼굴을 읽지 않고, 읽기가 실패해도 개인 행은 그대로 넣는다', async () => {
  const quiet = invDb({ orgs: [ORG], rows: [{ id: 'p1', org_id: null, slug: 'seoyun', display_name: '서윤', role_text: '마케터', status: 'active' }, { id: 'p2', org_id: null, slug: 'jun', display_name: '준', role_text: null, status: 'active' },
    { id: 'o1', org_id: ORG, slug: 'seoyun', display_name: '서윤', role_text: '마케터', status: 'active' }, { id: 'o2', org_id: ORG, slug: 'jun', display_name: '준', role_text: null, status: 'active' }] }); // 조직 행도 있어야 유휴 틱(조직 행을 넣는 틱은 얼굴을 읽는다)
  let reads = 0; quiet.crewLooks = async () => { reads++; return []; };
  await M.mirrorInventory(WS, { blocked: new Map(), db: quiet, uid: UID, agents });
  assert.equal(reads, 0, '유휴 틱은 추가 읽기 0');
  const broken = invDb({ orgs: [] });
  broken.crewLooks = async () => { throw new Error('boom'); };
  await M.mirrorInventory(WS, { blocked: new Map(), db: broken, uid: UID, agents, log: () => {} });
  const ins = broken.calls.find(([k]) => k === 'insertPersonal')[1];
  assert.deepEqual(ins.map((x) => [x.slug, x.face ?? null]), [['seoyun', null], ['jun', null]]);
});

test('대표 행 규칙은 메신저 얼굴 지도(crew-face.mjs agentLooks)와 같다 — 무작위 행 300벌로 대조', async () => {
  const { agentLooks } = await import('../apps/messenger/src/crew-face.mjs');
  let a = 7; const rnd = (n) => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; }; // mulberry32 — 선형 합동 생성기는 부동소수 정밀도·낮은 비트 주기 때문에 같은 값만 되풀이했다(변이를 못 잡는 무작위 시험이 되었다)
  const faces = [null, null, { v: 2, shape: 1, color: 2 }, { v: 2, shape: 8, color: 9 }];
  for (let k = 0; k < 300; k++) {
    const rows = Array.from({ length: 1 + rnd(5) }, (_, i) => ({ id: `r${rnd(9)}${i}`, owner_user_id: UID, ws_id: WS, slug: 'jun', org_id: `org${rnd(3)}`, // 개인 행은 넣을 때만 생긴다(그 회사·slug의 개인 행은 하나 — msgr_crews_personal_uniq)
      status: ['active', 'available', 'active'][rnd(3)], face: faces[rnd(4)], avatar_url: rnd(3) ? null : `https://x/${rnd(5)}.jpg`, created_at: `2026-09-0${1 + rnd(3)}T00:00:00+00:00` }));
    const body = M.repLooks(rows).get('jun');
    const msgr = agentLooks([...rows, { id: 'pNEW', owner_user_id: UID, ws_id: WS, slug: 'jun', org_id: null, status: 'active', face: null, avatar_url: null, created_at: '2026-10-05T00:00:00+00:00' }]).get('pNEW');
    assert.deepEqual([body.face, body.avatar_url], [msgr.face, msgr.photo], `행 ${JSON.stringify(rows)}`);
  }
});

// 검수 #fix-cross L1 — 개인 행에만 얼굴·사진이 있는 에이전트도 첫 조직 합류 때 그 얼굴을 받는다(메신저 agentLooks는 개인 행을 얼굴·사진 대체 경로에 쓴다).
// 대표 행 선택은 조직 행 기준 그대로(개인 행은 대표가 아니다).
test('repLooks: 개인 행에만 얼굴·사진이 있으면 그 값을(조직 행이 아직 없는 첫 합류), 조직 대표 행에 값이 있으면 그것이 먼저', () => {
  const F = (shape, color) => ({ v: 2, shape, color });
  const personal = { id: 'p1', org_id: null, slug: 'jun', status: 'active', face: F(3, 4), avatar_url: 'https://x/p.jpg', created_at: '2026-09-01T00:00:00+00:00' };
  assert.deepEqual(M.repLooks([personal]).get('jun'), { face: F(3, 4), avatar_url: 'https://x/p.jpg' }, '조직 행이 없어도 개인 행 값');
  const orgNoFace = { id: 'o1', org_id: ORG, slug: 'jun', status: 'active', face: null, avatar_url: null, created_at: '2026-09-02T00:00:00+00:00' };
  assert.deepEqual(M.repLooks([personal, orgNoFace]).get('jun'), { face: F(3, 4), avatar_url: 'https://x/p.jpg' }, '대표 조직 행에 값이 없으면 개인 행으로(더 일찍 만든 행 순)');
  const orgFace = { ...orgNoFace, face: F(8, 9), avatar_url: 'https://x/o.jpg' };
  assert.deepEqual(M.repLooks([personal, orgFace]).get('jun'), { face: F(8, 9), avatar_url: 'https://x/o.jpg' }, '대표 조직 행의 값이 개인 행(더 일찍 만들었어도)보다 먼저');
  assert.deepEqual(M.repLooks([{ ...personal, status: 'detached' }]).get('jun'), undefined, '살아 있지 않은 행은 재료가 아니다');
});

test('새 행 얼굴 재료 — 개인 행을 읽는다(조직 행 필터 없음), 개인 행에만 얼굴이 있으면 첫 조직 행도 그 얼굴로 들어간다', async () => {
  const { log, client } = chainClient({ data: [], error: null });
  await M.makeDb(client).crewLooks(UID, WS, ['jun']);
  assert.deepEqual(log.filter(([k, col]) => k === 'not' && col === 'org_id'), [], '개인 행(org NULL)을 거르지 않는다');
  assert.ok(log.some(([k, col, vals]) => k === 'in' && col === 'status' && vals.join() === 'active,available,paused'), '살아 있는 행만(무료 계정 일시 중지 paused 포함)');
  const d = invDb({ orgs: [ORG], rows: [{ id: 'p1', org_id: null, slug: 'jun', display_name: '준', role_text: null, status: 'active' }] });
  d.crewLooks = async () => [{ id: 'p1', org_id: null, slug: 'jun', status: 'active', face: { v: 2, shape: 3, color: 4 }, avatar_url: 'https://x/p.jpg', created_at: '2026-09-01T00:00:00+00:00' }];
  await M.mirrorInventory(WS, { blocked: new Map(), db: d, uid: UID, agents: [{ slug: 'jun', name: '준', role: null }], seen: new Map() });
  const up = d.calls.find(([k]) => k === 'upsertAvailable')[1];
  assert.deepEqual(up.map((r) => [r.org_id, r.face, r.avatar_url]), [[ORG, { v: 2, shape: 3, color: 4 }, 'https://x/p.jpg']], '첫 조직 행이 개인 행의 얼굴·사진을 받는다');
});

test('새 조직 행의 얼굴·사진은 메신저 얼굴 지도(agentLooks)가 그 행에 그리는 것과 같다 — 개인 행을 섞은 무작위 400벌', async () => {
  const { agentLooks } = await import('../apps/messenger/src/crew-face.mjs');
  let a = 11; const rnd = (n) => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; }; // mulberry32 — 선형 합동 생성기는 부동소수 정밀도·낮은 비트 주기 때문에 같은 값만 되풀이했다(변이를 못 잡는 무작위 시험이 되었다)
  const faces = [null, null, { v: 2, shape: 1, color: 2 }, { v: 2, shape: 8, color: 9 }];
  for (let k = 0; k < 400; k++) {
    const orgRows = Array.from({ length: rnd(4) }, (_, i) => ({ id: `r${rnd(9)}${i}`, owner_user_id: UID, ws_id: WS, slug: 'jun', org_id: `org${rnd(3)}`, status: ['active', 'available', 'active'][rnd(3)], face: faces[rnd(4)],
      avatar_url: rnd(3) ? null : `https://x/${rnd(5)}.jpg`, created_at: `2026-09-0${1 + rnd(3)}T00:00:00+00:00` }));
    const personal = rnd(2) ? [{ id: `pp${rnd(9)}`, owner_user_id: UID, ws_id: WS, slug: 'jun', org_id: null, status: 'active', face: faces[rnd(4)], avatar_url: rnd(3) ? null : `https://x/p${rnd(5)}.jpg`, created_at: `2026-09-0${1 + rnd(3)}T00:00:00+00:00` }] : [];
    const existing = [...orgRows, ...personal];
    const body = M.repLooks(existing).get('jun') ?? { face: null, avatar_url: null };
    // 새 조직 행(가장 늦게 만든, 얼굴·사진 없음)을 그 에이전트의 행들과 같이 놓고 메신저가 그 행에 그리는 얼굴·사진
    const msgr = agentLooks([...existing, { id: 'oNEW', owner_user_id: UID, ws_id: WS, slug: 'jun', org_id: 'orgNEW', status: 'active', face: null, avatar_url: null, created_at: '2026-10-05T00:00:00+00:00' }]).get('oNEW');
    assert.deepEqual([body.face, body.avatar_url], [msgr.face, msgr.photo], `행 ${JSON.stringify(existing)}`);
  }
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

// 2026-10-08 PR-C(계획 rc-0195 personal-crew-room-features-plan.md 5-3 #1) — 1단계의 '개인 턴은 전부 거절'을 바꾼다: 주인과 이 에이전트만 있는
// crew 1:1(서버 판정 ctx.ownCrewRoom === true)에서 주인이 시킨 일·자기 자신 대상만 연다. 나머지는 이유별 문구로 거절(자세한 경우는 msgr-personal-room-body.test.mjs).
test('개인 턴의 결재·예약·긴 작업 — crew 1:1(서버 판정 true)·주인 턴·자기 자신만 열고, 친구 방·판정 모름·손님·다른 에이전트 대상은 이유를 말하고 거절한다', () => {
  const peers = [{ id: 'c-pin', slug: 'seoyun', owner_user_id: UID, ws_id: WS }, { id: 'c-jun', slug: 'jun', owner_user_id: UID, ws_id: WS }];
  const base = { kind: 'msgr', orgId: null, channelId: PCH, channelKind: 'dm', crewId: 'c-pin', uid: UID, wsId: WS, origin: UID, peers };
  const own = messengerOrigin({ ...base, ownCrewRoom: true });
  assert.deepEqual([own.orgId, own.ownCrewRoom, own.channelId, own.crewId], [null, true, PCH, 'c-pin'], 'crew 1:1 주인 턴은 연다 — 기록은 조직 없음 + 표지');
  assert.equal(messengerOrigin({ ...base, ownCrewRoom: true }, 'seoyun').crewId, 'c-pin', '자기 자신 대상(예약·긴 작업 기본 담당)');
  assert.throws(() => messengerOrigin({ ...base, ownCrewRoom: false }), /친구와의 방/, '친구 1:1·그룹(서버 판정 false)');
  assert.throws(() => messengerOrigin(base), /개인 공간에서는 아직/, '판정 모름(옛 서버·조회 실패)은 1단계 문구 그대로');
  assert.throws(() => messengerOrigin({ ...base, ownCrewRoom: true, origin: FRIEND, rootAuthor: FRIEND }), /주인이 아닌 사람/, '손님');
  assert.throws(() => messengerOrigin({ ...base, ownCrewRoom: true }, 'jun'), /다른 에이전트/, '다른 에이전트 대상');
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
