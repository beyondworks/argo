// 봇 API 번역층(supabase/functions/msgr-bot/core.js) — 가짜 RPC로 봉투·롱폴·offset·오류 매핑을 잠근다. DB 판정은 test/msgr-bots-pg.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, parseRequest, METHODS } from '../supabase/functions/msgr-bot/core.js';

const T = 'argo_bot_' + 'a'.repeat(48);
const CH = '11111111-1111-4111-8111-111111111111';
const fakeRpc = (table) => { const calls = []; const rpc = async (fn, args) => { calls.push([fn, args]); const r = table[fn]; if (r instanceof Error) throw r; return typeof r === 'function' ? r(args, calls.length) : r; }; rpc.calls = calls; return rpc; };
const pgErr = (name) => Object.assign(new Error(`${name}`), { code: 'P0001' });

test('parseRequest: /bot<token>/<method> 경로 · Bearer 헤더 폴백 · 쿼리+본문 병합', () => {
  assert.deepEqual(parseRequest(`https://x.supabase.co/functions/v1/msgr-bot/bot${T}/getUpdates?offset=5`, {}, { timeout: 20 }), { token: T, method: 'getUpdates', params: { offset: '5', timeout: 20 } });
  assert.deepEqual(parseRequest('https://x/msgr-bot/getMe', { authorization: `Bearer ${T}` }, null), { token: T, method: 'getMe', params: {} });
  assert.equal(parseRequest('https://x/msgr-bot/getMe', {}, null).token, null);
});

test('토큰 없음 401 · 모르는 메서드 404 · 지원 메서드 5종', async () => {
  assert.deepEqual(METHODS, ['getMe', 'getUpdates', 'sendMessage', 'sendChatAction', 'getFile']);
  assert.equal((await handle({ token: null, method: 'getMe' }, fakeRpc({}))).status, 401);
  const r = await handle({ token: T, method: 'setWebhook' }, fakeRpc({}));
  assert.equal(r.status, 404); assert.equal(r.body.ok, false); assert.match(r.body.description, /setWebhook/);
});

test('getMe: RPC 결과를 텔레그램 모양(is_bot·first_name)으로', async () => {
  const rpc = fakeRpc({ msgr_bot_me: { bot_id: 'b1', crew_id: 'c1', org_id: 'o1', org_name: 'Lean', org_slug: 'lean', name: '헤르메스', kind: 'hermes', status: 'active' } });
  const r = await handle({ token: T, method: 'getMe' }, rpc);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, result: { id: 'b1', is_bot: true, first_name: '헤르메스', kind: 'hermes', crew_id: 'c1', org: { id: 'o1', name: 'Lean', slug: 'lean' }, status: 'active' } });
  assert.deepEqual(rpc.calls, [['msgr_bot_me', { token: T }]]);
});

test('getUpdates: offset → after_id(offset-1) · 비어 있으면 timeout까지 폴 · 도착 즉시 반환 · limit 클램프', async () => {
  const up = { update_id: 7, message: { message_id: 7, text: 'hi' } };
  const rpc = fakeRpc({ msgr_bot_updates: (args, n) => (n >= 3 ? [up] : []) });
  let t = 0; const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  const r = await handle({ token: T, method: 'getUpdates', params: { offset: '5', timeout: '20', limit: '500' } }, rpc, clock);
  assert.deepEqual(r.body, { ok: true, result: [up] });
  assert.equal(rpc.calls.length, 3); assert.deepEqual(rpc.calls[0][1], { token: T, after_id: 4, lim: 100 });
  assert.equal(t, 2000, '1초 폴 두 번 뒤 도착');
  // 빈 채로 timeout 만료 → 빈 배열, 대기 상한은 maxWaitMs
  const rpc2 = fakeRpc({ msgr_bot_updates: [] }); t = 0;
  const r2 = await handle({ token: T, method: 'getUpdates', params: { timeout: 99 } }, rpc2, { ...clock, maxWaitMs: 3000 });
  assert.deepEqual(r2.body.result, []); assert.equal(t, 3000); assert.equal(rpc2.calls[0][1].after_id, 0);
  // timeout 0 = 즉시 1회
  const rpc3 = fakeRpc({ msgr_bot_updates: [] }); await handle({ token: T, method: 'getUpdates' }, rpc3, clock); assert.equal(rpc3.calls.length, 1);
});

test('sendMessage: 인자 검증(400) · RPC 호출 모양 · 결과 봉투', async () => {
  const rpc = fakeRpc({ msgr_bot_send: 42 });
  assert.equal((await handle({ token: T, method: 'sendMessage', params: { chat_id: 'general', text: 'x' } }, rpc)).status, 400);
  assert.equal((await handle({ token: T, method: 'sendMessage', params: { chat_id: CH, text: '  ' } }, rpc)).status, 400);
  assert.equal((await handle({ token: T, method: 'sendMessage', params: { chat_id: CH, text: 'x', reply_to_message_id: 'abc' } }, rpc)).status, 400);
  assert.equal(rpc.calls.length, 0, '검증 실패는 RPC까지 안 간다');
  const r = await handle({ token: T, method: 'sendMessage', params: { chat_id: CH, text: '네', reply_to_message_id: '7' } }, rpc);
  assert.deepEqual(r.body, { ok: true, result: { message_id: 42, chat: { id: CH }, text: '네', reply_to_message_id: 7 } });
  assert.deepEqual(rpc.calls[0], ['msgr_bot_send', { token: T, channel: CH, body: '네', src_id: 7 }]);
  const r2 = await handle({ token: T, method: 'sendMessage', params: { chat_id: CH, text: '알림' } }, rpc);
  assert.equal(rpc.calls[1][1].src_id, null); assert.equal(r2.body.result.reply_to_message_id, undefined);
});

test('오류 매핑: DB raise 이름 → 401/403/400 · 미지 오류 500(본문 200자 상한)', async () => {
  const cases = [['msgr_bot_unauthorized', 401], ['msgr_not_allowed', 403], ['msgr_bot_not_member', 403], ['msgr_bot_no_channel', 400], ['msgr_bot_bad_reply', 400], ['msgr_reply_cross_channel', 400]];
  for (const [name, code] of cases) {
    const r = await handle({ token: T, method: 'getMe' }, fakeRpc({ msgr_bot_me: pgErr(name) }));
    assert.equal(r.status, code, name); assert.equal(r.body.error_code, code); assert.equal(r.body.ok, false);
  }
  const r = await handle({ token: T, method: 'getMe' }, fakeRpc({ msgr_bot_me: new Error('x'.repeat(500)) }));
  assert.equal(r.status, 500); assert.ok(r.body.description.length < 220);
});

test('claim-bound responses forward attempt/disposition/mentions without accepting client origin or thread', async () => {
  const attempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rpc = fakeRpc({ msgr_bot_finish: 99 });
  const mentions = [{ kind: 'crew', id: CH }];
  const result = await handle({token:T,method:'sendMessage',params:{chat_id:CH,text:'next',reply_to_message_id:7,execution_attempt:attempt,disposition:'handoff',mentions,origin:'forged',thread_root:999}},rpc);
  assert.equal(result.status,200);
  assert.deepEqual(rpc.calls,[['msgr_bot_finish',{token:T,channel:CH,body:'next',src_id:7,attempt,disposition:'handoff',mentions}]]);
  assert.equal((await handle({token:T,method:'sendMessage',params:{chat_id:CH,text:'x',execution_attempt:attempt}},rpc)).status,400);
});

test('sendChatAction: chat_id 검증 → msgr_bot_typing RPC → true(텔레그램 모양); action은 typing만; 범위 밖은 403', async () => {
  const calls = []; const rpc = async (fn, args) => { calls.push([fn, args]); if (args.channel === '00000000-0000-4000-8000-00000000dead') throw new Error('msgr_bot_not_member'); return null; };
  const ok = await handle({ token: T, method: 'sendChatAction', params: { chat_id: '11111111-1111-4111-8111-111111111111', action: 'typing' } }, rpc);
  assert.equal(ok.status, 200); assert.deepEqual(ok.body, { ok: true, result: true });
  assert.deepEqual(calls, [['msgr_bot_typing', { token: T, channel: '11111111-1111-4111-8111-111111111111' }]]);
  assert.equal((await handle({ token: T, method: 'sendChatAction', params: { chat_id: 'nope' } }, rpc)).status, 400, 'chat_id 형식');
  assert.equal((await handle({ token: T, method: 'sendChatAction', params: { chat_id: '11111111-1111-4111-8111-111111111111', action: 'upload_photo' } }, rpc)).status, 400, 'typing 외 action');
  const out = await handle({ token: T, method: 'sendChatAction', params: { chat_id: '00000000-0000-4000-8000-00000000dead' } }, rpc);
  assert.equal(out.status, 403); assert.match(out.body.description, /add the bot to this channel/);
});

test('getFile: file_id 검증 → msgr_bot_file → 서명 URL을 file_path로(텔레그램 모양); 서명 불가 500; 채널 밖 403; 없는 파일 400', async () => {
  const FID = '22222222-2222-4222-8222-222222222222';
  const rpc = async (fn, args) => { if (args.attachment === '00000000-0000-4000-8000-00000000dead') throw new Error('msgr_bot_not_member'); if (args.attachment === '00000000-0000-4000-8000-000000000000') throw new Error('msgr_bot_no_file');
    return { file_id: args.attachment, file_name: '커리큘럼.csv', mime_type: 'text/csv', file_size: 21000, storage_path: 'org/ch/1/0-265263.csv' }; };
  const signed = []; const sign = async (path, ttl) => { signed.push([path, ttl]); return `https://x.supabase.co/storage/v1/object/sign/msgr/${path}?token=abc`; };
  const r = await handle({ token: T, method: 'getFile', params: { file_id: FID } }, rpc, { sign });
  assert.equal(r.status, 200); assert.deepEqual(r.body.result, { file_id: FID, file_name: '커리큘럼.csv', mime_type: 'text/csv', file_size: 21000, file_path: 'https://x.supabase.co/storage/v1/object/sign/msgr/org/ch/1/0-265263.csv?token=abc' });
  assert.deepEqual(signed, [['org/ch/1/0-265263.csv', 600]], '서명 URL 수명 600초');
  assert.equal((await handle({ token: T, method: 'getFile', params: { file_id: 'nope' } }, rpc, { sign })).status, 400);
  assert.equal((await handle({ token: T, method: 'getFile', params: { file_id: FID } }, rpc)).status, 500, 'sign 없음 → 500(경로를 노출하지 않는다)');
  assert.equal((await handle({ token: T, method: 'getFile', params: { file_id: '00000000-0000-4000-8000-00000000dead' } }, rpc, { sign })).status, 403);
  assert.equal((await handle({ token: T, method: 'getFile', params: { file_id: '00000000-0000-4000-8000-000000000000' } }, rpc, { sign })).status, 400);
});
