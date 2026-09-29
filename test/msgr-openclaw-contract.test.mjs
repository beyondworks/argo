// 크루 계약 1-a(2026-09-29) — OpenClaw 채널 플러그인이 예약 작업을 메신저 "업무 > 자동화"에 미러하고, 메신저 편집을 OpenClaw 스케줄러에
// 반영하고, 위험 작업 승인을 결재 카드로 주고받는지 실제 플러그인 코드(src/contract.js·api.js·channel.ts·index.ts)로 돈다.
// Hermes 어댑터 테스트(test/msgr-hermes-contract.test.mjs)와 같은 사례를 같은 기대값으로 둔다. OpenClaw SDK·스케줄러·게이트웨이는 최소 흉내다.
// 서버 판정은 test/msgr-ext-agent-contract-pg.test.mjs, 실제 OpenClaw 2026.9.6 격리 설치 확인은 README 검증 기록.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import {
  scheduleToMsgr as s, msgrToOpenclawSchedule as c, jobMsgrChannel, jobToRow, jobFingerprint, decideRoutineEdit, buildEditPatch,
  RoutineMirror, ApprovalBridge, SCRIPT_PROMPT,
} from '../integrations/openclaw-argo-msgr/src/contract.js';
import { pollLoop } from '../integrations/openclaw-argo-msgr/src/api.js';

const CH = '11111111-1111-4111-8111-111111111111';
const T = 'argo_bot_' + 'c'.repeat(48);
const argoJob = (o = {}) => ({ id: 'j1', name: '보고', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'agentTurn', message: '정리' },
  delivery: { mode: 'announce', channel: 'argo-msgr', to: CH }, ...o });
const localJob = (o = {}) => ({ id: 'j2', name: '로컬', enabled: true, schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'p' },
  delivery: { mode: 'none', channel: 'last' }, ...o });

function fakeCron(jobs) {
  const calls = [];
  return { jobs, calls,
    list: async () => jobs.map((j) => structuredClone(j)),
    update: async (id, patch) => { calls.push(['update', id, patch]); const j = jobs.find((x) => x.id === id); if (j) Object.assign(j, patch.payload ? { ...patch, payload: { ...j.payload, ...patch.payload } } : patch); },
    remove: async (id) => { calls.push(['remove', id]); } };
}
function fakeApi(resp = {}) {
  const calls = [];
  const call = (method) => async (params) => { calls.push([method, params]); const r = resp[method]; return typeof r === 'function' ? r(params) : r; };
  return { calls, resp, setRoutines: call('setRoutines'), routineEditDone: call('routineEditDone'), requestApproval: call('requestApproval'),
    ackApproval: (id) => call('ackApproval')({ approval_id: id }), expireApproval: (id) => call('expireApproval')({ approval_id: id }) };
}
async function tmpState(t) { const dir = await mkdtemp(join(tmpdir(), 'argo-oc-contract-')); t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, 'routines.json'); }

test('일정 변환 — 표현 가능한 cron은 daily/weekly/interval/once, 나머지는 raw(읽기 전용) — Hermes와 같은 사례', () => {
  assert.deepEqual(s({ kind: 'cron', expr: '49 0 * * *' }, 'Asia/Seoul'), { type: 'daily', time: '00:49', times: ['00:49'], tz: 'Asia/Seoul' });
  assert.deepEqual(s({ kind: 'cron', expr: '0 9 * * 1,3,5' }).dows, [1, 3, 5]);
  assert.deepEqual(s({ kind: 'cron', expr: '0 9 * * 7' }).dows, [0], 'cron 7은 일요일(0)');
  assert.deepEqual(s({ kind: 'cron', expr: '0 9,18 * * *' }).times, ['09:00', '18:00']);
  assert.equal(s({ kind: 'cron', expr: '0 9 * * 1-5' }).type, 'raw', '범위는 raw');
  assert.deepEqual(s({ kind: 'cron', expr: '*/7 * * * *' }), { type: 'raw', expr: '*/7 * * * *', display: '*/7 * * * *' });
  assert.deepEqual(s({ kind: 'every', everyMs: 30 * 60_000 }), { type: 'interval', everyMinutes: 30 });
  assert.deepEqual(s({ kind: 'at', at: '2026-10-01T00:30:00+00:00' }, 'Asia/Seoul'), { type: 'once', date: '2026-10-01', time: '09:30', tz: 'Asia/Seoul' });
  assert.equal(c({ type: 'daily', time: '09:30' }).expr, '30 9 * * *');
  assert.equal(c({ type: 'weekly', times: ['08:05'], dows: [3, 1] }).expr, '5 8 * * 1,3');
  assert.deepEqual(c({ type: 'interval', everyMinutes: 15 }), { kind: 'every', everyMs: 15 * 60_000 }, 'Hermes "every 15m"');
  assert.equal(c({ type: 'once', date: '2026-10-01', time: '09:00' }), null);
  for (const expr of ['49 0 * * *', '5 8 * * 1,3']) assert.equal(c(s({ kind: 'cron', expr })).expr, expr, '왕복');
  // OpenClaw 고유: 작업 자체 시간대가 우선, 분 단위가 아닌 every·on-exit는 raw, 같은 분의 여러 시각은 cron 한 줄로 왕복
  assert.equal(s({ kind: 'cron', expr: '0 7 * * *', tz: 'America/New_York' }, 'Asia/Seoul').tz, 'America/New_York');
  assert.equal(s({ kind: 'every', everyMs: 90_000 }).type, 'raw');
  assert.equal(s({ kind: 'on-exit', command: 'x' }).type, 'raw');
  assert.equal(c(s({ kind: 'cron', expr: '0 9,18 * * *' })).expr, '0 9,18 * * *');
  assert.equal(c({ type: 'daily', times: ['09:00', '18:30'] }), null, '분이 다른 여러 시각은 cron 한 줄로 못 쓴다');
  assert.deepEqual(c({ type: 'daily', time: '07:15', tz: 'Asia/Seoul' }), { kind: 'cron', expr: '15 7 * * *', tz: 'Asia/Seoul' });
});

test('미러 범위 — 메신저로 결과를 보내는 작업만 기본, MIRROR_ALL이면 보이되 고칠 수 없다(D2)', () => {
  const ch = (job, o) => jobMsgrChannel(job, { accountId: 'main', ownsUnscoped: true, ...o });
  assert.equal(ch(localJob()), null);
  assert.equal(ch(argoJob({ delivery: { mode: 'none', channel: 'argo-msgr', to: CH } })), null, '전달 안 함(none)이면 메신저 전달 작업이 아니다');
  assert.equal(ch(argoJob({ delivery: { mode: 'webhook', channel: 'argo-msgr', to: CH } })), null);
  assert.equal(ch(argoJob()), CH);
  assert.equal(ch(argoJob({ delivery: { channel: 'last', to: `argo-msgr:${CH}` } })), CH, '접두어 대상(argo-msgr:<채널>)도 메신저 전달');
  assert.equal(ch(argoJob({ delivery: { mode: 'announce', channel: 'telegram', to: '1' } })), null);
  assert.equal(ch(argoJob({ delivery: { mode: 'announce', channel: 'argo-msgr', to: 'general' } })), '', '채널 id가 아니면 채널 없이');
  assert.equal(ch(argoJob({ delivery: { mode: 'announce', channel: 'argo-msgr', to: CH, accountId: 'other' } })), null, '다른 봇 계정의 작업');
  assert.equal(ch(argoJob(), { ownsUnscoped: false }), null, '계정을 안 적은 작업은 기본(또는 유일한) 계정 것');
  assert.equal(jobToRow(localJob(), { channel: null, tz: 'Asia/Seoul' }), null);
  const row = jobToRow(localJob(), { channel: null, tz: 'Asia/Seoul', mirrorAll: true });
  assert.equal(row.editable, false); assert.equal(row.channel_id, null);
  const script = argoJob({ id: 'j3', name: '', payload: { kind: 'command', argv: ['x.sh'] }, schedule: { kind: 'every', everyMs: 3_600_000 } });
  const srow = jobToRow(script, { channel: CH });
  assert.equal(srow.editable, true); assert.equal(srow.prompt, SCRIPT_PROMPT); assert.ok(srow.title);
  assert.equal(jobToRow(argoJob({ enabled: false }), { channel: CH }).enabled, false);
  assert.deepEqual(Object.keys(jobToRow(argoJob(), { channel: CH })).sort(), ['channel_id', 'editable', 'enabled', 'ext_id', 'prompt', 'schedule', 'status', 'title', 'updated_at']);
});

test('지문은 실행 필드를 무시하고, 편집 판정은 Argo와 같다(없음=failed, 편집 뒤 사람이 고침=superseded)', () => {
  const j = localJob();
  assert.equal(jobFingerprint(j), jobFingerprint({ ...j, state: { lastRunAtMs: 1, nextRunAtMs: 2, lastRunStatus: 'ok' }, updatedAtMs: 9, nextRunAtMs: 3, status: 'running' }));
  assert.notEqual(jobFingerprint(j), jobFingerprint({ ...j, payload: { kind: 'agentTurn', message: 'q' } }));
  assert.equal(decideRoutineEdit(null, {}, '2026-09-29T09:00:00+00:00'), 'failed');
  assert.equal(decideRoutineEdit(j, { changed_at: '2026-09-29T10:00:00+00:00' }, '2026-09-29T09:00:00+00:00'), 'superseded');
  assert.equal(decideRoutineEdit(j, { changed_at: '2026-09-29T08:00:00+00:00' }, '2026-09-29T09:00:00+09:00'), 'superseded', '시간대가 달라도 절대 시각으로 비교');
  assert.equal(decideRoutineEdit(j, {}, '2026-09-29T09:00:00Z'), 'apply');
});

test('미러 — 바뀐 게 없으면 네트워크 호출 0, 서버 행 수가 다르면 다음에 다시 보낸다, 스케줄러가 없으면 unsupported 한 번', async (t) => {
  const cron = fakeCron([argoJob(), localJob()]);
  const api = fakeApi({ setRoutines: (p) => ({ kept: (p.rows ?? []).length, total: (p.rows ?? []).length }) });
  let access = { state: 'ready', cron };
  let clock = Date.parse('2026-09-29T00:00:00Z');
  const m = new RoutineMirror({ api, cronAccess: async () => access, accountId: 'main', stateFile: await tmpState(t), tz: () => 'Asia/Seoul', mirrorAll: () => false, now: () => clock });
  await m.sync();
  assert.deepEqual(api.calls.map((x) => x[0]), ['setRoutines']); assert.deepEqual(api.calls[0][1].rows.map((r) => r.ext_id), ['j1']);
  await m.sync();
  assert.equal(api.calls.length, 1, '같은 스냅샷이면 호출하지 않는다');
  cron.jobs[0].state = { lastRunAtMs: Date.parse('2026-09-29T00:00:00Z'), lastRunStatus: 'ok' };
  await m.sync();
  assert.equal(api.calls.length, 2); assert.equal(api.calls.at(-1)[1].rows[0].status.last_status, 'ok', '처음 상태는 보낸다');
  cron.jobs[0].state.lastRunStatus = 'error';
  clock += 60_000;
  await m.sync();
  assert.equal(api.calls.length, 2, '10분 안의 상태 변화만으로는 다시 쓰지 않는다');
  api.resp.setRoutines = { kept: 1, total: 0 };
  cron.jobs[0].payload.message = '정리 v2';
  await m.sync(); await m.sync();
  assert.equal(api.calls.length, 4, '서버 total 불일치 → 다음 주기에 다시 보낸다');
  assert.ok(api.calls.at(-1)[1].rows[0].updated_at, '사람이 고친 시각이 updated_at');
  access = { state: 'unsupported', reason: 'This OpenClaw version does not give plugins the scheduler (service ctx.getCron missing)' };
  await m.sync(); await m.sync();
  assert.deepEqual(api.calls.at(-1), ['setRoutines', { unsupported: access.reason }]); assert.equal(api.calls.length, 5);
  access = { state: 'ready', cron: { ...cron, list: async () => { throw new Error('store locked'); } } };
  await assert.rejects(m.sync(), /store locked/);
  assert.equal(api.calls.length, 5, '읽기 실패면 빈 스냅샷을 보내지 않는다');
  access = { state: 'pending' };
  assert.equal(await m.sync(), 'pending'); assert.equal(api.calls.length, 5);
});

test('미러 상태 파일 — 재시작 뒤에도 사람이 고친 시각이 남아 superseded 판정이 유지된다(토큰 없음)', async (t) => {
  const file = await tmpState(t);
  const cron = fakeCron([argoJob()]);
  const api = fakeApi({ setRoutines: (p) => ({ total: (p.rows ?? []).length }) });
  const mk = () => new RoutineMirror({ api, cronAccess: async () => ({ state: 'ready', cron }), accountId: 'main', stateFile: file, tz: () => null, mirrorAll: () => false });
  await mk().sync();
  cron.jobs[0].name = '사람이 고침';
  await mk().sync();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(saved.j1.changed_at); assert.equal(JSON.stringify(saved).includes('argo_bot_'), false);
  api.resp.routineEditDone = true;
  await mk().applyEdit({ edit_id: 'e0', ext_id: 'j1', op: 'update', patch: { title: '옛 편집' }, created_at: '2000-01-01T00:00:00Z' });
  assert.equal(api.calls.find((x) => x[0] === 'routineEditDone')[1].status, 'superseded');
});

test('편집 반영 — 끄기·일정은 OpenClaw 스케줄러 update 한 번, 메신저 전달 작업이 아니면 failed, 편집 뒤 사람이 고쳤으면 superseded', async (t) => {
  const cron = fakeCron([argoJob(), localJob()]);
  const api = fakeApi({ setRoutines: (p) => ({ total: (p.rows ?? []).length }), routineEditDone: true });
  // 처리 시각 고정 — e5(13:00) 반영 뒤 미러가 changed_at을 이 시각으로 찍고 e6(14:00)은 그보다 나중이다. 실제 시계를 쓰면 9/29 14:00 UTC 뒤로 e6이 superseded가 된다.
  const clock = Date.parse('2026-09-29T13:30:00Z');
  const m = new RoutineMirror({ api, cronAccess: async () => ({ state: 'ready', cron }), accountId: 'main', stateFile: await tmpState(t), tz: () => 'Asia/Seoul', mirrorAll: () => false, now: () => clock });
  const done = () => api.calls.filter((x) => x[0] === 'routineEditDone').at(-1)[1];
  await m.applyEdit({ event: 'routine_edit', edit_id: 'e1', ext_id: 'j1', op: 'update', patch: { enabled: false, schedule: { type: 'daily', time: '07:15' } }, created_at: '2026-09-29T09:00:00+00:00' });
  assert.deepEqual(cron.calls, [['update', 'j1', { schedule: { kind: 'cron', expr: '15 7 * * *', tz: 'Asia/Seoul' }, enabled: false }]]);
  assert.deepEqual(done(), { edit_id: 'e1', status: 'applied', error: null });
  assert.equal(api.calls.at(-1)[0], 'setRoutines', '반영 뒤 바로 미러');
  assert.equal(api.calls.at(-1)[1].rows[0].enabled, false);
  cron.calls.length = 0;
  await m.applyEdit({ edit_id: 'e2', ext_id: 'j2', op: 'delete', patch: {}, created_at: '2026-09-29T09:00:00+00:00' });
  assert.deepEqual(cron.calls, []); assert.equal(done().error, 'not_editable');
  await m.applyEdit({ edit_id: 'e3', ext_id: 'gone', op: 'delete', patch: {}, created_at: '2026-09-29T09:00:00+00:00' });
  assert.deepEqual(done(), { edit_id: 'e3', status: 'failed', error: 'routine_not_found' });
  m.state.j1.changed_at = '2026-09-29T12:00:00+00:00';
  await m.applyEdit({ edit_id: 'e4', ext_id: 'j1', op: 'update', patch: { title: '옛 편집' }, created_at: '2026-09-29T11:00:00+00:00' });
  assert.deepEqual(cron.calls, []); assert.equal(done().status, 'superseded');
  await m.applyEdit({ edit_id: 'e5', ext_id: 'j1', op: 'update', patch: { title: '새 제목', prompt: '새 지시' }, created_at: '2026-09-29T13:00:00+00:00' });
  assert.deepEqual(cron.calls.at(-1), ['update', 'j1', { name: '새 제목', payload: { kind: 'agentTurn', message: '새 지시' } }]);
  await m.applyEdit({ edit_id: 'e6', ext_id: 'j1', op: 'delete', patch: {}, created_at: '2026-09-29T14:00:00+00:00' });
  assert.deepEqual(cron.calls.at(-1), ['remove', 'j1']); assert.equal(done().status, 'applied');
  assert.throws(() => buildEditPatch(argoJob({ payload: { kind: 'command' } }), { prompt: 'x' }), /not editable/);
  assert.throws(() => buildEditPatch(argoJob(), { schedule: { type: 'once', date: '2026-10-01', time: '09:00' } }), /not representable/);
  const m2 = new RoutineMirror({ api, cronAccess: async () => ({ state: 'pending' }), accountId: 'main', stateFile: await tmpState(t), tz: () => null, mirrorAll: () => false });
  await m2.applyEdit({ edit_id: 'e7', ext_id: 'j1', op: 'delete', patch: {}, created_at: '2026-09-29T09:00:00Z' });
  assert.deepEqual(done(), { edit_id: 'e7', status: 'failed', error: 'OpenClaw cron API unavailable' });
});

test('위험 작업 결재 — 카드는 그 채팅의 실행 시도로 올리고, 선점 ack 성공 때만 OpenClaw에 결정을 돌려준다(중복 이벤트는 재개 안 함)', async () => {
  const api = fakeApi({ requestApproval: { id: 'x', message_id: 77, status: 'pending', risk: 'high' } });
  const resolved = [];
  const b = new ApprovalBridge({ api, resolve: async (p) => { resolved.push(p); api.calls.push(['resolve', p]); } });
  b.track({ message_id: 5, execution_attempt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', chat: { id: CH } });
  b.track({ message_id: 3, execution_attempt: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', chat: { id: 'other' } });
  b.track({ message_id: 4, execution_attempt: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', chat: { id: CH } });
  const entry = await b.request({ externalId: 'oc-req-1', kind: 'exec', chatId: CH, command: 'rm -rf /tmp/x', reason: 'dangerous command' });
  assert.equal(entry.card, '77');
  const [method, params] = api.calls.at(-1);
  assert.equal(method, 'requestApproval');
  assert.deepEqual(params, { execution_attempt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', approval_id: ApprovalBridge.approvalIdFor('oc-req-1'), command: 'rm -rf /tmp/x', reason: 'dangerous command' });
  assert.match(params.approval_id, /^oc-[0-9a-f]{24}$/); assert.equal(ApprovalBridge.approvalIdFor('oc-req-1'), params.approval_id, '같은 요청은 같은 카드(서버 멱등)');
  api.resp.ackApproval = { claimed: true, status: 'approved' };
  assert.equal(await b.onDecided({ event: 'approval_decided', approval_id: params.approval_id, status: 'approved', resume: true }), 'allow-once');
  assert.deepEqual(resolved, [{ externalId: 'oc-req-1', kind: 'exec', decision: 'allow-once' }]);
  assert.deepEqual(api.calls.slice(-2).map((x) => x[0]), ['ackApproval', 'resolve'], 'ack(선점)가 결정 반영보다 먼저');
  assert.deepEqual(api.calls.at(-2)[1], { approval_id: params.approval_id });
  api.resp.ackApproval = { claimed: false, status: 'approved' };
  await b.onDecided({ event: 'approval_decided', approval_id: params.approval_id, status: 'approved', resume: true });
  assert.equal(resolved.length, 1, '선점 못 한 중복 이벤트는 재개하지 않는다');
  const other = await b.request({ externalId: 'oc-req-other', kind: 'exec', chatId: CH, command: 'x', reason: null });
  assert.equal(await b.onDecided({ event: 'approval_decided', approval_id: other.approvalId, status: 'approved', resume: true }), 'skipped');
  assert.equal(resolved.length, 1, '같은 토큰의 다른 어댑터가 먼저 선점했으면(claimed=false) 결정을 돌려주지 않는다');
  assert.equal(b.has('oc-req-other'), false);
  const e2 = await b.request({ externalId: 'oc-req-2', kind: 'plugin', chatId: CH, command: 'publish', reason: null });
  api.resp.ackApproval = { claimed: true, status: 'approved' };
  await b.onDecided({ event: 'approval_decided', approval_id: e2.approvalId, status: 'approved', resume: false, reason: 'ai_consent' });
  assert.deepEqual(resolved.at(-1), { externalId: 'oc-req-2', kind: 'plugin', decision: 'deny' }, '승인됐어도 재개 자격이 없으면 거절');
  const e3 = await b.request({ externalId: 'oc-req-3', kind: 'exec', chatId: CH, command: 'x', reason: null });
  await b.onDecided({ event: 'approval_decided', approval_id: e3.approvalId, status: 'rejected', resume: false });
  assert.equal(resolved.at(-1).decision, 'deny');
  const before = api.calls.length;
  assert.equal(await b.request({ externalId: 'oc-req-4', kind: 'exec', chatId: 'nowhere', command: 'x' }), null, '실행 중인 원문이 없으면 카드를 만들지 않는다(OpenClaw 기존 경로)');
  assert.equal(api.calls.length, before);
  b.done({ message_id: 5 }); b.done({ message_id: 4 });
  assert.equal(await b.request({ externalId: 'oc-req-5', kind: 'exec', chatId: CH, command: 'x' }), null, '답한 원문은 다시 쓰지 않는다');
});

test('시간 초과·다른 곳에서 결정 — 열린 카드만 expireApproval로 닫고, 메신저 결정으로 푼 카드는 건드리지 않는다', async () => {
  const api = fakeApi({ requestApproval: { message_id: 90 }, expireApproval: { status: 'expired', expired_now: true }, ackApproval: { claimed: true } });
  const b = new ApprovalBridge({ api, resolve: async () => {} });
  b.track({ message_id: 9, execution_attempt: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', chat: { id: CH } });
  const e = await b.request({ externalId: 'oc-9', kind: 'exec', chatId: CH, command: 'x' });
  assert.equal(await b.expire('oc-9'), true);
  assert.deepEqual(api.calls.at(-1), ['expireApproval', { approval_id: e.approvalId }]); assert.equal(b.has('oc-9'), false);
  const n = api.calls.length;
  assert.equal(await b.expire('oc-unknown'), false); assert.equal(api.calls.length, n);
  const e2 = await b.request({ externalId: 'oc-10', kind: 'exec', chatId: CH, command: 'y' });
  await b.onDecided({ approval_id: e2.approvalId, status: 'approved', resume: true });
  assert.equal(await b.expire('oc-10'), false, '결정 반영 뒤 코어가 부르는 updateEntry는 닫힌 카드를 만료시키지 않는다');
});

test('폴 루프 — 이벤트는 처리하되 offset은 메시지만 올리고, 실행 중인 턴이 폴을 막지 않는다(결정 이벤트를 받아야 하므로)', async () => {
  const seen = [], offsets = [], sleeps = [];
  let n = 0, release;
  const blocked = new Promise((r) => { release = r; });
  const api = { getUpdates: async (offset) => {
    offsets.push(offset); n++;
    if (n === 1) return [{ event: 'routine_edit', edit_id: 'e' }, { update_id: 41, message: { message_id: 41, delivery_role: 'to' } }];
    if (n === 2) return [{ event: 'approval_decided', approval_id: 'oc-x' }]; // 이벤트만 → 0.5초 쉼
    const { ArgoMsgrError } = await import('../integrations/openclaw-argo-msgr/src/api.js');
    throw new ArgoMsgrError(401, 'stop');
  } };
  await pollLoop(api, { onEvent: async (ev) => { seen.push(ev.event); if (ev.event === 'approval_decided') release(); },
    onMessage: async (m) => { seen.push(m.message_id); await blocked; seen.push('turn-finished'); }, sleep: async (ms) => { sleeps.push(ms); } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(offsets, [0, 42, 42]);
  assert.deepEqual(seen, ['routine_edit', 41, 'approval_decided', 'turn-finished'], '턴이 끝나기 전에 다음 폴이 결정 이벤트를 받는다');
  assert.deepEqual(sleeps, [500]);
});

// ── 실제 channel.ts·index.ts 배선(SDK는 흉내) ─────────────────────────────────────────────
async function loadPlugin(fixture) {
  const src = (p) => new URL(`../integrations/openclaw-argo-msgr/${p}`, import.meta.url);
  const rewrite = (code) => {
    for (const line of code.match(/import \{[\s\S]*?\} from "openclaw\/plugin-sdk\/[a-z-]+";/g) ?? []) code = code.replace(line, `const {${line.match(/\{([\s\S]*?)\}/)[1]}}=globalThis.__argoSdkFixture;`);
    return code;
  };
  globalThis.__argoSdkFixture = fixture;
  let channel = rewrite(stripTypeScriptTypes(await readFile(src('src/channel.ts'), 'utf8')));
  channel = channel.replace('"./api.js"', JSON.stringify(src('src/api.js').href)).replace('"./contract.js"', JSON.stringify(src('src/contract.js').href));
  const channelUrl = 'data:text/javascript;base64,' + Buffer.from(channel).toString('base64');
  const index = rewrite(stripTypeScriptTypes(await readFile(src('index.ts'), 'utf8'))).replace('"./src/channel.js"', JSON.stringify(channelUrl));
  return { channel: await import(channelUrl), entry: (await import('data:text/javascript;base64,' + Buffer.from(index).toString('base64'))).default };
}

test('배선 — 턴이 승인 대기로 멈춘 동안 결정 이벤트가 와서 카드 → ack → OpenClaw 결정 → 최종 답까지, 편집 이벤트는 등록된 서비스의 스케줄러로', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-oc-wiring-'));
  const prevFetch = globalThis.fetch, prevOutbox = process.env.ARGO_MSGR_OUTBOX_DIR;
  t.after(async () => { globalThis.fetch = prevFetch; delete globalThis.__argoSdkFixture; if (prevOutbox === undefined) delete process.env.ARGO_MSGR_OUTBOX_DIR; else process.env.ARGO_MSGR_OUTBOX_DIR = prevOutbox; await rm(dir, { recursive: true, force: true }); });
  process.env.ARGO_MSGR_OUTBOX_DIR = join(dir, 'outbox');
  const resolved = [], contexts = [];
  let disposed = 0, decided;
  const decidedP = new Promise((r) => { decided = r; });
  const { channel, entry } = await loadPlugin({
    DEFAULT_ACCOUNT_ID: 'default', createChannelInboundEnvelopeBuilder: () => (o) => o.body, formatTextWithAttachmentLinks: (x) => x, resolveOutboundMediaUrls: () => [],
    createChannelApprovalCapability: (x) => x, createChannelApprovalNativeRuntimeAdapter: (x) => x, CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY: 'approval.native',
    resolveApprovalOverGateway: async (p) => { resolved.push(p); decided(); return { ok: true }; },
    registerChannelRuntimeContext: (p) => { contexts.push(p); return { dispose: () => { disposed++; } }; },
    defineChannelPluginEntry: (x) => x, buildBaseAccountStatusSnapshot: () => ({}), buildBaseChannelStatusSummary: () => ({}), deleteAccountFromConfigSection: () => ({}), setAccountEnabledInConfigSection: () => ({}),
  });
  // index.ts registerFull → 게이트웨이 서비스 등록 → 시작하면 스케줄러 핸들을 받는다
  const services = [];
  entry.registerFull({ registerService: (svc) => services.push(svc) });
  assert.equal(services.length, 1); assert.equal(services[0].id, 'argo-msgr-routines');
  const cron = fakeCron([argoJob()]);
  await services[0].start({ getCron: () => cron });

  const plugin = channel.argoMsgrPlugin, rt = plugin.approvalCapability.nativeRuntime;
  const request = { id: 'oc-exec-1', request: { command: 'rm -rf /tmp/x', turnSourceChannel: 'argo-msgr', turnSourceTo: `argo-msgr:${CH}`, turnSourceAccountId: 'default' } };
  let cardSeen;
  const cardP = new Promise((r) => { cardSeen = r; });
  const calls = [], logs = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    const method = url.split('/').pop().split('?')[0];
    const body = init?.body ? JSON.parse(init.body) : Object.fromEntries(new URL(url).searchParams);
    calls.push([method, body]);
    const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (method === 'getMe') return ok({ first_name: 'Claw', kind: 'openclaw', org: { name: 'Org' } });
    if (method === 'requestApproval') { cardSeen(body); return ok({ id: 'row', message_id: 77, status: 'pending', risk: 'high' }); }
    if (method === 'ackApproval') return ok({ claimed: true, status: 'approved' });
    if (method === 'expireApproval') return ok({ status: 'expired', expired_now: true });
    if (method === 'routineEditDone' || method === 'sendMessage') return ok(method === 'sendMessage' ? { message_id: 99 } : true);
    if (method === 'setRoutines') return ok({ total: (body.rows ?? []).length });
    if (method === 'getUpdates') {
      polls++;
      if (logs.some((l) => /dispatch failed/.test(l))) return { status: 401, json: async () => ({ ok: false, error_code: 401, description: 'stop: turn failed' }) }; // 턴 안 단언 실패는 매달리지 않고 끝낸다
      if (polls === 1) return ok([{ update_id: 7, message: { message_id: 7, execution_attempt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', delivery_role: 'to', text: 'RUN', chat: { id: CH, kind: 'public', name: 'g' }, from: { id: 'u' }, peers: [] } },
        { event: 'routine_edit', edit_id: 'e1e1e1e1-1111-4111-8111-111111111111', ext_id: 'j1', op: 'update', patch: { enabled: false }, created_at: new Date(Date.now() + 1000).toISOString() }]);
      const card = await Promise.race([cardP, new Promise((r) => setTimeout(() => r(null), 50))]);
      if (card && !resolved.length) return ok([{ event: 'approval_decided', approval_id: card.approval_id, status: 'approved', resume: true }]);
      if (resolved.length && calls.some((x) => x[0] === 'sendMessage')) return { status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) };
      return ok([]);
    }
    return { status: 404, json: async () => ({ ok: false, error_code: 404, description: method }) };
  };
  channel.setArgoRuntime({ config: { loadConfig: () => ({}) }, channel: { activity: { record() {} }, routing: { resolveAgentRoute: () => ({ agentId: 'a', sessionKey: 's', accountId: 'default' }) },
    inbound: { buildContext: (p) => ({ SessionKey: p.route.dispatchSessionKey }), dispatch: async ({ delivery }) => {
      // OpenClaw 코어가 하는 일 흉내: exec 승인 요청 → 채널 네이티브 승인(카드) → 결정이 올 때까지 도구 호출이 기다린다
      assert.equal(rt.availability.shouldHandle({ accountId: 'default', request }), true);
      // 다른 채널·계정에서 시작된 승인은 카드로 만들지 않는다(OpenClaw 기존 경로)
      assert.equal(rt.availability.shouldHandle({ accountId: 'default', request: { id: 'z', request: { turnSourceChannel: 'telegram', turnSourceTo: '1' } } }), false);
      assert.equal(rt.availability.shouldHandle({ accountId: 'default', request: { id: 'z', request: { ...request.request, turnSourceAccountId: 'other' } } }), false);
      assert.equal(rt.availability.isConfigured({ accountId: 'default' }), true);
      const target = await plugin.approvalCapability.native.resolveOriginTarget({ accountId: 'default', request });
      const prepared = rt.transport.prepareTarget({ plannedTarget: { target } });
      const pending = rt.presentation.buildPendingPayload({ request, approvalKind: 'exec', view: { commandText: 'rm -rf /tmp/x' } });
      const entryCard = await rt.transport.deliverPending({ accountId: 'default', preparedTarget: prepared.target, request, approvalKind: 'exec', pendingPayload: pending });
      assert.equal(entryCard.card, '77');
      await decidedP;
      await rt.transport.updateEntry({ accountId: 'default', entry: entryCard, phase: 'resolved' });
      // 두 번째 승인은 OpenClaw 쪽 대기가 시간 초과로 끝난다 → 코어가 updateEntry(expired) → 열린 카드를 expireApproval로 닫는다
      const timedOut = { id: 'oc-exec-2', request: { ...request.request, command: 'curl evil' } };
      const card2 = await rt.transport.deliverPending({ accountId: 'default', preparedTarget: prepared.target, request: timedOut, approvalKind: 'exec',
        pendingPayload: rt.presentation.buildPendingPayload({ request: timedOut, approvalKind: 'exec', view: {} }) });
      await rt.transport.updateEntry({ accountId: 'default', entry: card2, phase: 'expired' });
      await delivery.deliver({ text: 'ran it\nMSGR: done' }, { kind: 'final' });
    } } } });
  const account = { accountId: 'default', enabled: true, configured: true, url: 'https://argo.test', token: T, config: {} };
  await assert.rejects(plugin.gateway.startAccount({ account, accountId: 'default', cfg: {}, abortSignal: new AbortController().signal, channelRuntime: { runtimeContexts: {} },
    log: { info() {}, warn: (x) => logs.push(x) }, setStatus() {} }), /token rejected/);
  assert.deepEqual(logs.filter((l) => /failed/.test(l)), [], '턴·이벤트 처리 중 실패 없음');

  assert.equal(calls.find((x) => x[0] === 'getUpdates')[1].events, '1', 'getUpdates events=1');
  assert.deepEqual(contexts.map((x) => [x.channelId, x.accountId, x.capability]), [['argo-msgr', 'default', 'approval.native']]); assert.equal(disposed, 1);
  const card = calls.find((x) => x[0] === 'requestApproval')[1];
  assert.equal(card.execution_attempt, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); assert.equal(card.command, 'rm -rf /tmp/x');
  const order = calls.map((x) => x[0]).filter((m) => ['requestApproval', 'ackApproval', 'sendMessage', 'expireApproval'].includes(m));
  assert.deepEqual(order, ['requestApproval', 'ackApproval', 'requestApproval', 'expireApproval', 'sendMessage'], '결정으로 푼 카드는 만료시키지 않고, 시간 초과 카드만 닫고, 최종 답은 그 뒤');
  const cards = calls.filter((x) => x[0] === 'requestApproval').map((x) => x[1]);
  assert.equal(cards[1].command, 'curl evil');
  assert.deepEqual(calls.find((x) => x[0] === 'expireApproval')[1], { approval_id: cards[1].approval_id });
  assert.deepEqual(resolved.map(({ cfg, ...r }) => r), [{ approvalId: 'oc-exec-1', decision: 'allow-once', approvalKind: 'exec' }]);
  assert.equal(calls.find((x) => x[0] === 'sendMessage')[1].execution_attempt, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  // 편집 이벤트 → 서비스가 받은 스케줄러로 끄기 → routineEditDone applied → 즉시 미러
  assert.deepEqual(cron.calls, [['update', 'j1', { enabled: false }]]);
  assert.deepEqual(calls.find((x) => x[0] === 'routineEditDone')[1], { edit_id: 'e1e1e1e1-1111-4111-8111-111111111111', status: 'applied', error: null });
  assert.equal(calls.find((x) => x[0] === 'setRoutines')[1].rows[0].enabled, false);
  assert.equal(rt.availability.isConfigured({ accountId: 'default' }), false, '계정이 멈추면 네이티브 승인도 내려놓는다');
  await services[0].stop();
});

test('재시작 복구 — 답 대상이 "argo-msgr:<채널>"로 와도 서버에는 접두어 없는 채널 id로 보낸다(400 거절로 답이 사라지던 결함)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-oc-target-'));
  const prevFetch = globalThis.fetch, prevOutbox = process.env.ARGO_MSGR_OUTBOX_DIR;
  t.after(async () => { globalThis.fetch = prevFetch; delete globalThis.__argoSdkFixture; if (prevOutbox === undefined) delete process.env.ARGO_MSGR_OUTBOX_DIR; else process.env.ARGO_MSGR_OUTBOX_DIR = prevOutbox; await rm(dir, { recursive: true, force: true }); });
  process.env.ARGO_MSGR_OUTBOX_DIR = join(dir, 'outbox');
  const { channel } = await loadPlugin({
    DEFAULT_ACCOUNT_ID: 'default', createChannelInboundEnvelopeBuilder: () => (o) => o.body, formatTextWithAttachmentLinks: (x) => x, resolveOutboundMediaUrls: () => [],
    createChannelApprovalCapability: (x) => x, createChannelApprovalNativeRuntimeAdapter: (x) => x, CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY: 'approval.native',
    resolveApprovalOverGateway: async () => ({ ok: true }), registerChannelRuntimeContext: () => ({ dispose() {} }),
    defineChannelPluginEntry: (x) => x, buildBaseAccountStatusSnapshot: () => ({}), buildBaseChannelStatusSummary: () => ({}), deleteAccountFromConfigSection: () => ({}), setAccountEnabledInConfigSection: () => ({}),
  });
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push([url.split('/').pop(), init?.body ? JSON.parse(init.body) : null]); return { status: 200, json: async () => ({ ok: true, result: { message_id: 5 } }) }; };
  const plugin = channel.argoMsgrPlugin;
  const cfg = { channels: { 'argo-msgr': { accounts: { default: { url: 'https://x.test/functions/v1/msgr-bot', token: 'argo_bot_' + 'a'.repeat(48), enabled: true } } } } };
  assert.equal(plugin.messaging.normalizeTarget(`argo-msgr:${CH}`), CH);
  const res = await plugin.outbound.sendText({ cfg, to: `argo-msgr:${CH}`, text: '복구된 답', accountId: 'default' });
  assert.equal(sent.at(-1)[0], 'sendMessage'); assert.equal(sent.at(-1)[1].chat_id, CH, '접두어를 벗긴 채널 id');
  assert.deepEqual(res.target, { kind: 'channel', id: CH });
});
