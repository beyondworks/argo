// R3(축소판 A+): v2 앱이 휴대폰 푸시 토큰을 v2 기기 등록에 싣는지 — 묶음 함수(행동)와 App.jsx 배선(옛 등록을 v2에서 부르지 않음)을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindV2Push } from '../src/v2/push-bind.mjs';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

test('로그인 때 토큰을 물어(권한 요청) 기계에 싣고, 앱 재개마다 다시 싣는다', async () => {
  const got = []; let resume = null; const asks = [];
  const off = bindV2Push({ machine: { setPushToken: (t) => got.push(t) }, getToken: async (prompt) => { asks.push(prompt); return { token: `tok-${asks.length}` }; }, observeResume: (fn) => { resume = fn; return () => { resume = null; }; } });
  await flush();
  assert.deepEqual(got, ['tok-1']); assert.deepEqual(asks, [true]);
  resume(); await flush();
  assert.deepEqual(got, ['tok-1', 'tok-2']);
  off();
  assert.equal(resume, null, '해제하면 재개 감시도 끈다');
});

test('권한 거부·토큰 없음·오류는 기계를 건드리지 않는다, 해제 뒤 늦게 온 토큰도 버린다', async () => {
  const got = [];
  bindV2Push({ machine: { setPushToken: (t) => got.push(t) }, getToken: async () => ({ status: 'denied' }) });
  bindV2Push({ machine: { setPushToken: (t) => got.push(t) }, getToken: async () => { throw new Error('plugin'); } });
  let release; const late = new Promise((r) => { release = r; });
  const off = bindV2Push({ machine: { setPushToken: (t) => got.push(t) }, getToken: () => late });
  off(); release({ token: 'late' }); await flush();
  assert.deepEqual(got, []);
});

test('App.jsx 배선: v2에서는 기계에 토큰을 싣고(bindV2Push) 옛 msgr_push_register 등록을 하지 않는다, 로그아웃은 dropPushToken', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /bindV2Push\(\{ machine: v2rt\.machine, getToken: getPushToken, observeResume: observeMobileResume \}\)/);
  assert.match(app, /if \(!isMobilePlatform \|\| V2\) return;\s*\/\/ v2:/);
  assert.match(app, /await currentV2\(\)\?\.machine\.dropPushToken\(\)/);
  const push = readFileSync(new URL('../src/push.js', import.meta.url), 'utf8');
  assert.match(push, /export async function getPushToken\(prompt\)/);
});
