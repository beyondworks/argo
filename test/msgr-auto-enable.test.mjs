// 메신저 자동 켜기(실사고 2026-09-15) — 브리지는 msgr.enabled가 켜져야 돌고, enabled는 등록이 있어야 켜졌다. 9/8에 수동 등록 버튼을
// 없애자 새 계정은 크루가 영영 안 올라갔다(라이브: 9/11 이후 가입 5명 전원 크루 0). 꺼진 회사는 10분에 한 번 멤버십을 묻고 멤버면 켠다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoEnableMsgr, MSGR_AUTO_ENABLE_PROBE_MS } from '../src/gateway/msgr.mjs';

const mk = ({ orgs = ['org-1'], uid = 'u1', session = true, fail = false } = {}) => {
  const calls = { probes: 0, updates: [] };
  const deps = {
    probes: new Map(), now: () => 1_000_000,
    session: async () => session ? { uid, db: { myOrgIds: async () => { calls.probes += 1; if (fail) throw new Error('db down'); return orgs; } } } : null,
    update: async (ws, patch) => { calls.updates.push([ws, patch]); },
    log: () => {},
  };
  return { deps, calls };
};

test('조직 멤버 + 꺼진 회사 → enabled:true로 켜고 true (기존 msgr 필드는 보존)', async () => {
  const { deps, calls } = mk();
  assert.equal(await autoEnableMsgr('ws-a', { company: { id: 'ws-a', msgr: { notify: { mode: 'dm' } } }, ...deps }), true);
  assert.deepEqual(calls.updates, [['ws-a', { msgr: { notify: { mode: 'dm' }, enabled: true } }]]);
  assert.equal(calls.probes, 1);
});
test('이미 켜짐·조직 회사(nodeOrgId)·회사 없음 → 세션도 DB도 건드리지 않는다', async () => {
  for (const company of [{ msgr: { enabled: true } }, { msgr: { nodeOrgId: 'org-x' } }, null]) {
    const { deps, calls } = mk();
    assert.equal(await autoEnableMsgr('ws-a', { company, ...deps }), false);
    assert.equal(calls.probes, 0); assert.deepEqual(calls.updates, []);
  }
});
test('세션 없음(로그아웃) → false, 그리고 10분 잠금을 찍지 않는다 — 로그인 직후 다음 sync에서 바로 켜진다', async () => {
  const { deps, calls } = mk({ session: false });
  assert.equal(await autoEnableMsgr('ws-a', { company: { msgr: {} }, ...deps }), false);
  assert.equal(deps.probes.size, 0);
  deps.session = async () => ({ uid: 'u1', db: { myOrgIds: async () => { calls.probes += 1; return ['org-1']; } } });
  assert.equal(await autoEnableMsgr('ws-a', { company: { msgr: {} }, ...deps }), true, '같은 시각이어도 세션이 생기면 즉시 켜진다');
});
test('멤버 아님 → false. 10분 안에는 DB를 다시 묻지 않고, 10분 뒤에는 다시 묻는다 (10초 sync에 얹혀도 조회는 회사당 10분에 1건)', async () => {
  const { deps, calls } = mk({ orgs: [] });
  let t = 1_000_000; deps.now = () => t;
  for (let i = 0; i < 5; i++) assert.equal(await autoEnableMsgr('ws-a', { company: { msgr: {} }, ...deps }), false);
  assert.equal(calls.probes, 1, '연속 호출에 조회 1건');
  t += MSGR_AUTO_ENABLE_PROBE_MS - 1; await autoEnableMsgr('ws-a', { company: { msgr: {} }, ...deps }); assert.equal(calls.probes, 1);
  t += 1; await autoEnableMsgr('ws-a', { company: { msgr: {} }, ...deps }); assert.equal(calls.probes, 2, '10분 지나면 다시 묻는다');
  assert.deepEqual(calls.updates, []);
});
test('회사 소유자 게이트 — company.ownerId가 세션 uid와 다르면 묻지도 켜지도 않는다(남의 회사 크루를 내 조직에 올리지 않는다)', async () => {
  const { deps, calls } = mk({ uid: 'u2' });
  assert.equal(await autoEnableMsgr('ws-a', { company: { ownerId: 'u1', msgr: {} }, ...deps }), false);
  assert.equal(calls.probes, 0); assert.deepEqual(calls.updates, []);
  assert.equal(await autoEnableMsgr('ws-b', { company: { ownerId: 'u2', msgr: {} }, ...deps }), true, '소유자 일치면 켜진다');
});
test('멤버십 조회 실패 → false·로그, 던지지 않는다(게이트웨이 sync를 죽이지 않는다)', async () => {
  const { deps, calls } = mk({ fail: true }); const logs = []; deps.log = (...a) => logs.push(a.join(' '));
  assert.equal(await autoEnableMsgr('ws-a', { company: { msgr: {} }, ...deps }), false);
  assert.deepEqual(calls.updates, []); assert.match(logs[0], /조직 멤버십 조회 실패/);
});
test('배선 — 게이트웨이 sync가 큐 조립 전에 autoEnableMsgr를 부르고 결과로 c.msgr을 갱신한다(같은 sync에서 브리지 시작)', () => {
  const src = readFileSync(new URL('../src/gateway.mjs', import.meta.url), 'utf8');
  const call = src.indexOf("await autoEnableMsgr(c.id, { company: c })"); const q = src.indexOf("if (c.msgr?.enabled) qkeys.add(MSGR_KEY)");
  assert.ok(call > 0 && q > call, '자동 켜기가 큐 조립보다 앞에 있어야 같은 sync에서 드레인·브리지가 뜬다');
  assert.match(src, /c\.msgr = \{ \.\.\.\(c\.msgr \?\? \{\}\), enabled: true \}/, '켜진 결과를 c.msgr에 반영');
  assert.ok(src.indexOf('if (!procLeader) {') < call, '리더 게이트 뒤에서만(기기당 한 프로세스)');
});
