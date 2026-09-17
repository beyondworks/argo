// 메신저 자동 켜기(실사고 2026-09-15) — 브리지는 msgr.enabled가 켜져야 돌고, enabled는 등록이 있어야 켜졌다. 9/8에 수동 등록 버튼을
// 없애자 새 계정은 크루가 영영 안 올라갔다(라이브: 9/11 이후 가입 5명 전원 크루 0). 꺼진 회사는 10분에 한 번 멤버십을 묻고 멤버면 켠다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoEnableMsgr, MSGR_AUTO_ENABLE_PROBE_MS, MSGR_AUTO_ENABLE_NO_SESSION_MS } from '../src/gateway/msgr.mjs';

const mk = ({ orgs = ['org-1'], uid = 'u1', session = true, fail = false, hang = false, fresh = null, hasCrew = false } = {}) => {
  const calls = { probes: 0, updates: [], loads: 0 };
  const deps = {
    probes: new Map(), orgCache: new Map(), now: () => 1_000_000, timeoutMs: 20,
    session: async () => session ? { uid, db: { myOrgIds: async () => { calls.probes += 1; if (fail) throw new Error('db down'); if (hang) return new Promise(() => {}); return orgs; }, hasAnyCrew: async () => hasCrew } } : null,
    load: async (ws) => { calls.loads += 1; return fresh ?? { id: ws, msgr: {} }; },
    update: async (ws, patch) => { calls.updates.push([ws, patch]); },
    log: () => {},
  };
  return { deps, calls };
};

test('조직 멤버 + 꺼진 회사 → 쓰기 직전 다시 읽은 company.json의 msgr 위에 enabled:true (sync 머리 스냅샷 뒤 저장된 notify를 덮지 않는다 — 검수 MEDIUM-3)', async () => {
  const { deps, calls } = mk({ fresh: { msgr: { notify: { mode: 'dm' }, mutedEvents: ['job'] } } });
  assert.equal(await autoEnableMsgr('ws-a', { company: { id: 'ws-a', ownerId: 'u1', msgr: {} }, ...deps }), true);
  assert.deepEqual(calls.updates, [['ws-a', { msgr: { notify: { mode: 'dm' }, mutedEvents: ['job'], enabled: true } }]]);
  assert.equal(calls.probes, 1); assert.equal(calls.loads, 1);
});
test('다시 읽었더니 이미 켜져 있으면(다른 경로가 먼저 켬) 쓰지 않고 true', async () => {
  const { deps, calls } = mk({ fresh: { msgr: { enabled: true } } });
  assert.equal(await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }), true);
  assert.deepEqual(calls.updates, []);
});
test('이미 켜짐·조직 회사(nodeOrgId)·회사 없음 → 세션도 DB도 건드리지 않는다', async () => {
  for (const company of [{ msgr: { enabled: true } }, { msgr: { nodeOrgId: 'org-x' } }, null]) {
    const { deps, calls } = mk();
    assert.equal(await autoEnableMsgr('ws-a', { company, ...deps }), false);
    assert.equal(calls.probes, 0); assert.deepEqual(calls.updates, []);
  }
});
test('세션 없음(로그아웃·만료) → false, 60초만 쉰다 — 10초마다 세션 파일·refresh를 두드리지 않고(검수 MEDIUM-1), 로그인 뒤 최대 1분 안에 켜진다', async () => {
  let t = 1_000_000; const { deps, calls } = mk({ session: false }); deps.now = () => t;
  let sessionCalls = 0; const noSession = deps.session; deps.session = async () => { sessionCalls += 1; return noSession(); };
  assert.equal(await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }), false);
  for (let i = 0; i < 5; i++) { t += 10_000; await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }); }
  assert.equal(sessionCalls, 1, '60초 안에는 세션을 다시 묻지 않는다');
  t += MSGR_AUTO_ENABLE_NO_SESSION_MS;
  deps.session = async () => ({ uid: 'u1', db: { myOrgIds: async () => { calls.probes += 1; return ['org-1']; }, hasAnyCrew: async () => false } });
  assert.equal(await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }), true, '60초 뒤 세션이 생기면 켜진다');
});
test('이미 어느 회사·조직에든 크루 행이 있는 계정 → 손대지 않는다(유건 결정: 회사 10개 중 2개만 파견한 계정에 나머지 8개가 갑자기 나타나지 않게)', async () => {
  const { deps, calls } = mk({ hasCrew: true });
  for (const ws of ['ws-a', 'ws-b']) assert.equal(await autoEnableMsgr(ws, { company: { id: ws, ownerId: 'u1', msgr: {} }, ...deps }), false);
  assert.equal(calls.probes, 1, '조회는 uid 캐시로 1건'); assert.deepEqual(calls.updates, []);
});
test('회사 N개 = 멤버십 질의 1건(uid 캐시 10분 — 검수 L1)', async () => {
  const { deps, calls } = mk();
  for (const ws of ['ws-a', 'ws-b', 'ws-c']) assert.equal(await autoEnableMsgr(ws, { company: { id: ws, ownerId: 'u1', msgr: {} }, ...deps }), true);
  assert.equal(calls.probes, 1); assert.equal(calls.updates.length, 3);
});
test('멤버십 조회가 멈추면 3초(여기선 20ms) 상한으로 끊고 false — 뒤 회사들의 큐·브리지 기동을 막지 않는다(검수 L3)', async () => {
  const { deps, calls } = mk({ hang: true }); const logs = []; deps.log = (...a) => logs.push(a.join(' '));
  assert.equal(await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }), false);
  assert.match(logs[0], /timeout 20ms/); assert.deepEqual(calls.updates, []);
});
test('멤버 아님 → false. 10분 안에는 DB를 다시 묻지 않고, 10분 뒤에는 다시 묻는다 (10초 sync에 얹혀도 조회는 회사당 10분에 1건)', async () => {
  const { deps, calls } = mk({ orgs: [] });
  let t = 1_000_000; deps.now = () => t;
  for (let i = 0; i < 5; i++) assert.equal(await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }), false);
  assert.equal(calls.probes, 1, '연속 호출에 조회 1건');
  t += MSGR_AUTO_ENABLE_PROBE_MS - 1; await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }); assert.equal(calls.probes, 1);
  t += 1; await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }); assert.equal(calls.probes, 2, '10분 지나면 다시 묻는다(회사 스로틀·uid 캐시 둘 다 만료)');
  assert.deepEqual(calls.updates, []);
});
test('회사 소유자 게이트 — company.ownerId가 세션 uid와 다르면 묻지도 켜지도 않는다(남의 회사 크루를 내 조직에 올리지 않는다)', async () => {
  const { deps, calls } = mk({ uid: 'u2' });
  assert.equal(await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }), false);
  assert.equal(calls.probes, 0); assert.deepEqual(calls.updates, []);
  assert.equal(await autoEnableMsgr('ws-b', { company: { ownerId: 'u2', msgr: {} }, ...deps }), true, '소유자 일치면 켜진다');
});
test('소유자가 기록되지 않은 회사 → 묻지도 켜지도 않는다(실사고 2026-09-17 — "있을 때만 비교"라 소유자 없는 회사·읽기 실패가 통과했다)', async () => {
  const { deps, calls } = mk();
  assert.equal(await autoEnableMsgr('ws-a', { company: { msgr: {} }, ...deps }), false);
  assert.equal(await autoEnableMsgr('ws-b', { company: { ownerId: null, msgr: {} }, ...deps }), false);
  assert.equal(calls.probes, 0); assert.deepEqual(calls.updates, []);
});
test('멤버십 조회 실패 → false·로그, 던지지 않는다(게이트웨이 sync를 죽이지 않는다)', async () => {
  const { deps, calls } = mk({ fail: true }); const logs = []; deps.log = (...a) => logs.push(a.join(' '));
  assert.equal(await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }), false);
  assert.deepEqual(calls.updates, []); assert.match(logs[0], /조직 멤버십 조회 실패/);
});
test('배선 — 게이트웨이 sync가 큐 조립 전에 autoEnableMsgr를 부르고 결과로 c.msgr을 갱신한다(같은 sync에서 브리지 시작)', () => {
  const src = readFileSync(new URL('../src/gateway.mjs', import.meta.url), 'utf8');
  const call = src.indexOf("await autoEnableMsgr(c.id, { company: c })"); const q = src.indexOf("if (c.msgr?.enabled) qkeys.add(MSGR_KEY)");
  assert.ok(call > 0 && q > call, '자동 켜기가 큐 조립보다 앞에 있어야 같은 sync에서 드레인·브리지가 뜬다');
  assert.match(src, /c\.msgr = \{ \.\.\.\(c\.msgr \?\? \{\}\), enabled: true \}/, '켜진 결과를 c.msgr에 반영');
  assert.ok(src.indexOf('if (!procLeader) {') < call, '리더 게이트 뒤에서만(기기당 한 프로세스)');
});
