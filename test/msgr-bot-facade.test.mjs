// 봇 API 번역층(supabase/functions/msgr-bot/core.js) — 가짜 RPC로 봉투·롱폴·offset·오류 매핑을 잠근다. DB 판정은 test/msgr-bots-pg.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, parseRequest, METHODS } from '../supabase/functions/msgr-bot/core.js';

const T = 'argo_bot_' + 'a'.repeat(48);
const CH = '11111111-1111-4111-8111-111111111111';
const fakeRpc = (table) => { const calls = []; const rpc = async (fn, args) => { calls.push([fn, args]); const r = table[fn]; if (r instanceof Error) throw r; return typeof r === 'function' ? r(args, calls.length) : r; }; rpc.calls = calls; return rpc; };
const pgErr = (name) => Object.assign(new Error(`${name}`), { code: 'P0001' });

test('only capable adapters receive the delegated DM and passive CC protocol', async () => {
  const rpc=fakeRpc({msgr_bot_updates:[],msgr_bot_updates_with_delivery:[]});
  for(const protocol of [undefined,0,1,'1',2])await handle({token:T,method:'getUpdates',params:{delivery_protocol:protocol}},rpc);
  assert.deepEqual(rpc.calls.map(([name])=>name),['msgr_bot_updates','msgr_bot_updates','msgr_bot_updates_with_delivery','msgr_bot_updates_with_delivery','msgr_bot_updates']);
});

test('delegated typing requires a complete claim and does not fall back to channel typing', async () => {
  const attempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rpc = fakeRpc({ msgr_bot_typing: null });
  for (const extra of [{ reply_to_message_id: 7 }, { execution_attempt: attempt }, { reply_to_message_id: 0, execution_attempt: attempt }, { reply_to_message_id: 7, execution_attempt: 'invalid' }]) {
    assert.equal((await handle({ token: T, method: 'sendChatAction', params: { chat_id: CH, ...extra } }, rpc)).status, 400);
  }
  assert.equal(rpc.calls.length, 0);
  assert.equal((await handle({ token: T, method: 'sendChatAction', params: { chat_id: CH, reply_to_message_id: '7', execution_attempt: attempt } }, rpc)).status, 200);
  assert.deepEqual(rpc.calls, [['msgr_bot_typing', { token: T, channel: CH, src_id: 7, attempt }]]);
});

test('DM permission failures are permanent errors, not retryable server failures', async () => {
  for (const name of ['msgr_execution_forbidden', 'msgr_execution_source_forbidden', 'msgr_forbidden', 'msgr_crew_not_in_channel']) {
    const result = await handle({ token: T, method: 'getMe' }, fakeRpc({ msgr_bot_me: pgErr(name) }));
    assert.equal(result.status, 403, name);
  }
  assert.equal((await handle({ token: T, method: 'getMe' }, fakeRpc({ msgr_bot_me: pgErr('msgr_bad_delivery_role') }))).status, 400);
});

test('parseRequest: /bot<token>/<method> 경로 · Bearer 헤더 폴백 · 쿼리+본문 병합', () => {
  assert.deepEqual(parseRequest(`https://x.supabase.co/functions/v1/msgr-bot/bot${T}/getUpdates?offset=5`, {}, { timeout: 20 }), { token: T, method: 'getUpdates', params: { offset: '5', timeout: 20 } });
  assert.deepEqual(parseRequest('https://x/msgr-bot/getMe', { authorization: `Bearer ${T}` }, null), { token: T, method: 'getMe', params: {} });
  assert.equal(parseRequest('https://x/msgr-bot/getMe', {}, null).token, null);
});

test('토큰 없음 401 · 모르는 메서드 404 · 지원 메서드 5종', async () => {
  assert.deepEqual(METHODS, ['getMe', 'getUpdates', 'sendMessage', 'sendChatAction', 'getFile', 'setRoutines', 'routineEditDone', 'requestApproval', 'ackApproval', 'expireApproval', 'reportStatus']);
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

test('LOW(2차 검수) — msgr_bot_finish가 null을 돌리면(미자격 조직) 200 message_id:0이 아니라 403 msgr_org_unentitled', async () => {
  const attempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rpc = fakeRpc({ msgr_bot_finish: null });
  const result = await handle({ token: T, method: 'sendMessage', params: { chat_id: CH, text: 'late', reply_to_message_id: 7, execution_attempt: attempt } }, rpc);
  assert.equal(result.status, 403, '거짓 성공(200 message_id:0)이 아니라 403이어야 한다');
  assert.equal(result.body.ok, false);
  assert.match(result.body.description, /free period has ended/);
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

// ── 외부 에이전트 크루 계약 1-a(20260929130000) ──
test('getUpdates events=1 — 이벤트는 요청당 한 번 조회해 메시지 앞에 붙이고, 이벤트가 있으면 롱폴 없이 바로 돌려준다', async () => {
  const ev = { event: 'routine_edit', edit_id: 'e1' };
  const rpc = fakeRpc({ msgr_bot_events: [ev], msgr_bot_updates: [] });
  let slept = 0;
  const r = await handle({ token: T, method: 'getUpdates', params: { events: '1', timeout: 20 } }, rpc, { sleep: async () => { slept++; } });
  assert.deepEqual(r.body.result, [ev]);
  assert.equal(slept, 0, '이벤트가 있으면 기다리지 않는다');
  assert.deepEqual(rpc.calls.map(([n]) => n), ['msgr_bot_events', 'msgr_bot_updates']);
});

test('getUpdates — events를 요청하지 않은 옛 어댑터에는 이벤트 조회 자체가 없다', async () => {
  const rpc = fakeRpc({ msgr_bot_events: [{ event: 'x' }], msgr_bot_updates: [] });
  await handle({ token: T, method: 'getUpdates', params: {} }, rpc);
  assert.deepEqual(rpc.calls.map(([n]) => n), ['msgr_bot_updates']);
});

test('getUpdates events=1 — 이벤트 조회가 어떤 이유로 실패해도 메시지는 받는다(옛 서버·시간 초과·교착), 토큰 오류는 메시지 조회가 401로', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    for (const err of [Object.assign(new Error('Could not find the function public.msgr_bot_events'), { code: 'PGRST202' }),
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), Object.assign(new Error('deadlock detected'), { code: '40P01' })]) {
      const r = await handle({ token: T, method: 'getUpdates', params: { events: 1 } }, fakeRpc({ msgr_bot_events: err, msgr_bot_updates: [{ update_id: 3 }] }));
      assert.deepEqual(r.body.result, [{ update_id: 3 }], err.code);
    }
    const u = await handle({ token: T, method: 'getUpdates', params: { events: 1 } }, fakeRpc({ msgr_bot_events: pgErr('msgr_bot_unauthorized'), msgr_bot_updates: pgErr('msgr_bot_unauthorized') }));
    assert.equal(u.status, 401);
  } finally { console.warn = warn; }
});

test('setRoutines·routineEditDone — 입력 모양 검사 후 RPC 인자 이름 그대로 전달', async () => {
  const rpc = fakeRpc({ msgr_bot_routines_sync: { kept: 1 }, msgr_bot_routine_edit_done: true });
  assert.equal((await handle({ token: T, method: 'setRoutines', params: { rows: 'x' } }, rpc)).status, 400);
  assert.equal((await handle({ token: T, method: 'setRoutines', params: { rows: [{ ext_id: 'a' }] } }, rpc)).status, 200);
  assert.equal((await handle({ token: T, method: 'setRoutines', params: { unsupported: 'no cron api' } }, rpc)).status, 200);
  assert.equal((await handle({ token: T, method: 'routineEditDone', params: { edit_id: 'bad', status: 'applied' } }, rpc)).status, 400);
  assert.equal((await handle({ token: T, method: 'routineEditDone', params: { edit_id: CH, status: 'replaced' } }, rpc)).status, 400, 'replaced는 메신저 쪽 전용');
  assert.equal((await handle({ token: T, method: 'routineEditDone', params: { edit_id: CH, status: 'failed', error: 'job gone' } }, rpc)).status, 200);
  assert.deepEqual(rpc.calls, [
    ['msgr_bot_routines_sync', { token: T, p_rows: [{ ext_id: 'a' }], p_unsupported: null }],
    ['msgr_bot_routines_sync', { token: T, p_rows: [], p_unsupported: 'no cron api' }],
    ['msgr_bot_routine_edit_done', { token: T, p_id: CH, p_status: 'failed', p_error: 'job gone' }],
  ]);
});

test('requestApproval·ackApproval·expireApproval — 위험 등급·원문은 보내지도 않는다(서버가 정함), 충돌은 409', async () => {
  const attempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rpc = fakeRpc({ msgr_bot_request_approval: { id: 'x', risk: 'high' }, msgr_bot_ack_approval: { claimed: true }, msgr_bot_expire_approval: { status: 'expired' } });
  assert.equal((await handle({ token: T, method: 'requestApproval', params: { approval_id: 'ap-1', command: 'rm' } }, rpc)).status, 400, '실행 시도 없음');
  await handle({ token: T, method: 'requestApproval', params: { execution_attempt: attempt, approval_id: 'ap-1', command: 'rm -rf x', risk: 'low', kind: 'org_doc', source_message_id: 9 } }, rpc);
  assert.deepEqual(rpc.calls[0], ['msgr_bot_request_approval', { token: T, p_attempt: attempt, p_approval_id: 'ap-1', p_command: 'rm -rf x', p_reason: null }], 'risk·kind·원문 id는 버린다');
  assert.equal((await handle({ token: T, method: 'ackApproval', params: {} }, rpc)).status, 400);
  assert.deepEqual((await handle({ token: T, method: 'ackApproval', params: { approval_id: 'ap-1' } }, rpc)).body.result, { claimed: true });
  assert.deepEqual((await handle({ token: T, method: 'expireApproval', params: { approval_id: 'ap-1' } }, rpc)).body.result, { status: 'expired' });
  const c = await handle({ token: T, method: 'requestApproval', params: { execution_attempt: attempt, approval_id: 'ap-1', command: 'rm /' } }, fakeRpc({ msgr_bot_request_approval: pgErr('msgr_approval_conflict') }));
  assert.equal(c.status, 409);
});

// 1-b(2026-09-29) — 누가 연결하든 같은 계약: 버전·모드 보고, 에이전트 결재, 후속 보고
test('reportStatus — 문자열·불리언으로 번역해 전달하고, 응답(mirror_all)을 그대로 돌려준다', async () => {
  const rpc = fakeRpc({ msgr_bot_report_status: { mirror_all: true } });
  const r = await handle({ token: T, method: 'reportStatus', params: { version: '0.3.0', approval_mode: 'smart', mirror_all_applied: 'true' } }, rpc);
  assert.deepEqual(r.body.result, { mirror_all: true });
  assert.deepEqual(rpc.calls[0], ['msgr_bot_report_status', { token: T, p_version: '0.3.0', p_approval_mode: 'smart', p_mirror_all_applied: true }]);
  await handle({ token: T, method: 'reportStatus', params: {} }, rpc);
  assert.deepEqual(rpc.calls[1][1], { token: T, p_version: null, p_approval_mode: null, p_mirror_all_applied: null }, '빠진 값은 null(서버가 기존 값 유지)');
});

test('requestApproval kind=agent — 제목·사유로 에이전트 결재 RPC, 명령 RPC는 부르지 않는다', async () => {
  const attempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rpc = fakeRpc({ msgr_bot_request_agent_approval: { id: 'x', status: 'pending', risk: 'high' } });
  await handle({ token: T, method: 'requestApproval', params: { kind: 'agent', execution_attempt: attempt, approval_id: 'ag-1', title: '광고비', reason: '캠페인', risk: 'low' } }, rpc);
  assert.deepEqual(rpc.calls, [['msgr_bot_request_agent_approval', { token: T, p_attempt: attempt, p_approval_id: 'ag-1', p_title: '광고비', p_reason: '캠페인' }]]);
  assert.equal((await handle({ token: T, method: 'requestApproval', params: { kind: 'agent', approval_id: 'ag-1', title: 't' } }, rpc)).status, 400, '실행 시도 없음');
});

test('sendMessage + approval_id — 후속 보고 RPC(방·원문은 서버가 정함), chat_id 없이도 된다, 결정 전이면 403', async () => {
  const rpc = fakeRpc({ msgr_bot_followup: 501 });
  const r = await handle({ token: T, method: 'sendMessage', params: { approval_id: 'ag-1', text: '집행했습니다.' } }, rpc);
  assert.equal(r.status, 200); assert.equal(r.body.result.message_id, 501);
  assert.deepEqual(rpc.calls, [['msgr_bot_followup', { token: T, p_approval_id: 'ag-1', p_body: '집행했습니다.' }]]);
  assert.equal((await handle({ token: T, method: 'sendMessage', params: { approval_id: 'ag-1', text: ' ' } }, rpc)).status, 400);
  const denied = await handle({ token: T, method: 'sendMessage', params: { approval_id: 'ag-1', text: 'x' } }, fakeRpc({ msgr_bot_followup: pgErr('msgr_not_allowed') }));
  assert.equal(denied.status, 403);
});

test('requestApproval + parent_approval_id — 재개 턴 카드는 이어서 올리는 RPC로(실행 시도 없이), 셸·에이전트 구분은 kind', async () => {
  const rpc = fakeRpc({ msgr_bot_request_followup_approval: { id: 'x', status: 'pending' } });
  await handle({ token: T, method: 'requestApproval', params: { parent_approval_id: 'ag-1', approval_id: 'hx-2', command: 'rm -rf /tmp/a', reason: 'r' } }, rpc);
  await handle({ token: T, method: 'requestApproval', params: { parent_approval_id: 'ag-1', approval_id: 'ag-2', kind: 'agent', title: '메일 발송' } }, rpc);
  assert.deepEqual(rpc.calls, [
    ['msgr_bot_request_followup_approval', { token: T, p_parent: 'ag-1', p_approval_id: 'hx-2', p_kind: 'shell', p_text: 'rm -rf /tmp/a', p_reason: 'r' }],
    ['msgr_bot_request_followup_approval', { token: T, p_parent: 'ag-1', p_approval_id: 'ag-2', p_kind: 'agent', p_text: '메일 발송', p_reason: null }]]);
});
