// 할 일 저장소(core/tasks.js) 행동 — 조직 할 일을 한 저장소에 두고 개인 공간이 그것을 겹쳐 본다(10/4 분리 검수·재검수).
// core/tasks.js는 Vite 환경값을 읽는 supabase.js를 들여와 노드에서 바로 못 불러오므로, 가져오기 줄을 지우고 가짜 서버·로그인 상태를 넣어 그대로 실행한다(storage-scope.test.mjs와 같은 방식).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { refetchDue, keepResponse, makeDayClock } from '../src/core/refetch.js';
import { viewRows, taskOrgKeys } from '../src/core/task-model.js';

const TODAY = '2026-10-04';
function load({ failPeople = [] } = {}) {
  const ME = { id: 'u1', name: '나' };
  const SPACES = [{ key: 'me', kind: 'me', role: 'owner' }, { key: 'acme', id: 'org-1', kind: 'org', role: 'member' }, { key: 'beta', id: 'org-2', kind: 'org', role: 'member' }];
  const db = {
    null: [{ id: 'P1', assignee: 'u1', created_by: 'u1', due_on: TODAY, done_at: null }],
    'org-1': [{ id: 'X', assignee: 'u1', created_by: 'u2', due_on: TODAY, done_at: null }, { id: 'Y', assignee: 'u2', created_by: 'u1', due_on: TODAY, done_at: null }],
    'org-2': [{ id: 'Z', assignee: 'u1', created_by: 'u2', due_on: TODAY, done_at: null }],
  };
  const calls = [];
  const handle = (fn, args) => {
    calls.push(`${fn}:${args.p_org}`);
    if (fn === 'office_task_list') return { data: db[args.p_org].map((r) => ({ ...r })) };
    if (fn === 'office_org_people') return failPeople.includes(args.p_org) ? { error: { message: 'boom' } } : { data: [{ user_id: 'u1', name: '나' }, { user_id: 'u2', name: '동료' }] };
    if (fn === 'office_task_write') { const r = db[args.p_org].find((x) => x.id === args.p_data.id); if (args.p_action === 'task.done') r.done_at = '2026-10-04T03:00:00Z'; return { data: r }; }
    throw new Error(`unexpected ${fn}`);
  };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: ME.id }, access_token: 't' } } }) },
    rpc: (fn, args) => ({ setHeader: async () => handle(fn, args) }),
  };
  let tabReturn = null;
  const deps = {
    useEffect: (fn) => { fn(); }, useSyncExternalStore: (_subscribe, get) => get(),
    getClient: async () => client, ME, SPACES, useSession: () => 'signedIn', getMode: () => 'signedIn',
    refetchDue, onTabReturn: (fn) => { tabReturn = fn; }, keepResponse, makeDayClock, viewRows, taskOrgKeys,
  };
  const source = readFileSync(new URL('../src/core/tasks.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  const globals = { ...deps, module, exports: module.exports };
  new Function(...Object.keys(globals), transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(globals));
  return { tasks: module.exports, calls, SPACES, tabReturn: () => tabReturn() };
}
const ids = (rows) => (rows ?? []).map((r) => r.id).sort();

// 이유(10/4 분리 검수 MEDIUM): 조직 할 일 사본을 따로 들면 조직 화면에서 끝낸 일이 개인 공간 배지·챙길 것·할 일 화면에 옛 값으로 남았다 — 같은 저장소를 겹쳐 본다
test('조직 공간에서 끝낸 할 일이 개인 공간 행에 바로 반영된다', async () => {
  const { tasks } = load();
  await tasks.loadTasks('me'); await tasks.loadTasks('acme');
  assert.deepEqual(ids(tasks.useTaskRows('me')), ['P1', 'X'], '개인 공간 = 내 할 일 + 조직에서 나에게 맡겨진 일(Y는 남이 맡음)');
  await tasks.taskAction('acme', 'task.done', { id: 'X' }, { done_at: 'now' });
  assert.ok(tasks.useTaskRows('me').find((r) => r.id === 'X').done_at, '조직에서 끝냄 → 개인 공간 행도 끝냄');
  assert.equal(tasks.useTaskRows('me').find((r) => r.id === 'X').space, 'acme', '줄마다 어느 공간 것인지');
});

// 이유(10/4 재검수 LOW 1, DB 위생): 쓰기 뒤 다시 읽기마다 직원 목록까지 다시 받았다 — 받아 둔 직원 목록을 그대로 쓴다
test('쓰기 뒤 다시 읽기는 직원 목록을 다시 받지 않는다', async () => {
  const { tasks, calls } = load();
  await tasks.loadTasks('acme');
  await tasks.taskAction('acme', 'task.done', { id: 'X' });
  assert.deepEqual(calls.filter((c) => c.startsWith('office_org_people')), ['office_org_people:org-1']);
  assert.equal(calls.filter((c) => c === 'office_task_list:org-1').length, 2, '목록은 쓰기 뒤 다시 읽는다');
});

// 이유(10/4 재검수 LOW 2): 직원 목록만 못 읽어도 그 조직 할 일이 통째로 빠졌다 — 할 일은 보이고 직원 목록은 빈 목록
test('직원 목록 읽기가 실패해도 할 일은 남는다', async () => {
  const { tasks } = load({ failPeople: ['org-2'] });
  await tasks.loadTasks('me'); await tasks.loadTasks('beta');
  assert.deepEqual(ids(tasks.useTaskRows('me')), ['P1', 'Z']);
  assert.deepEqual(tasks.peopleIn('beta'), []);
});

// 이유(10/4 분리 검수 LOW 3·18차 LOW 8): 탭 복귀 때 개인 공간이 떠 있으면 지금 속한 조직 중 받아 둔 곳만 1분에 한 번까지 다시 읽는다 — 나간 조직은 읽지 않는다
test('탭 복귀: 개인 공간이 떠 있으면 지금 속한 조직만 다시 읽는다', async () => {
  const { tasks, calls, SPACES, tabReturn } = load();
  globalThis.document = { hidden: false };
  const realNow = Date.now;
  try {
    await tasks.loadTasks('me'); await tasks.loadTasks('acme'); await tasks.loadTasks('beta');
    tasks.useTaskRows('me', true); // 메뉴 배지처럼 개인 공간을 띄운다(useEffect를 바로 실행하는 가짜)
    SPACES.splice(SPACES.findIndex((s) => s.key === 'beta'), 1); // beta에서 나감
    calls.length = 0;
    tabReturn();
    assert.deepEqual(calls, [], '1분이 안 지났으면 읽지 않는다');
    const base = realNow(); Date.now = () => base + 61_000;
    tabReturn();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls.filter((c) => c.startsWith('office_task_list')).sort(), ['office_task_list:null', 'office_task_list:org-1']);
    assert.equal(calls.filter((c) => c.startsWith('office_org_people')).length, 0, '탭 복귀는 직원 목록을 다시 받지 않는다');
  } finally { Date.now = realNow; delete globalThis.document; }
});
