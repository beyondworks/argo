// agent-pick.mjs — 슬롯 셈(서버 count distinct (ws_id, slug)과 같은 규칙)·선택 교체(멈춤 → 연결, 실패 시 되돌리기)
import test from 'node:test';
import assert from 'node:assert/strict';
import { slotState, slotKey, swapPreview, swapConnect, writeStatus, FREE_AGENT_LIMIT, readMyPlan } from '../src/agent-pick.mjs';

const me = 'u1';
const row = (id, ws, slug, status, over = {}) => ({ id, ws_id: ws, slug, status, owner_user_id: me, hosting: 'local', display_name: slug, ...over });

test('slotState — 같은 에이트(ws+slug)의 여러 공간 행은 한 자리, 하나라도 active면 연결됨', () => {
  const rows = [row('a1', 'w1', 'pepper', 'active'), row('a2', 'w1', 'pepper', 'available'), row('b1', 'w1', 'dale', 'paused'),
    row('c1', 'w2', 'eda', 'active'), row('x', 'w9', 'bot', 'active', { hosting: 'bot' }), row('z', 'w3', 'other', 'active', { owner_user_id: 'someone-else' })];
  const st = slotState(rows, me);
  assert.equal(st.slots.length, 3, '봇·남의 것 제외 3슬롯');
  assert.equal(st.used, 2, 'pepper·eda 연결됨');
  assert.equal(st.slots.find((s) => s.key === 'w1:dale').paused, true);
  assert.equal(st.slots.find((s) => s.key === 'w1:pepper').rows.length, 2);
});

test('swapPreview — 서버가 주는 멈춤 예정 이름, 오류·옛 서버는 []', async () => {
  const ok = { rpc: async () => ({ data: ['dale'], error: null }) };
  assert.deepEqual(await swapPreview(ok, row('a1', 'w1', 'pepper', 'available')), ['dale']);
  const err = { rpc: async () => ({ data: null, error: new Error('404') }) };
  assert.deepEqual(await swapPreview(err, row('a1', 'w1', 'pepper', 'available')), []);
});

const fakeDb = (failOn = null) => {
  const calls = [];
  return { calls, from: () => ({ update: (v) => ({ in: (c, ids) => { calls.push([v.status, ids]); return { select: () => Promise.resolve(failOn === v.status ? { data: null, error: { message: 'denied' } } : { data: ids.map((id) => ({ id })), error: null }) }; } }) }) };
};

test('writeStatus — RLS가 일부만 바꾸면(0행·일부 행) 오류로 본다', async () => {
  const db = fakeDb();
  assert.deepEqual(await writeStatus(db, ['a', 'b'], 'available'), { ok: true });
  const partial = { from: () => ({ update: () => ({ in: () => ({ select: () => Promise.resolve({ data: [{ id: 'a' }], error: null }) }) }) }) };
  assert.equal((await writeStatus(partial, ['a', 'b'], 'available')).ok, false);
});

test('swapConnect — 멈춤 먼저, 연결 실패 시 멈춤을 되돌린다', async () => {
  const ok = fakeDb();
  const victim = { name: 'dale', rows: [row('b1', 'w1', 'dale', 'active'), row('b2', 'w1', 'dale', 'active', { org_id: 'o' })] };
  const target = row('a1', 'w1', 'pepper', 'available');
  assert.deepEqual(await swapConnect(ok, victim, target), { ok: true });
  assert.deepEqual(ok.calls, [['available', ['b1', 'b2']], ['active', ['a1']]], '슬롯의 모든 행을 끊고 대상을 연결');

  const fail = fakeDb('active'); // 연결 쓰기가 거절
  const r = await swapConnect(fail, victim, target);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'connect');
  assert.deepEqual(fail.calls[2], ['active', ['b1', 'b2']], '멈춘 행을 되돌린다');
});

test('readMyPlan — pro/trial/free만 값으로, 실패·모름은 이전 값(초기 null)', async () => {
  const pro = { rpc: async () => ({ data: { plan: 'pro' }, error: null }) };
  assert.equal(await readMyPlan(pro, 1000), 'pro');
  const weird = { rpc: async () => ({ data: { plan: 'enterprise??' }, error: null }) };
  assert.equal(await readMyPlan(weird, 1000 + 400_000), 'pro', '모르는 값은 이전 값 유지');
  const down = { rpc: async () => ({ data: null, error: new Error('net') }) };
  assert.equal(await readMyPlan(down, 1000 + 800_000), 'pro', '오류도 이전 값');
});

