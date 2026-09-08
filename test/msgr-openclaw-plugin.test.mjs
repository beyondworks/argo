// 오픈클로 채널 플러그인의 전송 계층(integrations/openclaw-argo-msgr/src/api.js) — 가짜 fetch로 주소·봉투·롱폴·401 정지를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApi, pollLoop, ArgoMsgrError } from '../integrations/openclaw-argo-msgr/src/api.js';

const T = 'argo_bot_' + 'b'.repeat(48);
const fakeFetch = (routes) => { const calls = []; const f = async (url, init) => { calls.push([url, init]); const key = url.split('/').pop().split('?')[0]; const r = routes[key]; const body = typeof r === 'function' ? r(url, init, calls.length) : r; return { status: body.ok ? 200 : (body.error_code ?? 500), json: async () => body }; }; f.calls = calls; return f; };

test('주소는 /bot<token>/<method>, GET 쿼리·POST JSON, {ok,result} 풀기, 오류는 ArgoMsgrError(status)', async () => {
  const f = fakeFetch({ getMe: { ok: true, result: { id: 'b1' } }, getUpdates: { ok: true, result: [] }, sendMessage: { ok: true, result: { message_id: 7 } }, bad: { ok: false, error_code: 403, description: 'nope' } });
  const api = makeApi({ url: 'https://x.supabase.co/functions/v1/msgr-bot/', token: T, fetchImpl: f });
  assert.deepEqual(await api.getMe(), { id: 'b1' });
  assert.equal(f.calls[0][0], `https://x.supabase.co/functions/v1/msgr-bot/bot${T}/getMe`);
  await api.getUpdates(5); assert.match(f.calls[1][0], /getUpdates\?offset=5&limit=50&timeout=20$/);
  assert.equal((await api.sendMessage('c1', '네', 3)).message_id, 7);
  assert.deepEqual(JSON.parse(f.calls[2][1].body), { chat_id: 'c1', text: '네', reply_to_message_id: 3 }); assert.equal(f.calls[2][1].method, 'POST');
  await api.sendMessage('c1', '평문'); assert.equal('reply_to_message_id' in JSON.parse(f.calls[3][1].body), false);
  const f2 = fakeFetch({ getMe: { ok: false, error_code: 401, description: 'Unauthorized' } });
  await assert.rejects(makeApi({ url: 'https://x', token: T, fetchImpl: f2 }).getMe(), (e) => e instanceof ArgoMsgrError && e.status === 401);
});

test('pollLoop: offset=마지막 update_id+1(ack) · 순서대로 onMessage · 401이면 멈춤 · 일반 오류는 백오프 재시도', async () => {
  const seen = []; let n = 0;
  const f = fakeFetch({ getUpdates: (url) => { n++; if (n === 1) return { ok: true, result: [{ update_id: 3, message: { text: 'a' } }, { update_id: 4, message: { text: 'b' } }] }; if (n === 2) { assert.match(url, /offset=5/); return { ok: false, error_code: 500, description: 'boom' }; } return { ok: false, error_code: 401, description: 'Unauthorized' }; } });
  const logs = []; const sleeps = [];
  await pollLoop(makeApi({ url: 'https://x', token: T, fetchImpl: f }), { onMessage: (m) => { seen.push(m.text); }, log: (s) => logs.push(s), sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(seen, ['a', 'b']); assert.deepEqual(sleeps, [1000]); assert.equal(n, 3);
  assert.match(logs.at(-1), /token rejected/);
});
