// 크루 인벤토리(부록 M, 유건 지시 2026-09-07 "슬랙처럼 로그인하면 내 에이전트 목록·채널에 골라 초대"):
//  아르고 브리지가 하트비트마다 회사 크루(이름·역할·slug만)를 내가 속한 조직에 status='available'로 미러한다.
//  · 새 크루 → available insert / 이름·역할 변경 → 갱신(상태 무관) / 카드 삭제 → available만 행 삭제(active·detached 유지)
//  · 회사 노드(nodeOrgId)는 미러하지 않는다 / 조직 0이면 조회도 없다 / 키·모델·기억 컬럼은 싣지 않는다
//  · 마이그레이션: status check에 available, 채널 멤버는 active만, 오프보딩이 available도 detached, dispatch/recall 감사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-inv-'));
const { mirrorInventory, drain } = await import('../src/gateway/msgr.mjs');
const { paths } = await import('../src/workspace.mjs');
const UID = '11111111-1111-4111-8111-111111111111', O1 = 'aaaaaaaa-0000-4000-8000-000000000001', O2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const agents = [{ slug: 'seoyun', name: '서윤', role: '마케터' }, { slug: 'jun', name: '준', role: '데이터 분석' }];

function db({ orgs = [O1], rows = [] } = {}) {
  const calls = [];
  return { calls,
    async myOrgIds() { calls.push(['myOrgIds']); return orgs; },
    async myCrewRows() { calls.push(['myCrewRows']); return rows; },
    async upsertAvailable(r) { calls.push(['upsertAvailable', r]); },
    async orgAllowDefaults(ids) { calls.push(['orgAllowDefaults', ids]); return Object.fromEntries(ids.map((id) => [id, id === O1 ? 'all' : 'owner'])); }, // O1 정책 all, O2 정책 행 없음 → owner
    async updateCrewInfo(id, p) { calls.push(['updateCrewInfo', id, p]); },
    async deleteCrews(ids) { calls.push(['deleteCrews', ids]); },
    async myCrews() { return []; }, async nodeHeartbeat() {}, async pendingCrewRequests() { return []; },
  };
}

test('새 크루는 내가 속한 모든 조직에 기본 파견(active, allow = 조직 정책 기본값) — 키·모델 없이 이름·역할·slug만(유건 지시 2026-09-08)', async () => {
  const d = db({ orgs: [O1, O2] });
  const r = await mirrorInventory('ws1', { db: d, uid: UID, agents });
  assert.deepEqual(r, { orgs: 2, inserted: 4, updated: 0, removed: 0 });
  const up = d.calls.find(([k]) => k === 'upsertAvailable')[1];
  assert.equal(up.length, 4);
  for (const row of up) {
    assert.deepEqual(Object.keys(row).sort(), ['allow', 'allow_users', 'display_name', 'hosting', 'org_id', 'owner_user_id', 'role_text', 'slug', 'status', 'ws_id']);
    assert.equal(row.status, 'active'); assert.equal(row.hosting, 'local'); assert.equal(row.owner_user_id, UID);
    assert.equal(row.allow, row.org_id === O1 ? 'all' : 'owner', '조직 정책 기본값, 정책 없으면 owner'); assert.deepEqual(row.allow_users, []);
  }
});

test('이미 있는 크루: 이름·역할이 같으면 무변경, 바뀌면 상태와 무관하게 갱신(active도)', async () => {
  const d = db({ rows: [{ id: 'r1', org_id: O1, slug: 'seoyun', display_name: '서윤', role_text: '마케터', status: 'active' }, { id: 'r2', org_id: O1, slug: 'jun', display_name: '준(옛)', role_text: '데이터 분석', status: 'available' }] });
  const r = await mirrorInventory('ws1', { db: d, uid: UID, agents });
  assert.deepEqual(r, { orgs: 1, inserted: 0, updated: 1, removed: 0 });
  assert.deepEqual(d.calls.filter(([k]) => k === 'updateCrewInfo'), [['updateCrewInfo', 'r2', { display_name: '준', role_text: '데이터 분석' }]]);
  assert.ok(!d.calls.some(([k]) => k === 'upsertAvailable'));
});

test('카드에서 사라진(해고) 크루: available 행만 삭제, active·detached는 그대로(파견 해제는 소유자 몫)', async () => {
  const d = db({ rows: [
    { id: 'a', org_id: O1, slug: 'gone1', display_name: 'x', role_text: null, status: 'available' },
    { id: 'b', org_id: O1, slug: 'gone2', display_name: 'y', role_text: null, status: 'active' },
    { id: 'c', org_id: O1, slug: 'gone3', display_name: 'z', role_text: null, status: 'detached' },
  ] });
  const r = await mirrorInventory('ws1', { db: d, uid: UID, agents: [] });
  assert.deepEqual(r, { orgs: 1, inserted: 0, updated: 0, removed: 1 });
  assert.deepEqual(d.calls.find(([k]) => k === 'deleteCrews')[1], ['a']);
});

test('조직이 0이면 행 조회도 하지 않는다', async () => {
  const d = db({ orgs: [] });
  const r = await mirrorInventory('ws1', { db: d, uid: UID, agents });
  assert.deepEqual(r, { orgs: 0, inserted: 0, updated: 0, removed: 0 });
  assert.ok(!d.calls.some(([k]) => k === 'myCrewRows'));
});

test('drain 배선: 개인 회사는 하트비트마다 미러하고, 회사 노드(nodeOrgId)는 미러하지 않는다; 미러 실패가 드레인을 죽이지 않는다', async () => {
  const p = paths('ws1'); await mkdir(join(p.root, 'agents'), { recursive: true }); await writeFile(p.company, JSON.stringify({ id: 'ws1', name: 'x' }));
  const inv = async () => agents;
  const d1 = db(); await drain('ws1', { db: d1, uid: UID, enqueue: async () => {}, inventory: inv });
  assert.ok(d1.calls.some(([k]) => k === 'upsertAvailable'), '개인 회사: 미러');
  const d2 = db(); d2.crewDefaults = async () => ({ runner: '', model: '' });
  await drain('ws1', { db: d2, uid: UID, enqueue: async () => {}, nodeOrgId: O1, inventory: inv });
  assert.ok(!d2.calls.some(([k]) => k === 'myOrgIds'), '회사 노드: 미러 없음');
  const d3 = db(); d3.myOrgIds = async () => { throw new Error('boom'); };
  const r = await drain('ws1', { db: d3, uid: UID, enqueue: async () => {}, inventory: inv });
  assert.equal(r.crews, 0, '미러가 던져도 드레인은 이어진다');
});

test('마이그레이션 핀: available 상태·채널 멤버는 active만·오프보딩 포함·감사 트리거; 앱은 available을 내 크루로만 보이고 파견은 active 전이', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20260907120000_msgr_crew_inventory.sql', import.meta.url), 'utf8');
  assert.match(sql, /check \(status in \('active', 'detached', 'available'\)\)/);
  assert.match(sql, /when 'crew' then exists \(select 1 from public\.msgr_crews cr join public\.msgr_channels c on c\.id = ch where cr\.id = mid and cr\.org_id = c\.org_id and cr\.status = 'active'\)/, '채널 멤버는 파견된 크루만');
  assert.match(sql, /set status = 'detached' where org_id = new\.org_id and owner_user_id = new\.user_id and status in \('active', 'available'\)/);
  assert.match(sql, /'crew\.dispatch'/); assert.match(sql, /'crew\.recall'/);
  const app = readFileSync(new URL('../apps/messenger/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /\.in\('status', \['active', 'available'\]\)/);
  assert.match(app, /r\.status === 'available' && r\.owner_user_id === uid/, 'available은 내 것만 보인다');
  assert.match(app, /update\(\{ status: 'active', allow, allow_users: \[\] \}\)\.eq\('id', crew\.id\)/, '파견 = active 전이');
  const i18n = readFileSync(new URL('../apps/messenger/src/i18n.js', import.meta.url), 'utf8');
  for (const k of ['rail.mine', 'rail.mine.on', 'rail.mine.off', 'rail.mine.offShort', 'rail.hint.mine', 'ch.add.mine', 'ch.add.mine.note', 'ch.add.mine.done', 'ch.add.crew.none']) assert.ok(i18n.includes(`'${k}': ['`), `${k} ko/en`);
});
