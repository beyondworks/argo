// 할 일 쓰기를 할 일 하나마다 한 줄로(10/9 #906 검수 — 동시 쓰기). core/tasks.js 저장소 + views/data.js runWrites를 그대로 묶고 서버만 가짜로 둔다.
// 가짜 서버는 쓰기 요청을 붙잡아 두고, 시험이 정한 차례로 성공·실패시킨다 — 실제로 서버에 늦게 닿거나 앞뒤가 바뀌는 경우를 만든다.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/views/model.js';
import * as C from '../src/views/cells.js';
import { bundleSrc } from './helpers/src-bundle.mjs';

const STUBS = {
  'core/supabase.js': 'export const getClient = async () => globalThis.__T.client; export const configured = true;',
  'core/session.js': `export const ME = (globalThis.__ME = { id: 'u1', name: '나' }); export const SPACES = [{ key: 'me', kind: 'me', role: 'owner' }, { key: 'acme', id: 'org-1', kind: 'org', role: 'owner' }];
    export const useSession = () => 'signedIn'; export const getMode = () => 'signedIn'; export const canManage = () => true; export const nameIn = () => '나';`,
  'calendar/api.js': 'export const writeEvent = async () => {}; export const refreshEvents = async () => {}; export const loadPeople = async () => [];',
  'calendar/shared.js': 'export const writableOrgs = () => []; export const idOf = (s) => s.id;',
  'data/calendar-sample.js': 'export const SAMPLE_TASKS = [], SAMPLE_TASK_CATEGORIES = {}; export const sampleTaskWrite = () => {}, sampleCategoryWrite = () => {}, sampleTaskHistory = () => [];',
  'core/store.js': "export const crewName = () => '';",
};
const load = await bundleSrc({ tasks: 'core/tasks.js', data: 'views/data.js' }, { stubs: STUBS });
after(() => load.dispose());

const TODAY = '2026-10-09';
const ctx = { today: TODAY, me: 'u1', isAdmin: () => true, members: () => null, categoryOf: () => null };
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

/** 가짜 서버 — 목록 읽기는 바로, 쓰기는 붙잡아 둔다(ok()·fail()로 끝낸다). log = 서버가 실제로 처리한 쓰기 차례 */
async function setup(row = {}) {
  const base = { title: '보고서', assignee: 'u1', created_by: 'u1', due_on: '2026-10-12', done_at: null, status: 'todo', priority: 2, category_id: null, starts_on: null, note: '', hold_reason: null };
  const db = [{ ...base, id: 'X', ...row }, { ...base, id: 'Y', title: '다른 일' }];
  const pending = [], log = [], calls = [];
  const apply = (action, d) => {
    const r = db.find((x) => x.id === d.id);
    if (action === 'task.done') r.done_at = '2026-10-09T03:00:00Z';
    else if (action === 'task.reopen') r.done_at = null;
    else for (const [k, v] of Object.entries(d)) if (k !== 'id' && k !== 'reason_only') r[k] = v;
  };
  const handle = (fn, args) => {
    calls.push(fn);
    if (fn === 'office_task_list') return Promise.resolve({ data: db.map((r) => ({ ...r })) });
    if (fn === 'office_org_people') return Promise.resolve({ data: [] });
    return new Promise((res) => {
      const p = { action: args.p_action, data: args.p_data };
      p.ok = () => { pending.splice(pending.indexOf(p), 1); log.push(p.action); apply(p.action, p.data); res({ data: null }); };
      p.fail = (message = 'boom') => { pending.splice(pending.indexOf(p), 1); res({ error: { message } }); };
      pending.push(p);
    });
  };
  if (globalThis.__ME) globalThis.__ME.id = 'u1';
  globalThis.__T = { client: { auth: { getSession: async () => ({ data: { session: { user: { id: globalThis.__ME?.id ?? 'u1' }, access_token: 't' } } }) }, rpc: (fn, args) => ({ setHeader: () => handle(fn, args) }) } };
  const { tasks, data } = await load();
  await tasks.loadTasks('acme');
  const shown = (id = 'X') => tasks.rowsIn('acme').find((r) => r.id === id);
  const item = (id = 'X') => V.taskItem({ ...shown(id), space: 'acme' });
  return { tasks, data, db, pending, log, calls, shown, item };
}

// 이유(검수 [동시 쓰기]): 같은 줄의 칸 두 개를 연달아 바꾸면 쓰기 두 건이 동시에 나가, 앞 요청이 실패하면 쓰기 전 목록으로 통째로 되돌려
// 그사이 성공한 뒤 요청의 값까지 화면에서 지웠다. 서버가 뒤 요청을 먼저 끝내는 가장 나쁜 차례로 끝내도 → 앞 칸만 되돌아가고 뒤 칸은 새 값으로 남는다
test('표: 상태(A)를 바꾼 뒤 중요도(B)를 바꿨는데 A가 실패하고 B가 성공하면 — A만 원래대로, B는 새 값', async () => {
  const s = await setup();
  const a = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'status', 'doing', ctx)));
  await settle();
  const b = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'priority', 1, ctx)));
  await settle();
  assert.deepEqual([s.shown().status, s.shown().priority], ['doing', 1], '둘 다 먼저 화면에');
  for (let i = 0; i < 10 && s.pending.length; i++) { // 뒤 요청(B)이 나가 있으면 그것부터 성공, 아니면 앞 요청(A)을 실패
    const B = s.pending.find((p) => p.action === 'task.priority');
    if (B) B.ok(); else s.pending.find((p) => p.action === 'task.status').fail();
    await settle();
  }
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.failed, 'task.error.request');
  assert.equal(rb.failed, null);
  assert.deepEqual([s.shown().status, s.shown().priority], ['todo', 1], '실패한 상태만 되돌아가고 성공한 중요도는 남는다');
  assert.deepEqual([s.db[0].status, s.db[0].priority], ['todo', 1], '화면 = 서버');
});

test('표: 같은 할 일의 쓰기는 앞 요청이 끝나야 다음 요청이 나간다(다른 할 일은 기다리지 않는다)', async () => {
  const s = await setup();
  const a = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'status', 'doing', ctx)));
  const b = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'priority', 1, ctx)));
  const y = s.data.runWrites(V.writesOf(C.planCell(s.item('Y'), 'priority', 3, ctx)));
  await settle();
  assert.deepEqual(s.pending.map((p) => [p.data.id, p.action]), [['X', 'task.status'], ['Y', 'task.priority']], 'X의 중요도 쓰기는 X의 상태 쓰기가 끝날 때까지 기다리고, Y는 바로 나간다');
  s.pending[0].ok(); await settle();
  assert.deepEqual(s.pending.map((p) => [p.data.id, p.action]), [['Y', 'task.priority'], ['X', 'task.priority']]);
  while (s.pending.length) { s.pending[0].ok(); await settle(); }
  await Promise.all([a, b, y]);
  assert.deepEqual(s.log, ['task.status', 'task.priority', 'task.priority']);
});

// 이유(검수 [동시 쓰기]): 캘린더 ✓를 빠르게 두 번 누르면 끝내기·다시 열기가 동시에 나가 서버 도착 순서로 결과가 정해졌다.
// 서버가 늦게 보낸 요청을 먼저 처리하는 차례로 끝내도 → 끝내기 → 다시 열기 순서로 하나씩 나가고 마지막 누름(열림)이 남는다
test('캘린더 ✓ 두 번: 끝내기 → 다시 열기 순서로 하나씩 나가고, 최종 상태는 마지막 누름과 같다', async () => {
  const s = await setup();
  const one = s.data.runWrites(V.writesOf(C.toggleDone(s.item(), ctx)));
  await settle();
  assert.equal(s.item().done, true, '첫 누름은 바로 끝낸 것으로 보인다');
  const two = s.data.runWrites(V.writesOf(C.toggleDone(s.item(), ctx)));
  await settle();
  assert.equal(s.item().done, false, '두 번째 누름은 바로 다시 연 것으로 보인다');
  assert.deepEqual(s.pending.map((p) => p.action), ['task.done'], '다시 열기는 끝내기가 끝날 때까지 기다린다');
  for (let i = 0; i < 10 && s.pending.length; i++) { s.pending.at(-1).ok(); await settle(); } // 나가 있는 것 중 늦게 보낸 것부터 처리
  await Promise.all([one, two]);
  assert.deepEqual(s.log, ['task.done', 'task.reopen'], '서버 처리 차례 = 누른 차례');
  assert.equal(s.db[0].done_at, null, '서버: 열림(마지막 누름)');
  assert.equal(s.shown().done_at, null, '화면도 열림');
});

// 같은 칸을 연달아 두 번 바꿨는데 둘 다 실패 — 앞 쓰기가 실패할 때 되돌릴 값(쓰기 전 값)을 뒤 쓰기가 넘겨받아, 마지막에 서버 값으로 돌아간다
test('같은 칸을 두 번 바꿨는데 둘 다 실패하면 서버 값(처음 값)으로 돌아간다', async () => {
  const s = await setup();
  const a = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'priority', 1, ctx)));
  await settle();
  const b = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'priority', 3, ctx)));
  await settle();
  assert.equal(s.shown().priority, 3);
  for (let i = 0; i < 10 && s.pending.length; i++) { s.pending[0].fail(); await settle(); }
  await Promise.all([a, b]);
  assert.equal(s.shown().priority, 2);
});

// 앞 쓰기가 성공해 목록을 다시 읽었는데 뒤 쓰기는 아직 서버에 닿지 않았다 — 다시 읽은 목록이 뒤 쓰기의 값을 지우지 않는다(그 쓰기가 끝날 때까지 얹어 둔다)
test('앞 쓰기 뒤 다시 읽은 목록에도 아직 안 끝난 뒤 쓰기의 값이 남는다', async () => {
  const s = await setup();
  const a = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'status', 'doing', ctx)));
  await settle();
  const b = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'priority', 1, ctx)));
  await settle();
  s.pending.find((p) => p.action === 'task.status').ok();
  await a;
  assert.equal(s.db[0].priority, 2, '서버에는 아직 중요도가 없다');
  assert.deepEqual([s.shown().status, s.shown().priority], ['doing', 1], '다시 읽은 목록 위에 기다리는 중요도');
  for (let i = 0; i < 10 && s.pending.length; i++) { s.pending[0].ok(); await settle(); }
  await b;
  assert.deepEqual([s.shown().status, s.shown().priority], ['doing', 1]);
});

// 이유(검수 [끝낸 일의 상태 칸]): 끝낸 일의 상태를 다른 값으로 고르면 쓰기 두 건(다시 열기 + 상태)이 나간다. 두 번째가 실패하면
// 오류를 돌려주고, 목록을 다시 읽어 화면이 실제 서버 상태(다시 열린 상태, 상태는 그대로)와 같아야 한다. 다시 읽기는 끝에 한 번
test('끝낸 일 → 진행 중: 다시 열기는 성공하고 상태 쓰기가 실패하면 오류를 돌려주고 화면은 서버(다시 열림·상태 그대로)와 같다', async () => {
  const s = await setup({ done_at: '2026-10-08T03:00:00Z', status: 'todo' });
  const plan = C.planCell(s.item(), 'status', 'doing', ctx);
  assert.deepEqual(V.writesOf(plan).map((w) => w.action), ['task.reopen', 'task.status']);
  const before = s.calls.filter((c) => c === 'office_task_list').length;
  const run = s.data.runWrites(V.writesOf(plan));
  await settle();
  assert.ok(s.shown().done_at, '두 건 쓰기는 먼저 화면에 반영하지 않는다(그동안은 칸의 기다림 표시)');
  s.pending[0].ok(); await settle();
  s.pending[0].fail('boom');
  const r = await run;
  assert.deepEqual(r, { ok: 1, failed: 'task.error.request' });
  assert.deepEqual([s.shown().done_at, s.shown().status], [null, 'todo'], '화면 = 서버: 다시 열렸고 상태는 그대로');
  assert.deepEqual([s.db[0].done_at, s.db[0].status], [null, 'todo']);
  assert.equal(s.calls.filter((c) => c === 'office_task_list').length - before, 1, '목록 다시 읽기는 끝에 한 번');
});

// 이유(10/8 검수, 10/9부터 공용 줄): 할 일 패널에서 보류 사유 칸을 벗어나며 저장하는 것과 상태 단추가 겹치면, 뒤 쓰기가 먼저 서버에 닿아 상태가 되돌아갈 수 있었다.
// 패널은 이제 표·캘린더·칸반과 같은 줄(core/tasks.js)을 쓴다 — 사유 쓰기가 끝난 뒤에 상태 쓰기가 나가고, 사유가 실패해도 상태 쓰기는 나간다
test('할 일 패널: 보류 사유 저장 뒤 상태 단추 — 사유 쓰기가 끝나야 상태 쓰기가 나가고, 사유가 실패해도 상태는 나간다', async () => {
  const s = await setup({ status: 'hold', hold_reason: null });
  const reason = s.data.runWrites(V.writesOf(V.planHoldReason(s.item(), '거래처 회신 기다림', ctx)));
  const status = s.data.runWrites(V.writesOf(V.planStatus(s.item(), 'doing', ctx)));
  await settle();
  assert.deepEqual(s.pending.map((p) => [p.action, p.data.reason_only ?? false]), [['task.status', true]], '상태 쓰기는 사유 쓰기가 끝날 때까지 기다린다');
  s.pending[0].fail('task_conflict'); await settle();
  assert.deepEqual(s.pending.map((p) => [p.action, p.data.status]), [['task.status', 'doing']], '사유가 실패해도 상태 쓰기는 나간다');
  s.pending[0].ok();
  assert.equal((await reason).failed, 'task.error.conflict');
  assert.equal((await status).failed, null);
  assert.deepEqual([s.shown().status, s.shown().hold_reason], ['doing', null], '화면 = 서버');
});

// 이유(#906 재검수 MEDIUM): 쓰기가 성공한 뒤 다시 읽어도 내 자국이 다시 읽은 목록에 얹힌 채 남아, 서버 값(끝낸 시각)이나 그사이 다른 기기가 바꾼 값이 다음 읽기까지 가려졌다
test('쓰기 성공 뒤 다시 읽은 화면은 서버 값 — 내 시각·내 값으로 덮지 않는다', async () => {
  const s = await setup();
  const done = s.data.runWrites(V.writesOf(V.planDone(s.item(), true, ctx)));
  await settle();
  s.pending[0].ok(); await done; await settle();
  assert.equal(s.shown().done_at, '2026-10-09T03:00:00Z', '끝낸 시각은 서버 값');
  const pr = s.data.runWrites(V.writesOf(C.planCell(s.item('Y'), 'priority', 1, ctx)));
  await settle();
  s.pending[0].ok(); s.db[1].priority = 3; // 서버 반영 직후 다른 기기가 같은 칸을 3으로
  await pr; await settle();
  assert.equal(s.shown('Y').priority, 3, '다시 읽은 서버 값');
});

// 이유(#906 재검수 LOW 3): 줄에서 기다리던 쓰기가 계정을 바꾼 뒤 새 계정 세션으로 나갔다 — 누른 때의 계정과 다르면 버린다
test('줄에서 기다리는 사이 계정을 바꾸면 그 쓰기는 나가지 않는다', async () => {
  const s = await setup();
  const a = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'status', 'doing', ctx)));
  const b = s.data.runWrites(V.writesOf(C.planCell(s.item(), 'priority', 1, ctx)));
  await settle();
  globalThis.__ME.id = 'u2';
  s.pending[0].ok(); await settle();
  assert.equal(s.pending.length, 0, '두 번째 쓰기는 나가지 않았다');
  assert.equal((await b).failed, 'task.error.signin');
  await a;
  globalThis.__ME.id = 'u1';
});
