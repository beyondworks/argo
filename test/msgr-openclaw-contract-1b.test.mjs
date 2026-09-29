// 크루 계약 1-b(2026-09-29) — OpenClaw 채널 플러그인이 Hermes 어댑터(integrations/hermes-argo-msgr/adapter.py "1-b")와 같은 동작을 하는지
// 실제 플러그인 코드(src/contract.js·api.js·channel.ts·index.ts)로 돈다. OpenClaw SDK·스케줄러·게이트웨이·서버는 최소 흉내다.
// ① 버전·승인 모드 보고(바뀔 때만) ② "모든 예약 작업 보기" 서버 설정 ③ 전달 상태·방 지정 ④ 에이전트 결재 도구 → 결정 뒤 같은 대화로 재개 →
// 후속 보고, 늦은 셸 결재 결정 알림. 서버 판정은 test/msgr-ext-agent-contract-1b-pg.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import {
  jobDelivery, jobToRow, buildEditPatch, RoutineMirror, ApprovalBridge, agentDecisionPrompt,
  FOLLOWUP_LATE, FOLLOWUP_LOST_APPROVED, FOLLOWUP_LOST_REJECTED, FOLLOWUP_BUSY, FOLLOWUP_FAILED, APPROVAL_TOOL_PARAMETERS,
} from '../integrations/openclaw-argo-msgr/src/contract.js';
import { makeApi } from '../integrations/openclaw-argo-msgr/src/api.js';

const CH = '11111111-1111-4111-8111-111111111111';
const CH2 = '22222222-2222-4222-8222-222222222222';
const T = 'argo_bot_' + 'd'.repeat(48);
const ATT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const argoJob = (o = {}) => ({ id: 'j1', name: '보고', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'agentTurn', message: '정리' },
  delivery: { mode: 'announce', channel: 'argo-msgr', to: CH }, ...o });
// 결과를 보낼 곳이 없는 작업: announce(기본값)인데 채널·대상이 없고 묶인 대화도 없다
const lostJob = (o = {}) => ({ id: 'j2', name: '고아', enabled: true, schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'p' },
  sessionTarget: 'isolated', ...o });
// 의도적으로 메신저 밖(텔레그램)으로 보내는 작업
const tgJob = (o = {}) => ({ id: 'j3', name: '텔레', enabled: true, schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'q' },
  delivery: { mode: 'announce', channel: 'telegram', to: '123', threadId: 7 }, ...o });

function fakeCron(jobs) {
  const calls = [];
  return { jobs, calls,
    list: async () => jobs.map((j) => structuredClone(j)),
    update: async (id, patch) => { calls.push(['update', id, patch]); const j = jobs.find((x) => x.id === id); if (j) Object.assign(j, patch.delivery ? { ...patch, delivery: { ...j.delivery, ...patch.delivery } } : patch); },
    remove: async (id) => { calls.push(['remove', id]); } };
}
function fakeApi(resp = {}) {
  const calls = [];
  const call = (method) => async (params) => { calls.push([method, params]); const r = resp[method]; if (r instanceof Error) throw r; return typeof r === 'function' ? r(params) : r; };
  return { calls, resp, setRoutines: call('setRoutines'), routineEditDone: call('routineEditDone'), requestApproval: call('requestApproval'), reportStatus: call('reportStatus'),
    ackApproval: (id) => call('ackApproval')({ approval_id: id }), expireApproval: (id) => call('expireApproval')({ approval_id: id }),
    sendFollowup: (id, text) => call('sendFollowup')({ approval_id: id, text }) };
}
async function tmpDir(t) { const dir = await mkdtemp(join(tmpdir(), 'argo-oc-1b-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('③ 전달 상태 — 메신저로 안 보내는 작업만 delivery를 단다: 보낼 곳 없음=none, 의도적으로 다른 곳=local', () => {
  assert.equal(jobDelivery(lostJob()), 'none', 'delivery 없음(기본 announce) + 대상·묶인 대화 없음');
  assert.equal(jobDelivery(lostJob({ delivery: { mode: 'announce', channel: 'last' } })), 'none', "channel 'last'인데 대상 없음");
  assert.equal(jobDelivery(lostJob({ delivery: { mode: 'announce' }, sessionKey: 'agent:main:webchat:x' })), 'local', '묶인 대화(sessionKey)로 간다');
  assert.equal(jobDelivery(lostJob({ delivery: { mode: 'none' } })), 'local', '운영자가 고른 "보내지 않음"(실행 기록에 남는다)');
  assert.equal(jobDelivery(lostJob({ sessionTarget: 'main', delivery: undefined })), 'local', 'main 세션 작업(heartbeat 등)은 주 대화에 남는다');
  assert.equal(jobDelivery(lostJob({ sessionTarget: 'current', delivery: { mode: 'announce' } })), 'local', 'current 작업은 묶인 대화에 남는다');
  assert.equal(jobDelivery(lostJob({ sessionTarget: 'session:standup', delivery: { mode: 'announce', channel: 'last' } })), 'local');
  assert.equal(jobDelivery(lostJob({ delivery: { mode: 'webhook', to: 'https://x' } })), 'local');
  assert.equal(jobDelivery(tgJob()), 'local', '다른 채널');
  assert.equal(jobDelivery(lostJob({ delivery: { mode: 'announce', channel: 'last', to: 'telegram:1' } })), 'local', '제공자 접두어 대상');
  // 행: 메신저 전달 작업(channel !== null)에는 delivery 키가 없다(서버도 버린다), mirrorAll로 보이는 작업에만
  assert.equal('delivery' in jobToRow(argoJob(), { channel: CH }).status, false);
  assert.equal(jobToRow(lostJob(), { channel: null, mirrorAll: true }).status.delivery, 'none');
  assert.equal(jobToRow(tgJob(), { channel: null, mirrorAll: true }).status.delivery, 'local');
  const prev = { status_sent: { value: { last_run_at: '2026-09-29T00:00:00.000Z', last_status: 'ok' }, at: new Date().toISOString() } };
  const row = jobToRow(lostJob({ state: { lastRunAtMs: Date.now(), lastRunStatus: 'error' } }), { channel: null, mirrorAll: true, state: prev });
  assert.deepEqual(row.status, { last_run_at: '2026-09-29T00:00:00.000Z', last_status: 'ok', delivery: 'none' }, '10분 안의 상태는 이전 값 + delivery');
  assert.equal(prev.status_sent.value.delivery, undefined, '저장된 이전 값을 고치지 않는다');
});

test('④ 방 지정 patch — channel_id는 이 봇 계정의 그 방으로 announce, 다른 채널의 스레드 id는 지운다, uuid가 아니면 예외', () => {
  assert.deepEqual(buildEditPatch(tgJob(), { channel_id: CH2 }, null, { accountId: 'main' }),
    { delivery: { mode: 'announce', channel: 'argo-msgr', to: CH2, accountId: 'main', threadId: null } });
  assert.deepEqual(buildEditPatch(argoJob(), { channel_id: CH2, enabled: false }, null, { accountId: 'main' }),
    { enabled: false, delivery: { mode: 'announce', channel: 'argo-msgr', to: CH2, accountId: 'main' } });
  assert.throws(() => buildEditPatch(argoJob(), { channel_id: 'general' }, null, { accountId: 'main' }), /channel_id must be a channel id/);
});

test('④ 방 지정 반영 — 메신저 전달 작업은 대상 변경, 보낼 곳 없는 작업은 방 지정만 허용, 의도적 외부 작업·다른 필드는 not_editable, 잘못된 id는 failed', async (t) => {
  const dir = await tmpDir(t);
  const cron = fakeCron([argoJob(), lostJob(), tgJob()]);
  const api = fakeApi({ setRoutines: (p) => ({ total: (p.rows ?? []).length }), routineEditDone: true });
  const m = new RoutineMirror({ api, cronAccess: async () => ({ state: 'ready', cron }), accountId: 'main', stateFile: join(dir, 'r.json'), tz: () => null, mirrorAll: () => false,
    now: () => Date.parse('2026-09-29T09:30:00Z') });
  const done = () => api.calls.filter((x) => x[0] === 'routineEditDone').at(-1)[1];
  const at = '2026-09-29T10:00:00Z';
  await m.applyEdit({ edit_id: 'e1', ext_id: 'j1', op: 'update', patch: { channel_id: CH2 }, created_at: at });
  assert.deepEqual(cron.calls.at(-1), ['update', 'j1', { delivery: { mode: 'announce', channel: 'argo-msgr', to: CH2, accountId: 'main' } }]);
  assert.deepEqual(done(), { edit_id: 'e1', status: 'applied', error: null });
  assert.equal(api.calls.at(-1)[1].rows.find((r) => r.ext_id === 'j1').channel_id, CH2, '반영 뒤 바로 미러 — 새 방');
  await m.applyEdit({ edit_id: 'e2', ext_id: 'j2', op: 'update', patch: { channel_id: CH }, created_at: at });
  assert.deepEqual(cron.calls.at(-1), ['update', 'j2', { delivery: { mode: 'announce', channel: 'argo-msgr', to: CH, accountId: 'main' } }]);
  assert.equal(done().status, 'applied');
  const row = api.calls.at(-1)[1].rows.find((r) => r.ext_id === 'j2');
  assert.equal(row.editable, true, '방을 고른 작업은 이제 메신저 전달 작업(고칠 수 있다)'); assert.equal('delivery' in row.status, false);
  const n = cron.calls.length;
  await m.applyEdit({ edit_id: 'e3', ext_id: 'j3', op: 'update', patch: { channel_id: CH }, created_at: at });
  assert.deepEqual(done(), { edit_id: 'e3', status: 'failed', error: 'not_editable' }, '의도적으로 텔레그램에 보내는 작업(local)은 못 바꾼다');
  cron.jobs.push(lostJob({ id: 'j4' }));
  await m.applyEdit({ edit_id: 'e4', ext_id: 'j4', op: 'update', patch: { channel_id: CH, enabled: false }, created_at: at });
  assert.deepEqual(done(), { edit_id: 'e4', status: 'failed', error: 'not_editable' }, '보낼 곳 없는 작업은 방 지정만');
  await m.applyEdit({ edit_id: 'e5', ext_id: 'j4', op: 'delete', patch: {}, created_at: at });
  assert.equal(done().error, 'not_editable');
  assert.equal(cron.calls.length, n, '거절된 편집은 스케줄러를 건드리지 않는다');
  await m.applyEdit({ edit_id: 'e6', ext_id: 'j1', op: 'update', patch: { channel_id: 'not-a-uuid' }, created_at: at });
  assert.deepEqual(done(), { edit_id: 'e6', status: 'failed', error: 'channel_id must be a channel id' });
  assert.equal(cron.calls.length, n);
});

test('①② 상태 보고 — 바뀔 때만 reportStatus, 서버가 mirror_all을 켜면 즉시 강제 미러 + 반영값 재보고, config 이벤트로 끄면 되돌린다, 환경 변수는 OR', async (t) => {
  const dir = await tmpDir(t);
  const cron = fakeCron([argoJob(), lostJob(), tgJob()]);
  let serverMirror = false, mode = 'full', env = false;
  const api = fakeApi({ setRoutines: (p) => ({ total: (p.rows ?? []).length }), reportStatus: () => ({ mirror_all: serverMirror }) });
  const m = new RoutineMirror({ api, cronAccess: async () => ({ state: 'ready', cron }), accountId: 'main', stateFile: join(dir, 'r.json'), tz: () => null,
    mirrorAll: () => env, version: () => '0.3.0', approvalMode: () => mode });
  const names = () => api.calls.map((x) => x[0]);
  assert.equal(await m.reportStatus(), 'sent');
  assert.deepEqual(api.calls, [['reportStatus', { version: '0.3.0', approval_mode: 'full', mirror_all_applied: false }]]);
  await m.sync();
  assert.deepEqual(api.calls.at(-1)[1].rows.map((r) => r.ext_id), ['j1', 'j2'], '기본은 메신저 전달 작업 + 보낼 곳 없는 작업(검수 4)');
  const orphan = api.calls.at(-1)[1].rows.find((r) => r.ext_id === 'j2');
  assert.deepEqual([orphan.editable, orphan.channel_id, orphan.status.delivery], [false, null, 'none'], '보낼 곳 없는 작업은 읽기 전용(방 지정만 받는다)');
  const idle = api.calls.length;
  for (let i = 0; i < 5; i++) { assert.equal(await m.reportStatus(), 'unchanged'); await m.sync(); }
  assert.equal(api.calls.length, idle, '유휴 상태: 보고·미러 호출 0');
  mode = 'ask';
  await m.reportStatus();
  assert.deepEqual(api.calls.at(-1), ['reportStatus', { version: '0.3.0', approval_mode: 'ask', mirror_all_applied: false }], '승인 모드가 바뀌면 보고');
  // 소유자가 메신저에서 "모든 예약 작업 보기"를 켰다 → 다음 보고 응답에서 반영(강제 미러 → 반영값 재보고)
  serverMirror = true; mode = 'allowlist';
  const before = api.calls.length;
  await m.reportStatus();
  assert.deepEqual(names().slice(before), ['reportStatus', 'setRoutines', 'reportStatus']);
  const rows = api.calls.at(-2)[1].rows;
  assert.deepEqual(rows.map((r) => [r.ext_id, r.editable, r.status.delivery]), [['j1', true, undefined], ['j2', false, 'none'], ['j3', false, 'local']]);
  assert.deepEqual(api.calls.at(-1)[1], { version: '0.3.0', approval_mode: 'allowlist', mirror_all_applied: true });
  // config 이벤트(소유자가 끔) → 강제 미러(메신저 전달 작업 + 보낼 곳 없는 작업, local은 빠진다) → 재보고
  serverMirror = false;
  const b2 = api.calls.length;
  assert.equal(await m.applyMirrorAll(false), true);
  assert.deepEqual(names().slice(b2), ['setRoutines', 'reportStatus']);
  assert.deepEqual(api.calls.at(-2)[1].rows.map((r) => r.ext_id), ['j1', 'j2']);
  assert.equal(api.calls.at(-1)[1].mirror_all_applied, false);
  assert.equal(await m.applyMirrorAll(false), false, '같은 값의 config 이벤트는 아무것도 안 한다');
  // 환경 변수(ARGO_MSGR_MIRROR_ALL=1) 방식은 서버 설정과 OR — 반영값 보고는 서버 설정만
  env = true;
  await m.sync(true);
  assert.deepEqual(api.calls.at(-1)[1].rows.map((r) => r.ext_id), ['j1', 'j2', 'j3']);
  // 보고 실패는 예외(호출자가 기록) — 다음 주기에 같은 값을 다시 보낸다
  api.resp.reportStatus = new Error('offline'); mode = 'deny';
  await assert.rejects(m.reportStatus(), /offline/);
  api.resp.reportStatus = () => ({ mirror_all: false });
  assert.equal(await m.reportStatus(), 'sent');
});

test('④ 에이전트 결재 — 도구는 그 세션의 실행 시도로 카드를 올리고 재개 정보를 0600 파일에 남긴다, 결정되면 ack(선점) → 같은 대화로 재개 → 답을 후속 보고로 한 번', async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, 'agent-approvals-x.json');
  const api = fakeApi({ requestApproval: { id: 'row', message_id: 88, status: 'pending', risk: 'high' }, ackApproval: { claimed: true }, sendFollowup: { message_id: 101 } });
  const resumed = [], spawned = [];
  const mk = () => new ApprovalBridge({ api, resolve: async () => {}, agentStateFile: file, spawn: (fn) => { spawned.push(fn()); },
    resume: async (p) => { resumed.push(p); return '집행했습니다 — 영수증 #1'; } });
  const b = mk();
  const src = { message_id: 7, execution_attempt: ATT, text: '광고비 집행해 줘', thread_root: 7, delegated: true, chat: { id: CH, kind: 'dm', name: 'DM' }, from: { id: 'u1', name: '유건' } };
  b.track({ message_id: 5, execution_attempt: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', chat: { id: CH } }, 's:other');
  b.track(src, 'S:ARGO-DM:CH:7');
  await assert.rejects(b.requestAgent({ sessionKey: 's:argo-dm:ch:7', chatId: CH, requesterSenderId: 'u1', title: '  ' }), /title is required/);
  const out = await b.requestAgent({ sessionKey: 's:argo-dm:ch:7', chatId: CH, requesterSenderId: 'u1', title: '광고비 40만원 집행', reason: '이번 주 캠페인' });
  assert.match(out.approval_id, /^ag-[0-9a-f]{24}$/); assert.equal(out.card_message_id, 88); assert.equal(out.status, 'pending');
  assert.deepEqual(api.calls.at(-1), ['requestApproval', { kind: 'agent', execution_attempt: ATT, approval_id: out.approval_id, title: '광고비 40만원 집행', reason: '이번 주 캠페인' }],
    '세션 키가 같은 원문(message 7)의 실행 시도 — 같은 채팅의 더 오래된 다른 세션(5)이 아니다');
  const saved = await readFile(file, 'utf8');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(saved.includes('광고비 집행해 줘'), false, '원문 본문은 저장하지 않는다'); assert.equal(saved.includes('argo_bot_'), false);
  assert.equal(JSON.parse(saved)[out.approval_id].sessionKey, 'S:ARGO-DM:CH:7', '재개는 원문을 처리한 dispatch 세션 키로');
  // 재시작: 새 다리가 파일에서 재개 정보를 읽는다
  const b2 = mk();
  const ev = { event: 'approval_decided', agent: true, approval_id: out.approval_id, status: 'approved', resume: true, decided_by_name: '김결재', action: '광고비 40만원 집행' };
  assert.equal(await b2.onDecided(ev), 'resumed');
  await Promise.all(spawned);
  assert.deepEqual(api.calls.slice(-2).map((x) => x[0]), ['ackApproval', 'sendFollowup'], 'ack(선점)가 먼저');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].info.sessionKey, 'S:ARGO-DM:CH:7'); assert.deepEqual(resumed[0].info.source.chat, { id: CH, kind: 'dm', name: 'DM' });
  assert.equal(resumed[0].text, agentDecisionPrompt('approved', '광고비 40만원 집행', '김결재'));
  assert.match(resumed[0].text, /APPROVED by 김결재\. Carry out the approved work now and report the result/);
  assert.deepEqual(api.calls.at(-1), ['sendFollowup', { approval_id: out.approval_id, text: '집행했습니다 — 영수증 #1' }]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {}, '결정되면 재개 정보를 지운다');
  // 같은 결정 이벤트가 다시 와도(서버 재전송) 선점 못 하면 재개 안 함
  api.resp.ackApproval = { claimed: false };
  assert.equal(await b2.onDecided(ev), 'skipped'); assert.equal(resumed.length, 1);
  // 반려 → "하지 말고 짧게" 재개
  api.resp.ackApproval = { claimed: true };
  const r2 = await b2.requestAgent({ sessionKey: 'S:ARGO-DM:CH:7', chatId: CH, requesterSenderId: 'u1', title: '메일 발송' }).catch((e) => e);
  assert.match(String(r2?.message), /No active Argo Messenger request/, '원문 처리 중이 아니면 도구 오류(재시작한 다리는 추적 중인 원문이 없다)');
  b2.track(src, 'S:ARGO-DM:CH:7');
  const nCalls = api.calls.length;
  await assert.rejects(b2.requestAgent({ sessionKey: 'nope', chatId: CH, requesterSenderId: 'u1', title: '메일 발송' }), /No active Argo Messenger request/,
    '세션 키가 안 맞으면 거절 — "그 채팅의 최근 원문" 대체는 없다(검수 H2)');
  assert.equal(api.calls.length, nCalls, '거절하면 카드를 올리지 않는다');
  await assert.rejects(b2.requestAgent({ sessionKey: 'S:ARGO-DM:CH:7', title: '요청자 없음' }), /No active Argo Messenger request/, 'DM이어도 요청자 없는 실행(묶인 예약 작업 등)은 거절(재검수 LOW-4)');
  const r3 = await b2.requestAgent({ sessionKey: 'S:ARGO-DM:CH:7', requesterSenderId: 'u1', title: '메일 발송' });
  assert.equal(api.calls.at(-1)[1].execution_attempt, ATT);
  await b2.onDecided({ ...ev, approval_id: r3.approval_id, status: 'rejected', resume: false, decided_by_name: null });
  await Promise.all(spawned);
  assert.match(resumed.at(-1).text, /"메일 발송" was REJECTED by the approver\. Do not carry out that work/);
  // 승인됐지만 서버 재판정 실패(resume false) → 아무것도 안 한다(후속 보고도 서버가 거절)
  const r4 = await b2.requestAgent({ sessionKey: 'S:ARGO-DM:CH:7', chatId: CH, requesterSenderId: 'u1', title: '삭제' });
  const calls = api.calls.length;
  assert.equal(await b2.onDecided({ ...ev, approval_id: r4.approval_id, resume: false, reason: 'ai_consent' }), 'noop');
  assert.deepEqual(api.calls.slice(calls).map((x) => x[0]), ['ackApproval']); assert.equal(resumed.length, 2);
  // 재개 정보를 잃었으면(다른 기기에서 올렸거나 30일 지남) 사람에게 알리고 끝낸다 — Hermes 문구
  assert.equal(await b2.onDecided({ ...ev, approval_id: 'ag-unknown1' }), 'lost');
  assert.deepEqual(api.calls.at(-1), ['sendFollowup', { approval_id: 'ag-unknown1', text: FOLLOWUP_LOST_APPROVED }]);
  assert.equal(await b2.onDecided({ ...ev, approval_id: 'ag-unknown2', status: 'rejected', resume: false }), 'lost');
  assert.equal(api.calls.at(-1)[1].text, FOLLOWUP_LOST_REJECTED);
  assert.equal(FOLLOWUP_LOST_APPROVED, '결재가 승인됐습니다. 이어서 진행하려면 이 대화에서 다시 말씀해 주세요.\n/ Approved — ask again here to continue.');
  // 후속 보고는 결재당 한 번
  const c2 = api.calls.length;
  await b2.followup('ag-unknown1', '또'); assert.equal(api.calls.length, c2);
});

test('④ 재개 정보 파일 — 결정이 안 온 채 30일 지난 항목은 저장할 때 지운다(쌓이기만 하지 않게)', async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, 'agent-approvals-y.json');
  let clock = Date.parse('2026-09-29T00:00:00Z');
  const api = fakeApi({ requestApproval: { message_id: 1 } });
  const b = new ApprovalBridge({ api, resolve: async () => {}, agentStateFile: file, now: () => clock });
  b.track({ message_id: 1, execution_attempt: ATT, chat: { id: CH }, from: { id: 'u1' } }, 's');
  const old = await b.requestAgent({ sessionKey: 's', requesterSenderId: 'u1', title: '옛 결재' });
  clock += 31 * 24 * 3_600_000;
  const fresh = await b.requestAgent({ sessionKey: 's', requesterSenderId: 'u1', title: '새 결재' });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))), [fresh.approval_id]);
  assert.notEqual(old.approval_id, fresh.approval_id);
});

test('⑦ 늦은 셸 결재 결정 — OpenClaw가 기다리기를 멈췄으면(대기 정보 없음·resolve 실패) 승인만 후속 보고로 알린다, 반려·선점 실패는 조용히', async () => {
  const api = fakeApi({ requestApproval: { message_id: 77 }, ackApproval: { claimed: true }, sendFollowup: { message_id: 5 } });
  let failResolve = false;
  const logs = [];
  const b = new ApprovalBridge({ api, log: (s) => logs.push(s), resolve: async () => { if (failResolve) { const e = new Error('unknown or expired approval id'); throw e; } } });
  b.track({ message_id: 9, execution_attempt: ATT, chat: { id: CH } });
  // 재시작 뒤(대기 정보 없음) 승인 → 늦은 결정 알림
  assert.equal(await b.onDecided({ event: 'approval_decided', approval_id: 'oc-lost', status: 'approved', resume: true, shell: true }), 'late');
  assert.deepEqual(api.calls.slice(-2), [['ackApproval', { approval_id: 'oc-lost' }], ['sendFollowup', { approval_id: 'oc-lost', text: FOLLOWUP_LATE }]]);
  assert.match(FOLLOWUP_LATE, /^결정이 늦게 도착해 명령은 실행되지 않았습니다\(에이전트의 승인 대기 시간이 지났습니다\)\. 필요하면 다시 요청해 주세요\.\n\/ The decision arrived after the agent stopped waiting, so the command was not run\. Ask again if it is still needed\.$/);
  // OpenClaw 대기는 있었지만 이미 끝났다(resolve가 not found로 실패) → 늦은 결정 알림
  const e = await b.request({ externalId: 'oc-exec-9', kind: 'exec', chatId: CH, command: 'rm -rf /tmp/x' });
  failResolve = true;
  assert.equal(await b.onDecided({ approval_id: e.approvalId, status: 'approved', resume: true }), 'late');
  assert.deepEqual(api.calls.at(-1), ['sendFollowup', { approval_id: e.approvalId, text: FOLLOWUP_LATE }]);
  assert.ok(logs.some((l) => /could not be handed to OpenClaw/.test(l)));
  // 반려가 늦게 온 것은 알릴 게 없다(어차피 실행 안 됨)
  const e2 = await b.request({ externalId: 'oc-exec-10', kind: 'exec', chatId: CH, command: 'x' });
  const n = api.calls.length;
  assert.equal(await b.onDecided({ approval_id: e2.approvalId, status: 'rejected', resume: false }), 'late');
  assert.deepEqual(api.calls.slice(n).map((x) => x[0]), ['ackApproval']);
  // 선점 못 하면(다른 어댑터) 알리지도 않는다
  api.resp.ackApproval = { claimed: false };
  assert.equal(await b.onDecided({ approval_id: 'oc-lost-2', status: 'approved', resume: true }), 'skipped');
  assert.equal(api.calls.at(-1)[0], 'ackApproval');
  // 후속 보고 실패는 삼킨다(수신·답장을 막지 않는다)
  api.resp.ackApproval = { claimed: true }; api.resp.sendFollowup = new Error('403: Forbidden');
  assert.equal(await b.onDecided({ approval_id: 'oc-lost-3', status: 'approved', resume: true }), 'late');
  assert.ok(logs.some((l) => /follow-up for oc-lost-3 failed/.test(l)));
});

test('api — reportStatus·후속 보고는 POST, 후속 보고는 chat_id 없이 approval_id + text(20000자 상한)', async () => {
  const calls = [];
  const api = makeApi({ url: 'https://x.test/functions/v1/msgr-bot', token: T, fetchImpl: async (url, init) => { calls.push([url, init]); return { status: 200, json: async () => ({ ok: true, result: { mirror_all: true, message_id: 3 } }) }; } });
  assert.deepEqual(await api.reportStatus({ version: '0.3.0', approval_mode: 'full', mirror_all_applied: false }), { mirror_all: true, message_id: 3 });
  assert.match(calls[0][0], /\/bot[^/]+\/reportStatus$/); assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { version: '0.3.0', approval_mode: 'full', mirror_all_applied: false });
  await api.sendFollowup('ag-1', 'x'.repeat(20_050));
  assert.match(calls[1][0], /\/sendMessage$/);
  const body = JSON.parse(calls[1][1].body);
  assert.deepEqual(Object.keys(body).sort(), ['approval_id', 'text']); assert.equal(body.text.length, 20_000);
});

// ── 실제 channel.ts·index.ts 배선(SDK는 흉내) ─────────────────────────────────────────────
async function loadPlugin(fixture, { exportInternals = false } = {}) {
  const src = (p) => new URL(`../integrations/openclaw-argo-msgr/${p}`, import.meta.url);
  const rewrite = (code) => {
    for (const line of code.match(/import \{[\s\S]*?\} from "openclaw\/plugin-sdk\/[a-z-]+";/g) ?? []) code = code.replace(line, `const {${line.match(/\{([\s\S]*?)\}/)[1]}}=globalThis.__argoSdkFixture;`);
    return code;
  };
  globalThis.__argoSdkFixture = fixture;
  // 다른 테스트 파일과 모듈 상태(live·runtime)를 나누지 않게 표지 주석을 붙여 새 모듈로 불러온다
  let channel = rewrite(stripTypeScriptTypes(await readFile(src('src/channel.ts'), 'utf8'))) + `\n// 1b-fixture ${Math.random()}`
    + (exportInternals ? '\nexport { handleInbound, resumeAgentTurn };' : '');
  channel = channel.replace('"./api.js"', JSON.stringify(src('src/api.js').href)).replace('"./contract.js"', JSON.stringify(src('src/contract.js').href));
  const channelUrl = 'data:text/javascript;base64,' + Buffer.from(channel).toString('base64');
  const index = rewrite(stripTypeScriptTypes(await readFile(src('index.ts'), 'utf8'))).replace('"./src/channel.js"', JSON.stringify(channelUrl));
  return { channel: await import(channelUrl), entry: (await import('data:text/javascript;base64,' + Buffer.from(index).toString('base64'))).default };
}
const sdk = (extra = {}) => ({
  DEFAULT_ACCOUNT_ID: 'default', createChannelInboundEnvelopeBuilder: () => (o) => o.body, formatTextWithAttachmentLinks: (x) => x, resolveOutboundMediaUrls: () => [],
  createChannelApprovalCapability: (x) => x, createChannelApprovalNativeRuntimeAdapter: (x) => x, CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY: 'approval.native',
  resolveApprovalOverGateway: async () => ({ ok: true }), registerChannelRuntimeContext: () => ({ dispose() {} }),
  defineChannelPluginEntry: (x) => x, buildBaseAccountStatusSnapshot: () => ({}), buildBaseChannelStatusSummary: () => ({}), deleteAccountFromConfigSection: () => ({}), setAccountEnabledInConfigSection: () => ({}),
  ...extra,
});

const LIVE = Symbol.for('argo-msgr.live-accounts'); // channel.ts가 연결된 계정을 두는 프로세스 공용 자리

test('도구 등록 — argo-msgr 대화에서만, 처리 중인 메신저 원문이 있을 때만 보인다(예약 작업 실행에서는 숨김), 그룹은 요청자가 원문 발신자와 같아야 한다(검수 H2)', async (t) => {
  const { channel, entry } = await loadPlugin(sdk());
  t.after(() => { delete globalThis.__argoSdkFixture; globalThis[LIVE]?.delete('default'); });
  const tools = [];
  entry.registerFull({ version: '0.3.0', registerService: () => {}, registerTool: (f, o) => tools.push([f, o]) });
  const [factory, opts] = tools[0];
  assert.deepEqual(opts, { name: 'argo_request_approval' });
  const GS = 'agent:main:argo-msgr:group:' + CH; // 실제 OpenClaw 2026.9.6이 도구 문맥에 준 세션 키 모양(격리 실측)
  const ctx = (o = {}) => ({ messageChannel: 'argo-msgr', sessionKey: GS, deliveryContext: { channel: 'argo-msgr', to: `argo-msgr:${CH}`, accountId: 'default' }, ...o });
  assert.equal(factory({ messageChannel: 'telegram', sessionKey: 's' }), null);
  assert.equal(factory({}), null, '채널이 없는 실행(CLI)에서도 숨긴다');
  assert.equal(factory(ctx({ requesterSenderId: 'u1' })), null, '계정이 연결돼 있지 않으면 숨긴다');
  const api = fakeApi({ requestApproval: { message_id: 61, status: 'pending' } });
  const bridge = new ApprovalBridge({ api, resolve: async () => {} });
  globalThis[LIVE].set('default', { accountId: 'default', bridge, mirror: {}, log: () => {} });
  assert.equal(factory(ctx({ requesterSenderId: 'u1' })), null, '처리 중인 메신저 원문이 없는 실행(예약 작업 등)에서는 만들지 않는다');
  assert.equal(factory(ctx({ sessionKey: 'agent:main:cron:job-1' })), null);
  const A2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  bridge.track({ message_id: 10, execution_attempt: ATT, chat: { id: CH, kind: 'public' }, from: { id: 'u1' } }, GS);
  bridge.track({ message_id: 11, execution_attempt: A2, chat: { id: CH, kind: 'public' }, from: { id: 'u2' } }, GS);
  const tool = factory(ctx({ requesterSenderId: 'u1' }));
  assert.equal(tool.name, 'argo_request_approval'); assert.equal(tool.parameters, APPROVAL_TOOL_PARAMETERS);
  assert.deepEqual(tool.parameters.required, ['title']); assert.deepEqual(Object.keys(tool.parameters.properties), ['title', 'reason']);
  assert.equal(tool.catalogMode, 'direct-only');
  assert.match(tool.description, /end your turn — do not do the work until approved/);
  const r = await tool.execute('call-1', { title: '예산 집행' });
  assert.equal(api.calls.at(-1)[1].execution_attempt, ATT, '같은 그룹 세션의 더 최근 글(u2, 11)이 아니라 요청자 u1의 원문(10)');
  assert.equal(JSON.parse(r.content[0].text).ok, true);
  const n = api.calls.length;
  await assert.rejects(factory(ctx({ requesterSenderId: 'u3' })).execute('c', { title: 'x' }), /No active Argo Messenger request/, '요청자가 원문 발신자가 아니면 거절');
  await assert.rejects(factory(ctx()).execute('c', { title: 'x' }), /No active Argo Messenger request/, '그룹은 요청자 없이 정하지 않는다');
  bridge.track({ message_id: 12, execution_attempt: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', chat: { id: CH, kind: 'public' }, from: { id: 'u1' } }, GS);
  await assert.rejects(factory(ctx({ requesterSenderId: 'u1' })).execute('c', { title: 'x' }), /No active Argo Messenger request/, '같은 요청자의 원문이 둘이면 하나로 못 정한다');
  bridge.track({ message_id: 20, execution_attempt: A2, chat: { id: CH2, kind: 'dm' }, from: { id: 'u1' } }, 's:argo-dm:other:conversation');
  assert.equal(factory(ctx({ requesterSenderId: 'u1', sessionKey: 'agent:main:argo-msgr:group:' + CH2 })), null, '다른 세션(다른 대화)의 원문으로 새지 않는다 — 같은 발신자의 DM 원문이 있어도');
  await assert.rejects(bridge.requestAgent({ sessionKey: 'agent:main:argo-msgr:group:' + CH2, requesterSenderId: 'u1', title: 'x' }), /No active Argo Messenger request/);
  assert.equal(api.calls.length, n, '거절하면 카드를 올리지 않는다');
  const manifest = JSON.parse(await readFile(new URL('../integrations/openclaw-argo-msgr/openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.contracts, { tools: ['argo_request_approval'] }, '매니페스트 contracts.tools 선언(없으면 OpenClaw가 등록을 거절한다)');
  assert.equal(manifest.toolMetadata?.argo_request_approval?.optional, undefined, '선택 도구가 아니다');
  assert.equal(JSON.parse(await readFile(new URL('../integrations/openclaw-argo-msgr/package.json', import.meta.url), 'utf8')).version, '0.3.0');
  // 승인 모드: 살아 있는 설정(runtime.config.current) → 계정 시작 때 설정 → 없으면 OpenClaw 기본값 full.
  // 이 계정에 묶인 에이전트의 agents.entries.<id>.tools.exec.mode가 있으면 그 값(검수 L2)
  channel.setArgoRuntime({ config: { current: () => ({ tools: { exec: { mode: 'allowlist' } } }) } });
  assert.equal(channel.execApprovalMode({ tools: { exec: { mode: 'ask' } } }), 'allowlist');
  channel.setArgoRuntime({ config: {} });
  assert.equal(channel.execApprovalMode({ tools: { exec: { mode: 'ask' } } }), 'ask');
  assert.equal(channel.execApprovalMode({}), 'full');
  const multi = { tools: { exec: { mode: 'ask' } }, agents: { entries: { main: { tools: { exec: { mode: 'deny' } } }, ops: { tools: { exec: { mode: 'full' } } } } },
    bindings: [{ match: { channel: 'argo-msgr', accountId: 'work' }, agentId: 'ops' }, { match: { channel: 'argo-msgr', peer: { kind: 'group', id: CH } }, agentId: 'main' }] };
  assert.equal(channel.execApprovalMode(multi, 'work'), 'full', '계정에 묶인 에이전트(ops)의 값');
  assert.equal(channel.execApprovalMode(multi, 'default'), 'deny', '묶음이 없으면 main 에이전트의 값(대화 단위 묶음은 보지 않는다)');
  assert.equal(channel.execApprovalMode({ ...multi, agents: {} }, 'work'), 'ask', '에이전트 값이 없으면 전체 설정');
});

test('배선 — 연결 뒤 버전·승인 모드 보고, 턴 안 결재 도구 → 카드 → 결정 이벤트 → 같은 세션으로 재개 턴 → 후속 보고, config 이벤트 → 강제 미러·재보고', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-oc-1b-wiring-'));
  const prevFetch = globalThis.fetch, prevOutbox = process.env.ARGO_MSGR_OUTBOX_DIR;
  t.after(async () => { globalThis.fetch = prevFetch; delete globalThis.__argoSdkFixture; if (prevOutbox === undefined) delete process.env.ARGO_MSGR_OUTBOX_DIR; else process.env.ARGO_MSGR_OUTBOX_DIR = prevOutbox; await rm(dir, { recursive: true, force: true }); });
  process.env.ARGO_MSGR_OUTBOX_DIR = join(dir, 'outbox');
  const { channel, entry } = await loadPlugin(sdk());
  const services = [], tools = [];
  entry.registerFull({ version: '0.3.0', registerService: (svc) => services.push(svc), registerTool: (f, o) => tools.push([f, o]) });
  const cron = fakeCron([argoJob(), lostJob()]);
  await services[0].start({ getCron: () => cron });
  // OpenClaw는 도구 팩토리를 계정을 띄운 것과 다른 플러그인 모듈 사본에서 부른다(2026.9.6 격리 실측) — 두 번째 사본의 팩토리로 부른다
  const other = await loadPlugin(sdk());
  const otherTools = [];
  other.entry.registerFull({ version: '0.3.0', registerService: () => {}, registerTool: (f, o) => otherTools.push([f, o]) });
  assert.notEqual(other.channel, channel, '서로 다른 모듈 사본');
  const toolFactory = otherTools[0][0];

  const calls = [], logs = [], dispatches = [], toolResults = [], resumeCards = [];
  let polls = 0, serverMirror = false, cardId = null, agentFileWhilePending = null;
  const settle = () => new Promise((r) => setTimeout(r, 5));
  globalThis.fetch = async (url, init) => {
    const method = url.split('/').pop().split('?')[0];
    const body = init?.body ? JSON.parse(init.body) : Object.fromEntries(new URL(url).searchParams);
    calls.push([method, body]);
    const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (method === 'getMe') return ok({ first_name: 'Claw', kind: 'openclaw', org: { name: 'Org' } });
    if (method === 'reportStatus') return ok({ mirror_all: serverMirror });
    if (method === 'setRoutines') return ok({ total: (body.rows ?? []).length });
    if (method === 'requestApproval') { cardId ??= body.approval_id; return ok({ id: 'row', message_id: 88, status: 'pending', risk: 'high' }); }
    if (method === 'ackApproval') return ok({ claimed: true, status: 'approved' });
    if (method === 'sendMessage') return ok({ message_id: body.approval_id ? 101 : 99 });
    if (method === 'getUpdates') {
      polls++;
      if (logs.some((l) => /failed/.test(l))) return { status: 401, json: async () => ({ ok: false, error_code: 401, description: 'stop: failure logged' }) };
      if (polls === 1) return ok([{ update_id: 7, message: { message_id: 7, execution_attempt: ATT, delivery_role: 'to', text: '광고비 집행해 줘', thread_root: 7, delegated: true,
        chat: { id: CH, kind: 'dm', name: 'DM' }, from: { id: 'u1', name: '유건' }, peers: [] } }]);
      const answered = calls.some((x) => x[0] === 'sendMessage' && x[1].chat_id);
      if (cardId && answered && !calls.some((x) => x[0] === 'ackApproval')) {
        agentFileWhilePending = await readdir(dir).then((f) => f.filter((x) => x.startsWith('agent-approvals-')));
        serverMirror = true; // 소유자가 메신저에서 "모든 예약 작업 보기"를 켰다
        return ok([{ event: 'config', mirror_all: true },
          { event: 'approval_decided', agent: true, approval_id: cardId, status: 'approved', resume: true, decided_by_name: '김결재', action: '광고비 40만원 집행' }]);
      }
      if (calls.some((x) => x[0] === 'sendMessage' && x[1].approval_id)) return { status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) };
      await settle();
      return ok([]);
    }
    return { status: 404, json: async () => ({ ok: false, error_code: 404, description: method }) };
  };
  channel.setArgoRuntime({ config: { current: () => ({ tools: { exec: { mode: 'ask' } } }) }, channel: { activity: { record() {} },
    routing: { resolveAgentRoute: () => ({ agentId: 'a', sessionKey: 's', accountId: 'default' }) },
    inbound: { buildContext: (p) => ({ SessionKey: p.route.dispatchSessionKey, BodyForAgent: p.message.bodyForAgent, MessageSid: p.messageId, From: p.from }),
      dispatch: async ({ route, ctxPayload, delivery }) => {
        dispatches.push({ sessionKey: route.sessionKey, body: ctxPayload.BodyForAgent, sid: ctxPayload.MessageSid, from: ctxPayload.From });
        if (dispatches.length === 1) {
          assert.equal(toolFactory({ messageChannel: 'argo-msgr', sessionKey: 'agent:main:cron:job-1', deliveryContext: { channel: 'argo-msgr', to: `argo-msgr:${CH}`, accountId: 'default' } }), null,
            '처리 중인 원문이 없는 실행(예약 작업)에는 도구를 만들지 않는다(검수 H2)');
          // 모델이 결재 도구를 부른다(OpenClaw가 이 턴의 도구 문맥으로 팩토리를 부른다)
          const tool = toolFactory({ messageChannel: 'argo-msgr', sessionKey: route.sessionKey, requesterSenderId: 'u1', deliveryContext: { channel: 'argo-msgr', to: `argo-msgr:${CH}`, accountId: 'default' } });
          toolResults.push(await tool.execute('call-1', { title: '광고비 40만원 집행', reason: '이번 주 캠페인' }));
          await delivery.deliver({ text: '결재를 요청했습니다. 승인되면 이어서 진행할게요.\nMSGR: done' }, { kind: 'final' });
        } else {
          // 재개 턴(실행 행 없음) 안의 위험 명령 승인과 새 결재 → 승인된 부모 결재(parent_approval_id)의 원문에 붙는다(검수 3)
          const rt = channel.argoMsgrPlugin.approvalCapability.nativeRuntime;
          const req = { id: 'oc-exec-in-resume', request: { command: 'rm -rf /tmp/y', sessionKey: route.sessionKey, turnSourceChannel: 'argo-msgr', turnSourceTo: `argo-msgr:${CH}`, turnSourceAccountId: 'default' } };
          resumeCards.push(await rt.transport.deliverPending({ accountId: 'default', preparedTarget: { chatId: CH }, request: req, approvalKind: 'exec',
            pendingPayload: rt.presentation.buildPendingPayload({ request: req, approvalKind: 'exec', view: { commandText: 'rm -rf /tmp/y' } }) }));
          const again = toolFactory({ messageChannel: 'argo-msgr', sessionKey: route.sessionKey, requesterSenderId: 'u1', deliveryContext: { channel: 'argo-msgr', to: `argo-msgr:${CH}`, accountId: 'default' } });
          toolResults.push(await again.execute('call-2', { title: '추가 예산 10만원' }));
          await delivery.deliver({ text: '집행했습니다 — 영수증 #1\nMSGR: done' }, { kind: 'final' });
        }
      } } } });
  const account = { accountId: 'default', enabled: true, configured: true, url: 'https://argo.test', token: T, config: {} };
  await assert.rejects(channel.argoMsgrPlugin.gateway.startAccount({ account, accountId: 'default', cfg: {}, abortSignal: new AbortController().signal,
    channelRuntime: { runtimeContexts: {} }, log: { info() {}, warn: (x) => logs.push(x) }, setStatus() {} }), /token rejected/);
  assert.deepEqual(logs.filter((l) => /failed/.test(l)), [], '턴·이벤트 처리 중 실패 없음');

  // ① 연결 직후 보고 — 버전은 registerFull의 api.version, 승인 모드는 살아 있는 설정
  const reports = calls.filter((x) => x[0] === 'reportStatus').map((x) => x[1]);
  assert.deepEqual(reports[0], { version: '0.3.0', approval_mode: 'ask', mirror_all_applied: false });
  // ② config 이벤트 → 강제 미러(보낼 곳 없는 작업도 읽기 전용 + delivery none) → 반영값 재보고
  const lastRows = calls.filter((x) => x[0] === 'setRoutines').at(-1)[1].rows;
  assert.deepEqual(lastRows.map((r) => [r.ext_id, r.editable, r.status.delivery]), [['j1', true, undefined], ['j2', false, 'none']]);
  assert.deepEqual(reports.at(-1), { version: '0.3.0', approval_mode: 'ask', mirror_all_applied: true });
  assert.equal(reports.length, 2, '바뀔 때만 보고(연결 1 + 반영 1)');
  // ④ 도구 → 카드
  const card = calls.find((x) => x[0] === 'requestApproval')[1];
  assert.deepEqual(card, { kind: 'agent', execution_attempt: ATT, approval_id: cardId, title: '광고비 40만원 집행', reason: '이번 주 캠페인' });
  const result = JSON.parse(toolResults[0].content[0].text);
  assert.equal(result.ok, true); assert.equal(result.approval_id, cardId); assert.equal(result.card_message_id, 88);
  assert.match(result.next, /Tell the person you requested approval and end this turn/);
  assert.equal(agentFileWhilePending.length, 1, '결정 전에는 재개 정보 파일이 있다(재시작 뒤 재개)');
  // 원래 턴의 답은 일반 답글(실행 시도로 마감)
  const answer = calls.find((x) => x[0] === 'sendMessage' && x[1].chat_id)[1];
  assert.equal(answer.chat_id, CH); assert.equal(answer.reply_to_message_id, 7); assert.equal(answer.execution_attempt, ATT);
  // 결정 → ack → 같은 세션(DM 스레드 세션)으로 재개 턴 → 그 턴의 답은 후속 보고(한 번, MSGR 표지 없이)
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].sessionKey, `s:argo-dm:${CH}:7`);
  assert.equal(dispatches[1].sessionKey, dispatches[0].sessionKey, '결재를 요청한 바로 그 대화로 재개');
  assert.equal(dispatches[1].sid, `apf:${cardId}`); assert.equal(dispatches[1].from, 'argo-msgr:u1', '원래 요청자 이름으로');
  assert.match(dispatches[1].body, /^\[Argo Messenger — approval decided\] Your approval request "광고비 40만원 집행" was APPROVED by 김결재\./);
  const order = calls.map((x) => (x[0] === 'sendMessage' ? (x[1].approval_id ? 'followup' : 'answer') : x[0])).filter((m) => ['requestApproval', 'answer', 'ackApproval', 'followup'].includes(m));
  assert.deepEqual(order, ['requestApproval', 'answer', 'ackApproval', 'requestApproval', 'requestApproval', 'followup']);
  // 재개 턴 안의 카드: 실행 시도 대신 부모 결재
  const [execCard, childCard] = calls.filter((x) => x[0] === 'requestApproval').slice(1).map((x) => x[1]);
  assert.deepEqual(execCard, { parent_approval_id: cardId, approval_id: execCard.approval_id, command: 'rm -rf /tmp/y', reason: 'OpenClaw exec approval' });
  assert.match(execCard.approval_id, /^oc-[0-9a-f]{24}$/); assert.equal(resumeCards[0].card, '88');
  assert.deepEqual(childCard, { kind: 'agent', parent_approval_id: cardId, approval_id: childCard.approval_id, title: '추가 예산 10만원', reason: null });
  assert.equal(JSON.parse(toolResults[1].content[0].text).approval_id, childCard.approval_id);
  const followups = calls.filter((x) => x[0] === 'sendMessage' && x[1].approval_id).map((x) => x[1]);
  assert.deepEqual(followups, [{ approval_id: cardId, text: '집행했습니다 — 영수증 #1' }]);
  const files = (await readdir(dir)).filter((x) => x.startsWith('agent-approvals-'));
  const left = JSON.parse(await readFile(join(dir, files[0]), 'utf8'));
  assert.deepEqual(Object.keys(left), [childCard.approval_id], '결정된 결재의 재개 정보는 지우고, 재개 턴에서 새로 올린 결재만 남는다');
  assert.equal(left[childCard.approval_id].sessionKey, dispatches[0].sessionKey, '새 결재도 같은 대화로 재개된다');
  assert.deepEqual(left[childCard.approval_id].source.chat, { id: CH, kind: 'dm', name: 'DM' });
  // DB 부하: 폴링 횟수는 메시지·이벤트 흐름만큼 — 새 동작이 폴을 더 만들지 않는다(보고·미러는 폴과 별개로 바뀔 때만)
  assert.equal(calls.filter((x) => x[0] === 'getUpdates')[0][1].events, '1');
  await services[0].stop();
});

// ── 분리 검수 반영(H1·H2·3·M1·L1·L3·L4) ─────────────────────────────────────────────
const tick = () => new Promise((r) => setImmediate(r));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
// 조건이 될 때까지(부하가 걸린 기계에서도 흔들리지 않게 시간 대신 조건으로 기다린다, 상한 5초)
const until = async (cond, ms = 5_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2)); };

test('3 재개 턴의 카드 — 실행 행이 없으니 셸 승인·새 결재는 parent_approval_id(재개 중인 부모 결재)로, 후속 보고를 올리면 부모 연결을 지운다', async (t) => {
  const dir = await tmpDir(t);
  const api = fakeApi({ requestApproval: { message_id: 70, status: 'pending' }, ackApproval: { claimed: true }, sendFollowup: { message_id: 71 } });
  const SK = 'agent:main:argo-msgr:group:' + CH;
  const inside = [], spawned = [];
  let b;
  b = new ApprovalBridge({ api, resolve: async () => {}, agentStateFile: join(dir, 'ag.json'), spawn: (fn) => { spawned.push(fn()); },
    resume: async ({ approvalId, info }) => {
      inside.push(await b.request({ externalId: 'oc-exec-r1', kind: 'exec', chatId: CH, sessionKey: info.sessionKey, command: 'rm -rf /tmp/z', reason: 'why' }));
      inside.push(await b.requestAgent({ sessionKey: SK.toUpperCase(), requesterSenderId: 'u1', title: '추가 결재' }));
      inside.push(await b.request({ externalId: 'oc-exec-other', kind: 'exec', chatId: CH, sessionKey: 'agent:main:argo-msgr:group:' + CH2, command: 'x' }));
      return '다 했습니다';
    } });
  b.track({ message_id: 3, execution_attempt: ATT, chat: { id: CH, kind: 'public', name: 'g' }, from: { id: 'u1', name: '유건' } }, SK);
  const parent = await b.requestAgent({ sessionKey: SK, requesterSenderId: 'u1', title: '부모 결재' });
  b.done({ message_id: 3 });
  assert.equal(await b.request({ externalId: 'oc-before', kind: 'exec', chatId: CH, sessionKey: SK, command: 'x' }), null, '원문도 재개 중인 부모도 없으면 카드를 만들지 않는다');
  assert.equal(await b.onDecided({ agent: true, approval_id: parent.approval_id, status: 'approved', resume: true }), 'resumed');
  await Promise.all(spawned);
  const cards = api.calls.filter((x) => x[0] === 'requestApproval').slice(1).map((x) => x[1]);
  assert.deepEqual(cards[0], { parent_approval_id: parent.approval_id, approval_id: ApprovalBridge.approvalIdFor('oc-exec-r1'), command: 'rm -rf /tmp/z', reason: 'why' });
  assert.deepEqual(cards[1], { kind: 'agent', parent_approval_id: parent.approval_id, approval_id: inside[1].approval_id, title: '추가 결재', reason: null });
  assert.equal(inside[2], null, '다른 세션의 승인은 부모 결재에 붙이지 않는다');
  assert.equal(cards.length, 2);
  assert.deepEqual(api.calls.at(-1), ['sendFollowup', { approval_id: parent.approval_id, text: '다 했습니다' }]);
  assert.equal(b.parents.size, 0, '재개 턴이 끝나고 후속 보고를 올리면 부모 연결이 없다');
  // 후속 보고 자체가 부모 연결을 지운다(재개 턴이 아직 안 끝났어도 — 서버도 후속 보고 뒤에는 부모에 카드를 받지 않는다)
  b.parents.set(SK, { approvalId: 'ag-p', source: {} }); b.parents.set('other-session', { approvalId: 'ag-q', source: {} });
  await b.followup('ag-p', '보고');
  assert.deepEqual([...b.parents.keys()], ['other-session']);
  b.parents.clear();
  await assert.rejects(b.requestAgent({ sessionKey: SK, requesterSenderId: 'u1', title: '또' }), /No active Argo Messenger request/);
  assert.equal(await b.request({ externalId: 'oc-after', kind: 'exec', chatId: CH, sessionKey: SK, command: 'x' }), null);
  // 새 결재의 재개 정보는 부모의 원문(같은 대화)을 잇는다 — 결정되면 같은 세션으로 다시 재개
  const saved = JSON.parse(await readFile(join(dir, 'ag.json'), 'utf8'));
  assert.equal(saved[inside[1].approval_id].sessionKey, SK.toUpperCase()); assert.equal(saved[inside[1].approval_id].source.chat.id, CH);
  // 반려로 재개한 턴에는 부모가 없다(승인된 결재만 카드를 이어 붙일 수 있다)
  let rejectedInside;
  const b2 = new ApprovalBridge({ api, resolve: async () => {}, spawn: (fn) => { spawned.push(fn()); },
    resume: async ({ info }) => { rejectedInside = await b2.request({ externalId: 'oc-rj', kind: 'exec', chatId: CH, sessionKey: info.sessionKey, command: 'x' }); return 'ok'; } });
  b2.track({ message_id: 4, execution_attempt: ATT, chat: { id: CH, kind: 'dm' }, from: { id: 'u1' } }, SK);
  const p2 = await b2.requestAgent({ sessionKey: SK, requesterSenderId: 'u1', title: '반려될 결재' });
  b2.done({ message_id: 4 });
  await b2.onDecided({ agent: true, approval_id: p2.approval_id, status: 'rejected', resume: false });
  await Promise.all(spawned);
  assert.equal(rejectedInside, null);
});

test('H1 바쁜 세션 — 이 플러그인이 띄운 턴이 그 세션에서 돌면 재개는 기다리고(폴 루프는 안 막음), 5분(30×10초)을 넘기면 Hermes 문구로 후속 보고', async () => {
  const api = fakeApi({ ackApproval: { claimed: true }, sendFollowup: { message_id: 1 } });
  const sleeps = [], resumed = [], spawned = [];
  let endBusy = null;
  const b = new ApprovalBridge({ api, resolve: async () => {}, spawn: (fn) => { spawned.push(fn()); },
    sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 3) endBusy?.(); await tick(); },
    resume: async (p) => { resumed.push(p); return '재개 답'; } });
  const info = { sessionKey: 'S1', source: { chat: { id: CH } }, title: 't' };
  b.agents = { 'ag-1': info, 'ag-2': { ...info }, 'ag-3': { ...info, sessionKey: 'S2' } }; b.agentsLoad = Promise.resolve();
  endBusy = b.beginTurn('s1'); // 일반 수신 턴이 진행 중(대소문자 무시)
  assert.equal(await b.onDecided({ agent: true, approval_id: 'ag-1', status: 'approved', resume: true }), 'resumed', '결정 처리는 바로 돌아온다(폴 루프를 막지 않는다)');
  await Promise.all(spawned);
  assert.deepEqual(sleeps, [10_000, 10_000, 10_000], '10초 간격으로 기다리다 턴이 끝나면 재개');
  assert.equal(resumed.length, 1); assert.deepEqual(api.calls.at(-1), ['sendFollowup', { approval_id: 'ag-1', text: '재개 답' }]);
  assert.equal(b.isBusy('S1'), false, '재개 턴도 끝나면 세션이 비었다');
  // 끝나지 않는 턴 → 30번 기다린 뒤 "전달하지 못했습니다" 후속 보고, 재개 턴은 넣지 않는다
  sleeps.length = 0; endBusy = null;
  const stuck = b.beginTurn('S1');
  await b.onDecided({ agent: true, approval_id: 'ag-2', status: 'approved', resume: true });
  await Promise.all(spawned);
  assert.equal(sleeps.length, 30); assert.equal(resumed.length, 1);
  assert.deepEqual(api.calls.at(-1), ['sendFollowup', { approval_id: 'ag-2', text: FOLLOWUP_BUSY }]);
  assert.equal(FOLLOWUP_BUSY, '결재 결과를 에이전트에게 전달하지 못했습니다(대화가 계속 바쁩니다). 이어서 진행하려면 다시 말씀해 주세요.\n/ Could not hand the decision to the agent (conversation stayed busy). Ask again to continue.');
  // 다른 세션은 기다리지 않는다
  sleeps.length = 0;
  await b.onDecided({ agent: true, approval_id: 'ag-3', status: 'approved', resume: true });
  await Promise.all(spawned);
  assert.deepEqual(sleeps, []); assert.equal(resumed.length, 2);
  stuck();
});

test('H1 배선 — 재개 턴이 도는 동안 같은 세션에 온 새 글은 그 턴이 끝난 뒤 넣고(답이 후속 보고로 새지 않는다), 일반 턴이 도는 동안의 재개는 기다린다', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-oc-1b-h1-'));
  const prevFetch = globalThis.fetch, prevOutbox = process.env.ARGO_MSGR_OUTBOX_DIR;
  t.after(async () => { globalThis.fetch = prevFetch; delete globalThis.__argoSdkFixture; globalThis[LIVE]?.delete('default');
    if (prevOutbox === undefined) delete process.env.ARGO_MSGR_OUTBOX_DIR; else process.env.ARGO_MSGR_OUTBOX_DIR = prevOutbox; await rm(dir, { recursive: true, force: true }); });
  process.env.ARGO_MSGR_OUTBOX_DIR = join(dir, 'outbox');
  const { channel } = await loadPlugin(sdk(), { exportInternals: true });
  const answers = [];
  globalThis.fetch = async (url, init) => { const body = JSON.parse(init.body); answers.push(body); return { status: 200, json: async () => ({ ok: true, result: { message_id: 99 } }) }; };
  const dispatches = [], gates = [];
  channel.setArgoRuntime({ channel: { activity: { record() {} }, routing: { resolveAgentRoute: () => ({ agentId: 'a', sessionKey: 's', accountId: 'default' }) },
    inbound: { buildContext: (p) => ({ SessionKey: p.route.dispatchSessionKey, BodyForAgent: p.message.bodyForAgent }),
      dispatch: async ({ route, ctxPayload, delivery }) => {
        const g = gate(); gates.push(g);
        const resume = ctxPayload.BodyForAgent.startsWith('[Argo Messenger — approval decided]');
        dispatches.push({ sessionKey: route.sessionKey, resume });
        await g.p;
        await delivery.deliver({ text: resume ? 'RESUME-ANSWER\nMSGR: done' : 'NORMAL-ANSWER\nMSGR: done' }, { kind: 'final' });
      } } } });
  const account = { accountId: 'default', url: 'https://argo.test', token: T, configured: true, enabled: true, config: {} };
  const followups = [], spawned = [];
  const SK = `s:argo-dm:${CH}:conversation`;
  const bridge = new ApprovalBridge({ api: { ackApproval: async () => ({ claimed: true }), sendFollowup: async (id, text) => { followups.push([id, text]); return {}; } },
    // 기다림 상한은 H1 단위 테스트가 잠근다 — 여기서는 순서만 보므로 상한을 넉넉히(부하가 걸려도 BUSY로 끝나지 않게)
    resolve: async () => {}, busyWaitMs: 1, busyWaitTries: 1_000_000, sleep: () => new Promise((r) => setTimeout(r, 1)), spawn: (fn) => { spawned.push(fn()); },
    resume: (p) => channel.resumeAgentTurn({ account, cfg: {}, log: () => {}, ...p }) });
  globalThis[LIVE].set('default', { accountId: 'default', bridge, mirror: {}, log: () => {} });
  bridge.agents = { 'ag-a': { sessionKey: SK, source: { chat: { id: CH, kind: 'dm', name: 'DM' }, from: { id: 'u1', name: '유건' } }, title: 'A' } };
  bridge.agents['ag-b'] = { ...bridge.agents['ag-a'], title: 'B' }; bridge.agentsLoad = Promise.resolve();
  const msg = (id) => ({ message_id: id, execution_attempt: ATT, text: 'hi ' + id, chat: { id: CH, kind: 'dm', name: 'DM' }, from: { id: 'u1', name: '유건' } });
  // (가) 재개 턴 진행 중 → 같은 세션에 새 글
  await bridge.onDecided({ agent: true, approval_id: 'ag-a', status: 'approved', resume: true });
  await until(() => dispatches.length >= 1);
  assert.deepEqual(dispatches.map((d) => [d.sessionKey, d.resume]), [[SK, true]]);
  const inbound = channel.handleInbound({ m: msg(31), account, cfg: {}, log: () => {} });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(dispatches.length, 1, '재개 턴이 끝날 때까지 새 글을 넣지 않는다');
  gates[0].open();
  await Promise.all(spawned);
  await until(() => dispatches.length >= 2);
  gates[1].open(); await inbound;
  assert.deepEqual(followups, [['ag-a', 'RESUME-ANSWER']], '후속 보고에는 재개 턴의 답만');
  assert.deepEqual(dispatches.map((d) => d.resume), [true, false]);
  assert.equal(answers.at(-1).text, 'NORMAL-ANSWER'); assert.equal(answers.at(-1).reply_to_message_id, 31, '새 글의 답은 그 글의 답글로');
  // (나) 일반 턴 진행 중 → 재개는 끝날 때까지 기다린다
  const inbound2 = channel.handleInbound({ m: msg(32), account, cfg: {}, log: () => {} });
  await until(() => dispatches.length >= 3);
  await bridge.onDecided({ agent: true, approval_id: 'ag-b', status: 'approved', resume: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dispatches.length, 3, '일반 턴이 도는 동안 재개 턴을 넣지 않는다');
  gates[2].open(); await inbound2;
  await until(() => dispatches.length >= 4);
  assert.deepEqual(dispatches.map((d) => d.resume), [true, false, false, true]);
  gates[3].open(); await Promise.all(spawned);
  assert.deepEqual(followups.at(-1), ['ag-b', 'RESUME-ANSWER']);
});

test('L1·L3·L4 — resolve가 applied:false면 늦은 결정, 후속 보고 일시 오류는 짧게 재시도·영구 거절은 안 함, 재개 정보 첫 읽기는 한 번만', async (t) => {
  // L1
  const api = fakeApi({ ackApproval: { claimed: true }, requestApproval: { message_id: 1 }, sendFollowup: { message_id: 2 } });
  let applied = false;
  const b = new ApprovalBridge({ api, resolve: async () => ({ applied, approval: null }) });
  b.track({ message_id: 1, execution_attempt: ATT, chat: { id: CH } });
  const e = await b.request({ externalId: 'oc-l1', kind: 'exec', chatId: CH, command: 'x' });
  assert.equal(await b.onDecided({ approval_id: e.approvalId, status: 'approved', resume: true }), 'late');
  assert.deepEqual(api.calls.at(-1), ['sendFollowup', { approval_id: e.approvalId, text: FOLLOWUP_LATE }]);
  applied = true;
  const e2 = await b.request({ externalId: 'oc-l1b', kind: 'exec', chatId: CH, command: 'x' });
  assert.equal(await b.onDecided({ approval_id: e2.approvalId, status: 'approved', resume: true }), 'allow-once');
  // L3
  let fails = 2; const sleeps = [];
  const flaky = fakeApi({ sendFollowup: () => { if (fails-- > 0) { const err = new Error('502: bad gateway'); err.status = 502; throw err; } return { message_id: 9 }; } });
  const b3 = new ApprovalBridge({ api: flaky, resolve: async () => {}, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await b3.followup('ag-x', '보고'), { message_id: 9 });
  assert.equal(flaky.calls.length, 3); assert.deepEqual(sleeps, [1_000, 3_000]);
  assert.equal(await b3.followup('ag-x', '또'), null); assert.equal(flaky.calls.length, 3, '한 번 올린 결재는 다시 안 보낸다');
  const denied = fakeApi({ sendFollowup: () => { const err = new Error('403: Forbidden'); err.status = 403; throw err; } });
  const logs = [];
  const b4 = new ApprovalBridge({ api: denied, resolve: async () => {}, sleep: async () => { throw new Error('should not sleep'); }, log: (x) => logs.push(x) });
  assert.equal(await b4.followup('ag-y', '보고'), null); assert.equal(denied.calls.length, 1, '영구 거절(4xx)은 재시도하지 않는다');
  assert.ok(logs.some((l) => /follow-up for ag-y failed/.test(l)));
  // L4 — 새 다리에 결정 두 건이 동시에 와도 파일을 한 번만 읽어, 앞 건이 지운 항목이 뒤 건의 읽기로 되살아나지 않는다
  const dir = await tmpDir(t);
  const file = join(dir, 'ag.json');
  const seed = new ApprovalBridge({ api: fakeApi({ requestApproval: { message_id: 1 } }), resolve: async () => {}, agentStateFile: file });
  seed.track({ message_id: 5, execution_attempt: ATT, chat: { id: CH, kind: 'dm' }, from: { id: 'u1' } }, 'S');
  const a1 = await seed.requestAgent({ sessionKey: 'S', requesterSenderId: 'u1', title: '하나' });
  const a2 = await seed.requestAgent({ sessionKey: 'S', requesterSenderId: 'u1', title: '둘' });
  const spawned = [];
  const fresh = new ApprovalBridge({ api: fakeApi({ ackApproval: { claimed: true }, sendFollowup: {} }), resolve: async () => {}, agentStateFile: file,
    spawn: (fn) => { spawned.push(fn()); }, resume: async () => '' });
  await Promise.all([fresh.onDecided({ agent: true, approval_id: a1.approval_id, status: 'approved', resume: true }),
    fresh.onDecided({ agent: true, approval_id: a2.approval_id, status: 'approved', resume: true })]);
  await Promise.all(spawned);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {}, '두 건 모두 지워졌다');
});

test('M1 outbox — 답장 경로가 보내는 중인 파일은 폴 전 재전송(flush)이 건너뛰어 같은 답장 RPC가 두 번 나가지 않는다', async (t) => {
  const dir = await tmpDir(t);
  const hold = gate(); const sent = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop().split('?')[0];
    if (method === 'sendMessage') { sent.push(JSON.parse(init.body)); await hold.p; return { status: 200, json: async () => ({ ok: true, result: { message_id: 5 } }) }; }
    return { status: 200, json: async () => ({ ok: true, result: [] }) };
  };
  const reply = makeApi({ url: 'https://m1.test', token: T, outboxDir: dir, fetchImpl });
  const poll = makeApi({ url: 'https://m1.test', token: T, outboxDir: dir, fetchImpl });
  const sending = reply.sendMessage(CH, '완성된 답', 7, { execution_attempt: ATT, disposition: 'done', mentions: [] });
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(sent.length, 1);
  await poll.getUpdates(0); // 전송 중인 파일을 보고도 건너뛴다(기다리지도 않는다 — 폴이 막히지 않는다)
  assert.equal(sent.length, 1, '같은 답장을 두 번 보내지 않는다');
  hold.open();
  assert.equal((await sending).message_id, 5);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.json')), [], '보낸 뒤 파일을 지운다');
  await poll.getUpdates(0);
  assert.equal(sent.length, 1);
});

test('재검수 — 재개 턴이 예외로 끝나도 부모 연결을 풀고 실패 안내를 후속 보고, 다른 화면에서 이미 승인된 applied:false는 늦은 결정 알림을 안 보낸다', async () => {
  const api = fakeApi({ ackApproval: { claimed: true }, sendFollowup: { message_id: 1 } });
  const spawned = [];
  const b = new ApprovalBridge({ api, resolve: async () => ({ applied: false, approval: { status: 'approved', decision: 'allow-once' } }), spawn: (fn) => { spawned.push(fn()); },
    sleep: async () => {}, resume: async () => { throw new Error('provider down'); } });
  b.agents = { 'ag-x': { sessionKey: 'SX', source: { chat: { id: CH } }, title: 't' } }; b.agentsLoad = Promise.resolve();
  assert.equal(await b.onDecided({ agent: true, approval_id: 'ag-x', status: 'approved', resume: true }), 'resumed');
  await Promise.all(spawned);
  assert.equal(b.parents.size, 0, '예외가 나도 부모 연결이 남지 않는다(남으면 같은 세션의 다른 실행이 옛 원문에 카드를 붙인다)');
  assert.deepEqual(api.calls.at(-1), ['sendFollowup', { approval_id: 'ag-x', text: FOLLOWUP_FAILED }]);
  const n = api.calls.length;
  b.approvals.set('hx-1', { externalId: 'e1', kind: 'exec' });
  assert.equal(await b.onDecided({ approval_id: 'hx-1', status: 'approved', resume: true }), 'allow-once');
  assert.deepEqual(api.calls.slice(n).map((c) => c[0]), ['ackApproval'], '이미 승인돼 실행됐으면 "실행되지 않았다"고 알리지 않는다');
});
