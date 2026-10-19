// 축소판 A+ 실제 원본(source.mjs) — 무료는 plan 1회 뒤 아무것도 부르지 않고, 회의방·봇은 서버가 열기 전까지 '아직 열리지 않음'.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createAPlusSource } = await import('../src/aplus/source.mjs').catch((e) => ({ skip: e }));

function fakeRaw(plan = { plan: 'free' }) {
  const calls = [];
  return { calls, rpc: async (name) => { calls.push(name); return { data: name === 'my_plan' ? plan : null, error: null }; }, from: (t) => { calls.push(`from:${t}`); throw new Error('no table reads expected'); }, channel: () => { calls.push('channel'); throw new Error('no realtime expected'); }, auth: { getSession: async () => ({ data: { session: null } }) } };
}

test('plan(): my_plan 1회만 — 무료면 start를 부르지 않으므로 기기 등록·구독·조회 0', { skip: !createAPlusSource && 'source.mjs needs vite aliases' }, async () => {
  const raw = fakeRaw({ plan: 'free' });
  const s = createAPlusSource({ raw, uid: 'u1' });
  assert.equal(await s.plan(), 'free');
  assert.deepEqual(raw.calls, ['my_plan']);
  assert.equal(s.machine(), null);
  const sent = await s.send('room', 'hi');
  assert.equal(sent.ok, false); assert.deepEqual(raw.calls, ['my_plan'], '시작 전 보내기는 요청 0');
});

test('plan() 실패는 null(모름) — 화면은 다시 확인을 보인다', { skip: !createAPlusSource && 'source.mjs needs vite aliases' }, async () => {
  const s = createAPlusSource({ raw: { rpc: async () => ({ data: null, error: { message: 'Failed to fetch' } }) }, uid: 'u1' });
  assert.equal(await s.plan(), null);
});

test('회의방·외부 봇: 서버 RPC 확정 전에는 aplus_not_ready(요청 0)', { skip: !createAPlusSource && 'source.mjs needs vite aliases' }, async () => {
  const raw = fakeRaw();
  const s = createAPlusSource({ raw, uid: 'u1' });
  for (const fn of ['meetings', 'createMeeting', 'cancelMeeting', 'bots', 'addBot']) await assert.rejects(s[fn]({}), { code: 'aplus_not_ready' }, fn);
  assert.deepEqual(raw.calls, []);
});
