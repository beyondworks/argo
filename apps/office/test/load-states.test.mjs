// 10/5 읽기 실패·불러오는 중 상태(OFC-04·06·08·09·10·15·파일 한도) — 실패를 '비어 있음·정상'으로 보이지 않게, 다시 시도할 길을 둔다.
// pull.js·tasks.js는 Vite 환경값을 읽는 모듈을 들여와 노드에서 바로 못 불러오므로, 가져오기 줄을 지우고 가짜를 넣어 그대로 실행한다(page-reload·task-store 테스트와 같은 방식).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { refetchDue, keepResponse, makeDayClock } from '../src/core/refetch.js';
import { viewRows, taskOrgKeys } from '../src/core/task-model.js';
import { mapBoard } from '../src/core/board.js';
import * as V from '../src/views/model.js';
import * as FM from '../src/files/model.js';

const run = (file, deps) => {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  new Function(...Object.keys(deps), 'module', 'exports', transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(deps), module, module.exports);
  return module.exports;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 가짜 질의 — 어떤 체인이든 받아 표마다 정한 응답으로 끝난다 */
const fakeSb = (answer) => {
  const q = (table) => { const it = { then: (ok, no) => Promise.resolve(answer(table)).then(ok, no), maybeSingle: async () => answer(table) }; for (const m of ['select', 'eq', 'in', 'is', 'not', 'or', 'order', 'limit', 'like', 'gte']) it[m] = () => it; return it; };
  return { from: q, rpc: (fn) => q(`rpc:${fn}`) };
};
const pullWith = (answer, state = { pages: [{ id: 'p', title: 't' }] }) => run('core/pull.js', {
  getStorageScope: () => 'alice', ME: { id: 'alice' }, SPACES: [{ key: 'acme', id: 'o1', kind: 'org', role: 'member' }], getClient: async () => fakeSb(answer),
  getState: () => state, update: (fn) => Object.assign(state, fn(state)), outbox: { has: () => false }, mergePages() {}, mapBoard, decidableSet: () => new Set(),
});

// 이유(OFC-06): 본문 읽기 실패·없는 페이지가 조용히 끝나 회색 자리(스켈레톤)만 계속 보였다 — 실패는 실패로 던지고, 없음은 null로 나눈다
test('OFC-06: 페이지 본문 — 읽기 실패는 던지고, 없는 페이지는 null', async () => {
  const fail = pullWith((t) => (t === 'rpc:office_page_access' ? { data: 'edit' } : { data: null, error: { message: 'boom' } }));
  await assert.rejects(fail.loadPageContent('p'), (e) => e.message === 'boom');
  const gone = pullWith((t) => (t === 'rpc:office_page_access' ? { data: 'edit' } : { data: null, error: null }));
  assert.equal(await gone.loadPageContent('p'), null);
});

// 이유(OFC-08): 기록판 읽기 실패가 console.warn만 남아 홈 현황이 '결재 대기 없음·정상·모두 확인'으로 보였다 — 실패를 상태로 남기고, 성공하면 지운다
test('OFC-08: 기록판 읽기 실패는 boardError로 남고, 다시 읽어 성공하면 지운다', async () => {
  let failing = true;
  const state = {};
  const pull = pullWith((t) => (failing && t === 'msgr_work_runs' ? { data: null, error: { message: 'down' } } : { data: [], error: null }), state);
  await assert.rejects(pull.pullBoard(), (e) => e.message === 'down');
  assert.ok(state.boardError > 0, '실패 시각이 남는다');
  failing = false;
  await pull.pullBoard();
  assert.equal(state.boardError, null);
});

/** tasks.js — office_task_list가 실패하거나 성공하게 */
function tasksWith(list) {
  let tabReturn = null;
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' }, access_token: 't' } } }) }, rpc: (fn, args) => ({ setHeader: async () => (fn === 'office_task_list' ? list(args) : { data: [] }) }) };
  const tasks = run('core/tasks.js', { useEffect: (fn) => fn(), useSyncExternalStore: (_s, get) => get(), getClient: async () => client, ME: { id: 'u1' }, SPACES: [{ key: 'me', kind: 'me' }],
    useSession: () => 'signedIn', getMode: () => 'signedIn', refetchDue, onTabReturn: (fn) => { tabReturn = fn; }, keepResponse, makeDayClock, viewRows, taskOrgKeys });
  return { tasks, tabReturn: () => tabReturn() };
}

// 이유(OFC-04·08): 할 일 읽기 실패가 '저장하지 못했습니다'(쓰기 문구)로 보였고, 처음 읽기에 실패한 화면은 탭에 돌아와도 다시 읽지 않았다
test('OFC-04: 할 일 읽기 실패는 읽기 문구, 탭 복귀 때 다시 읽어 살아난다', async () => {
  let ok = false;
  globalThis.document ??= { hidden: false };
  const { tasks, tabReturn } = tasksWith(async () => (ok ? { data: [{ id: 'a' }] } : { data: null, error: { message: 'fetch failed' } }));
  tasks.useTasks('me'); await tick(); await tick();
  assert.equal(tasks.useTasks('me').error, 'load.readFail');
  assert.deepEqual([tasks.readError?.({ message: 'task_signin' }), tasks.readError?.({ message: 'x' })], ['task.error.signin', 'load.readFail'], '권한·로그인 같은 사유는 그대로');
  ok = true; tabReturn(); await tick(); await tick();
  assert.deepEqual(tasks.useTasks('me').rows?.map((r) => r.id), ['a']);
});

test('OFC-04: 할 일 화면 읽기 상태 — 받기 전 = 불러오는 중, 실패 = 오류(받아 둔 것이 없을 때만)', async () => {
  const { taskLoad } = await import('../src/core/task-model.js');
  assert.ok(taskLoad, 'taskLoad가 있어야 한다');
  assert.deepEqual(taskLoad({}, null), { waiting: true, failed: null, retry: null });
  assert.deepEqual(taskLoad({ error: 'load.readFail' }, null), { waiting: false, failed: 'load.readFail', retry: null });
  assert.deepEqual(taskLoad({ rows: [], error: 'load.readFail' }, null), { waiting: false, failed: null, retry: null }, '받아 둔 목록이 있으면 그 목록을 보인다');
});

// 이유(OFC-15): 홈 '챙길 것'에서 ?due로 들어와 정렬만 바꿔도 임시 거르기가 저장돼, 다음에 메뉴로 열면 할 일 대부분이 숨었다
test('OFC-15: 임시 거르기는 저장하지 않고, 사람이 거르기를 바꿀 때만 저장한다', () => {
  const BASE = { view: 'list', group: 'status', sort: 'date', dir: 'asc', listGroup: 'none', filter: { kind: 'task' } };
  const views = ['list', 'kanban', 'table'];
  const saved = V.normalizeCfg({}, BASE, views), temp = V.dueFilter(saved.filter, 'overdue', 'u1');
  assert.ok(V.patchCfg, 'patchCfg가 있어야 한다');
  const sorted = V.patchCfg(saved, temp, { sort: 'date', dir: 'desc' }, { base: BASE, views, fixed: { kind: 'task' } });
  assert.deepEqual([sorted.saved.dir, sorted.saved.filter.period, sorted.saved.filter.who, sorted.temp], ['desc', 'all', 'all', temp], '정렬만 바꾸면 저장값에 임시 거르기가 섞이지 않는다');
  assert.equal(V.shownCfg(sorted.saved, sorted.temp, BASE, views).filter.period, 'overdue', '화면은 여전히 임시 거르기');
  const filtered = V.patchCfg(sorted.saved, sorted.temp, { filter: { ...temp, status: 'all' } }, { base: BASE, views, fixed: { kind: 'task' } });
  assert.deepEqual([filtered.saved.filter.period, filtered.saved.filter.status, filtered.temp], ['overdue', 'all', null], '거르기를 고치면 그 거르기가 저장되고 임시는 끝');
});

// 이유(OFC-10): 업무에서 만든 거래처가 새로고침 전까지 문서함·일정 목록에 없었다 — 거래처 쓰기에 성공하면 사건을 보내고, 받는 쪽은 캐시만 비운다
test('OFC-10: 거래처 쓰기 성공 → office:biz-written(동작 이름) → 거래처를 바꾼 쓰기에만 반응', async () => {
  const bus = new EventTarget();
  const prev = { add: globalThis.addEventListener, send: globalThis.dispatchEvent };
  globalThis.addEventListener = bus.addEventListener.bind(bus); globalThis.dispatchEvent = bus.dispatchEvent.bind(bus);
  try {
    const { onCustomersChanged } = await import('../src/core/biz-events.js');
    let n = 0; onCustomersChanged(() => { n++; });
    const model = await import('../src/business/deal-model.js').catch(() => ({}));
    const biz = run('business/data.js', { validateFilters: model.validateFilters ?? ((f) => f) });
    const journal = new Map();
    const client = biz.createBusinessClient({ client: async () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'a' }, access_token: 't' } } }) }, rpc: () => ({ setHeader: async () => ({ data: {}, error: null }) }) }),
      scope: () => ({ uid: 'a', org: null }), journal: { getItem: (k) => journal.get(k), setItem: (k, v) => journal.set(k, v), removeItem: (k) => journal.delete(k) }, key: () => 'k' });
    await client.mutate('customer.save', { name: '새 거래처' });
    await client.mutate('settings.save', {});
    assert.equal(n, 1, '거래처 쓰기에만 한 번');
  } finally { globalThis.addEventListener = prev.add; globalThis.dispatchEvent = prev.send; }
});

// 이유(파일 한도 문구 불일치): 화면 검사는 50MB, 서버 Free 한도는 25MB — 25~50MB 파일이 화면을 지나 서버에서 거절됐다
test('파일 한도: 지금 쓸 수 있는 한도(서버 Free 25MB)로 먼저 거절한다', () => {
  assert.equal(FM.uploadCheck({ name: 'a.pdf', size: 30 * 1024 * 1024, type: 'application/pdf' }), 'tooBig');
  assert.equal(FM.uploadCheck({ name: 'a.pdf', size: 25 * 1024 * 1024, type: 'application/pdf' }), null);
});
