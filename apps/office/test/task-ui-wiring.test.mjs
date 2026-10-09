// 할 일 표·캘린더·칸반·할 일 패널·메뉴의 화면 연결(10/9 #906 검수) — 소스 글자를 찾지 않고, 진짜 화면 함수를 노드에서 그려(가짜 훅) 결과와 누른 뒤의 일을 본다.
// 묶는 방법은 test/helpers/src-bundle.mjs. 서버·직원 목록·알림은 가짜(globalThis.__T)로 두고, 판정·계획(model.js·cells.js)·사전은 진짜를 쓴다.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../src/views/model.js';
import { TASK_DICT } from '../src/pages/task-i18n.js';
import { VIEWS_DICT } from '../src/views/views-i18n.js';
import { bundleSrc, render, reset, flush, findAll, textOf, hasClass } from './helpers/src-bundle.mjs';

globalThis.localStorage = { getItem: (k) => (k === 'argo-lang' ? 'ko' : null), setItem() {}, removeItem() {} };
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.innerWidth = 1280; globalThis.innerHeight = 800;
const T = (globalThis.__T = { toasts: [], writes: [], menus: [], cats: {}, runWrites: async () => ({ ok: 1, failed: null }) });
const ko = (k, v = {}) => ({ ...TASK_DICT, ...VIEWS_DICT })[k][0].replace(/\{(\w+)\}/g, (_, n) => v[n]);

const STUB = {
  session: `export const ME = { id: 'u1', name: '나' };
    export const SPACES = [{ key: 'me', kind: 'me', role: 'owner' }, { key: 'acme', id: 'org-1', kind: 'org', role: 'member', name: '에이씨미' }, { key: 'boss', id: 'org-2', kind: 'org', role: 'owner', name: '보스' }];
    export const canManage = (k) => k === 'me' || k === 'boss'; export const useSession = () => 'signedIn'; export const getMode = () => 'signedIn'; export const nameIn = () => '나';`,
  overlay: 'export const showToast = (...a) => { globalThis.__T.toasts.push(a); }; export const Modal = () => null;',
  icon: 'export const Icon = ({ name, className }) => <i data-icon={name} className={className} />;',
  face: 'export const Face = () => null;',
  store: "export const getState = () => ({ crews: [] }); export const crewName = () => '';",
  data: `export const categoriesOf = (s) => globalThis.__T.cats[s] ?? [];
    export const runWrites = (w, s) => { globalThis.__T.writes.push(w); return globalThis.__T.runWrites(w, s); };
    export const useViewTasks = () => globalThis.__T.rows ?? []; export const usePeople = () => globalThis.__T.people; export const makeCtx = () => globalThis.__T.ctx;
    export const useTaskCategories = () => 0; export const loadTaskHistory = async () => []; export const readCfg = () => null; export const writeCfg = () => {};`,
  menu: `export const openMenu = (e, items) => { globalThis.__T.menus.push(items.filter(Boolean)); }; export const menuProps = () => ({}); export const closeMenu = () => {};
    export function mergeHandlers(...objs) { const out = {}; for (const o of objs) for (const [k, v] of Object.entries(o ?? {})) { const prev = out[k]; out[k] = typeof v === 'function' && typeof prev === 'function' ? (e) => { prev(e); v(e); } : v; } return out; }`,
  dnd: 'export const useDndMonitor = (h) => { globalThis.__T.drag = h; }; export const useDraggable = () => ({ setNodeRef() {}, attributes: {}, listeners: {}, isDragging: false }); export const useDroppable = () => ({ setNodeRef() {}, isOver: false });',
  router: "export const navigate = () => {}; export const useUrl = () => '/';",
  panel: 'export const Panel = ({ title, footer, children }) => <section data-title={title}>{footer}{children}</section>; export const Sheet = ({ children }) => <section>{children}</section>;',
};
const boardB = await bundleSrc({ board: 'views/Board.jsx', cells: 'views/TaskCells.jsx' }, { stubs: {
  'core/session.js': STUB.session, 'ui/Overlay.jsx': STUB.overlay, 'ui/Icon.jsx': STUB.icon, 'ui/Face.jsx': STUB.face, 'core/store.js': STUB.store, 'views/data.js': STUB.data,
  'ui/Menu.jsx': STUB.menu, '@dnd-kit/core': STUB.dnd, 'core/selection.js': 'export const useSelection = () => {}; export const selProps = () => ({});',
  'core/ui-state.js': 'export const setUi = () => {};', 'core/crew-items.js': "export const eventText = () => ''; export const spanText = () => ({}); export const assignSpace = () => null;",
  'views/NewTask.jsx': 'export const NewTask = () => null;', 'views/TaskPanel.jsx': 'export default function TaskPanel() { return null; }',
} });
const calB = await bundleSrc('calendar/Calendar.jsx', { stubs: {
  'core/session.js': STUB.session, 'core/router.jsx': STUB.router, 'core/store.js': STUB.store, 'ui/Overlay.jsx': STUB.overlay, 'ui/Panel.jsx': STUB.panel, 'ui/Menu.jsx': STUB.menu,
  'ui/Icon.jsx': STUB.icon, 'ui/Face.jsx': STUB.face, 'views/data.js': STUB.data,
  'calendar/api.js': 'export const useEvents = () => ({}); export const useEventWindows = () => ({}); export const writeEvent = async () => {}; export const loadPeople = async () => []; export const loadCustomers = async () => []; export const refreshEvents = async () => {};',
  'views/Board.jsx': 'export const ItemsView = () => null; export const useItemActions = () => ({}); export const filterMenu = () => []; export const filterCount = () => 0; export const Dropdown = () => null;',
} });
const panelB = await bundleSrc('views/TaskPanel.jsx', { stubs: {
  'core/session.js': STUB.session, 'core/router.jsx': STUB.router, 'core/commands.js': "export const baseOf = (s) => '/' + s;", 'ui/Panel.jsx': STUB.panel,
  'ui/Overlay.jsx': STUB.overlay, 'ui/Icon.jsx': STUB.icon, 'views/data.js': STUB.data,
} });
const menuB = await bundleSrc({ menu: 'ui/Menu.jsx', cells: 'views/TaskCells.jsx' }, { stubs: {
  'core/session.js': STUB.session, 'core/store.js': STUB.store, 'ui/Icon.jsx': STUB.icon, 'views/data.js': STUB.data,
} });
after(() => [boardB, calB, panelB, menuB].forEach((b) => b.dispose()));

const TODAY = '2026-10-09';
const ctx = { today: TODAY, me: 'u1', isAdmin: (s) => s === 'boss', members: (s) => (s === 'me' ? null : new Set(['u1', 'u2'])), categoryOf: () => null };
const people = { me: 'u1', name: (k) => (k === 'p:u1' ? '나' : '동료'), list: (k) => (k === 'me' ? [] : [{ user_id: 'u1', name: '나' }, { user_id: 'u2', name: '동료' }]), members: ctx.members };
const row = (over = {}) => ({ id: 'p1', title: '보고서', due_on: '2026-10-12', assignee: 'u1', created_by: 'u1', done_at: null, status: 'todo', priority: 2, category_id: null, category: null, starts_on: null, note: '', hold_reason: null, space: 'me', ...over });
const tk = (over) => V.taskItem(row(over));
const DONE = { done_at: '2026-10-08T03:00:00Z' };
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const buttons = (tree) => findAll(tree, (n) => n.type === 'button');
const cellActions = (over = {}) => ({ space: 'me', setCell: (...a) => T.cellCalls.push(a), busy: new Map(), ...over });
const cellTree = (TaskCell, it, cell, actions = cellActions()) => { reset(); return render(TaskCell, { it, cell, ctx, people, actions }); };
/** useItemActions를 그 화면처럼 불러 결과를 받는다 — 다시 그리면(again) 바뀐 상태(기다리는 칸 등)가 보인다 */
function actionsOf(board, props = { space: 'me', ctx, people, onOpen() {}, onNewEvent() {} }) {
  let A;
  const Probe = (p) => { A = board.useItemActions(p); return null; };
  reset(); render(Probe, props);
  return { get: () => A, again: () => { render(Probe, props); return A; } };
}

// 이유(검수 화면 연결): 바꿀 수 없는 칸을 단추로 그리면 눌러도 거절 알림만 뜬다 — 할 일 패널 잠금과 같은 규칙으로 글자만, 이유는 title과 화면 낭독기 글자(sr-only)로
test('표 칸: 끝낸 일의 중요도·분류·기한은 단추가 아니라 글자 — 이유는 title과 칸 안의 화면 낭독기 글자로', async () => {
  const { cells } = await boardB();
  const why = ko('views.why.done');
  for (const cell of ['priority', 'category', 'due_on']) {
    const tree = cellTree(cells.TaskCell, tk(DONE), cell);
    assert.equal(buttons(tree).length, 0, `${cell}: 단추 없음`);
    const box = findAll(tree, (n) => hasClass(n, 'tk-cell-text'))[0];
    assert.equal(box.props.title, why, `${cell}: 마우스를 올리면 이유`);
    assert.equal(textOf(findAll(box, (n) => hasClass(n, 'sr-only'))), `, ${why}`, `${cell}: 화면 낭독기도 같은 이유`);
  }
  const open = cellTree(cells.TaskCell, tk(), 'priority');
  assert.equal(buttons(open).length, 1, '바꿀 수 있는 칸은 단추');
  assert.equal(buttons(open)[0].props['aria-haspopup'], 'menu');
  assert.equal(findAll(open, (n) => hasClass(n, 'sr-only')).length, 0, '바꿀 수 있는 칸에는 잠금 이유가 없다');
});

// 이유(검수 화면 연결 — 분류 관리 공간 조건): 분류 관리는 보고 있는 공간의 분류만 연다(할 일 패널과 같다). 개인 공간에서 본 조직 할 일의 분류 칸에 '분류 관리'가 붙으면
// 다른 공간의 분류 관리 창(보고 있는 공간 것)이 열린다
test('표 분류 칸: 분류 관리는 보고 있는 공간의 할 일에만 — 개인 공간에서 본 조직 할 일에는 붙지 않는다', async () => {
  const { cells } = await boardB();
  const org = tk({ id: 'b1', space: 'boss' }), manageCats = () => {};
  T.cats = {};
  assert.equal(buttons(cellTree(cells.TaskCell, org, 'category', cellActions({ space: 'me', manageCats }))).length, 0, '분류 없는 조직 할 일 — 개인 공간에서는 고를 것이 없어 글자');
  const own = buttons(cellTree(cells.TaskCell, org, 'category', cellActions({ space: 'boss', manageCats })));
  assert.equal(own.length, 1, '그 조직 공간에서는 분류 관리로 열 수 있다');
  T.menus = []; own[0].props.onClick({ currentTarget: {} });
  assert.ok(T.menus.at(-1).some((x) => x.label === ko('task.manageCats')));
  T.cats = { boss: [{ id: 'c1', name: '영업' }, { id: 'c2', name: '세무' }] };
  const fromMe = buttons(cellTree(cells.TaskCell, org, 'category', cellActions({ space: 'me', manageCats })));
  T.menus = []; fromMe[0].props.onClick({ currentTarget: {} });
  assert.deepEqual(T.menus.at(-1).filter((x) => x.run).map((x) => x.label), [ko('task.uncategorized'), '영업', '세무'], '분류만, 분류 관리 없음');
  T.cats = {};
});

// 이유(검수 [끝낸 일의 상태 칸]): 쓰기 두 건(다시 열기 + 상태) 동안 칸이 그대로라 눌렸는지 알 수 없었다 — 고른 값을 기다림 표시로(칸반처럼)
test('표 상태 칸: 기다리는 칸은 고른 값 뱃지 + 기다림 표시, 다시 누를 단추는 없다', async () => {
  const { cells } = await boardB();
  const it = tk(DONE);
  const tree = cellTree(cells.TaskCell, it, 'status', cellActions({ busy: new Map([[it.key, { cell: 'status', value: 'doing' }]]) }));
  assert.equal(buttons(tree).length, 0);
  const box = findAll(tree, (n) => hasClass(n, 'tk-wait'))[0];
  assert.equal(box.props['aria-busy'], 'true');
  assert.equal(findAll(box, (n) => hasClass(n, 'st-doing')).length, 1, '고른 값(진행 중) 뱃지');
  assert.equal(textOf(findAll(box, (n) => hasClass(n, 'sr-only'))), ko('task.saving'));
  assert.equal(findAll(cellTree(cells.TaskCell, it, 'priority', cellActions({ busy: new Map([[it.key, { cell: 'status', value: 'doing' }]]) })), (n) => hasClass(n, 'tk-wait')).length, 0, '같은 줄 다른 칸은 그대로');
});

// 이유(검수 [끝낸 일의 상태 칸]): 기다림 표시는 쓰기가 두 건일 때만 켜고, 끝나면(실패해도) 끈다. 실패하면 오류를 알린다
test('setCell: 끝낸 일의 상태를 바꾸는 동안만 기다림, 끝나면 끄고 실패는 알린다(한 건 쓰기는 기다림 없음)', async () => {
  const { board } = await boardB();
  const P = actionsOf(board);
  let release;
  T.runWrites = () => new Promise((r) => { release = r; });
  T.toasts = []; T.writes = [];
  const it = tk(DONE);
  const run = P.get().setCell(it, 'status', 'doing');
  await settle();
  assert.deepEqual(T.writes.at(-1).map((w) => w.action), ['task.reopen', 'task.status']);
  assert.deepEqual(P.again().busy.get(it.key), { cell: 'status', value: 'doing' });
  release({ ok: 1, failed: 'task.error.request' }); await run;
  assert.equal(P.again().busy.size, 0, '끝나면 끈다');
  assert.ok(T.toasts.some(([msg]) => msg === TASK_DICT['task.error.request'][0]), '실패를 알린다');
  const one = P.get().setCell(tk(), 'priority', 1);
  await settle();
  assert.equal(P.again().busy.size, 0, '한 건 쓰기는 먼저 화면에 반영하므로 기다림 없음');
  release({ ok: 1, failed: null }); await one;
  T.runWrites = async () => ({ ok: 1, failed: null });
});

// 이유(검수 화면 연결 — check.can): 캘린더 칩의 ✓는 끝낼 수 있는 일(맡은 사람·관리자)에만 단추. 남이 맡은 일·일정이 단추가 되면 눌러도 거절된다
test('useItemActions check: 내 할 일만 끝내기 단추, 남이 맡은 일·일정은 아니다 — 누르면 끝내기 쓰기', async () => {
  const { board } = await boardB();
  const A = actionsOf(board).get();
  assert.equal(A.check.can(tk()), true);
  assert.equal(A.check.can(tk({ id: 'a1', space: 'acme', assignee: 'u2', created_by: 'u2' })), false, '남이 맡은 조직 할 일');
  assert.equal(A.check.can(V.eventItem({ key: 'e1', id: 'e1', title: '회의', start: Date.parse('2026-10-09T01:00:00Z'), end: Date.parse('2026-10-09T02:00:00Z'), can_edit: true })), false, '일정');
  T.writes = [];
  await A.check.run(tk());
  assert.deepEqual(T.writes.at(-1).map((w) => [w.action, w.data.id]), [['task.done', 'p1']]);
  await A.check.run(tk(DONE));
  assert.deepEqual(T.writes.at(-1).map((w) => w.action), ['task.reopen']);
});

// 이유(검수 화면 연결 — setCell의 상태 칸 조건): '보류했습니다 · 사유 적기'는 상태 칸에서 보류로 바꿀 때만. 다른 칸의 값이 우연히 'hold'(분류 id 등)여도 뜨지 않는다
test('setCell: 상태 칸에서 보류로 바꾸면 사유 적기 알림(누르면 패널 사유 칸), 다른 칸은 값이 hold여도 알림 없음', async () => {
  const { board } = await boardB();
  const P = actionsOf(board);
  T.toasts = [];
  await P.get().setCell(tk(), 'status', 'hold');
  const held = T.toasts.find(([msg]) => msg === ko('tasks.held'));
  assert.ok(held, '보류 알림');
  assert.equal(held[1].action.label, ko('tasks.addReason'));
  held[1].action.run();
  const dialog = P.again().dialogs;
  assert.deepEqual([dialog.props.children.props.id, dialog.props.children.props.focus], ['p1', 'reason'], '사유 적기 → 할 일 패널 보류 사유 칸');
  T.toasts = []; T.writes = [];
  T.cats = { me: [{ id: 'hold', name: '보류 분류' }] };
  await P.get().setCell(tk(), 'category', 'hold');
  assert.deepEqual(T.writes.at(-1).map((w) => w.action), ['task.category']);
  assert.equal(T.toasts.some(([msg]) => msg === ko('tasks.held')), false, '분류 칸은 보류 알림 없음');
  T.cats = {};
  T.toasts = [];
  await P.get().setCell(tk({ status: 'hold' }), 'status', 'hold');
  assert.equal(T.toasts.length, 0, '이미 보류면 쓰기도 알림도 없다');
});

// 이유(검수 [칸반 보류]): 카드를 보류 칸으로 끌어 놓아도 표·우클릭 메뉴와 같은 '보류했습니다 · 사유 적기'가 떠야 사유를 적으러 갈 수 있다
test('칸반: 보류 칸에 놓으면 사유 적기 알림, 진행 중 칸은 없음, 쓰기가 실패하면 오류만', async () => {
  const { board } = await boardB();
  const P = actionsOf(board);
  const A = P.get();
  const cfg = { view: 'kanban', group: 'status', sort: 'date', dir: 'asc', listGroup: 'none', filter: { kind: 'task', who: 'all', category: 'all', period: 'all', status: 'all', priority: 'all' } };
  const drop = async (it, col) => {
    reset(); render(board.ItemsView, { id: 'k', items: [it], cfg, setCfg() {}, views: V.VIEWS, today: TODAY, ctx, people, actions: A, onOpen() {}, tasks: true });
    T.toasts = []; T.writes = [];
    T.drag.onDragEnd({ active: { data: { current: { kind: 'vcard', group: 'k', key: it.key } } }, over: { data: { current: { kind: 'vcard', group: 'k', col } } } });
    await settle();
  };
  await drop(tk({ status: 'doing' }), 'hold');
  assert.deepEqual(T.writes.at(-1).map((w) => [w.action, w.data.status]), [['task.status', 'hold']]);
  const held = T.toasts.find(([msg]) => msg === ko('tasks.held'));
  assert.ok(held, '보류 알림');
  assert.equal(held[1].action.label, ko('tasks.addReason'));
  await drop(tk(), 'doing');
  assert.equal(T.toasts.length, 0, '진행 중 칸은 알림 없음');
  T.runWrites = async () => ({ ok: 0, failed: 'task.error.permission' });
  await drop(tk(), 'hold');
  assert.deepEqual(T.toasts.map(([m]) => m), [TASK_DICT['task.error.permission'][0]], '실패하면 오류만');
  T.runWrites = async () => ({ ok: 1, failed: null });
});

// 이유(검수 화면 연결 — Chip의 할 일 조건): 끝내기 ✓는 할 일 칩에만. 일정 칩에 ✓가 붙으면 일정에는 완료가 없어 누를 때 오류가 난다
test('캘린더 칩: 일정 칩에는 ✓ 단추가 없고, 할 일 칩은 끝낼 수 있을 때만 ✓ 단추(누르면 끝내기)', async () => {
  const cal = await calB();
  const ran = [], check = { can: () => true, run: (o) => ran.push(o.id) };
  const ev = { key: 'e1', kind: 'event', id: 'e1', title: '회의', start: Date.parse('2026-10-09T01:00:00Z'), end: Date.parse('2026-10-09T02:00:00Z'), all_day: false, category: '' };
  reset();
  assert.equal(findAll(render(cal.Chip, { o: ev, check, onOpen() {}, colorBy: 'category', bar: true }), (n) => n.props.role === 'checkbox').length, 0, '일정 칩');
  const o = { key: 't:x', kind: 'task', id: 'x', title: '보고서', done: false, vi: tk({ id: 'x' }) };
  reset();
  const box = findAll(render(cal.Chip, { o, check, onOpen() {}, bar: true }), (n) => n.props.role === 'checkbox');
  assert.equal(box.length, 1, '할 일 칩');
  box[0].props.onClick({ stopPropagation() {} });
  assert.deepEqual(ran, ['x']);
  reset();
  const view = render(cal.Chip, { o, check: { ...check, can: () => false }, onOpen() {}, bar: true });
  assert.equal(findAll(view, (n) => n.props.role === 'checkbox').length, 0, '끝낼 수 없으면 단추 없음');
  assert.equal(findAll(view, (n) => hasClass(n, 'cal-check-ico')).length, 1, '✓ 표시만');
});

// 이유(검수 화면 연결 — useGrow): 메모 칸은 9줄에서 시작해 글만큼 자란다(유건 10/9: 4줄쯤만 보이고 스크롤됐다). 패널이 그 높이를 실제로 칸에 넣는지 본다
test('할 일 패널 메모 칸: 그린 뒤 글 높이만큼 칸 높이를 정한다(9줄보다 짧으면 9줄)', async () => {
  const P = await panelB();
  globalThis.getComputedStyle = () => ({ lineHeight: '21px' });
  Object.assign(T, { rows: [row({ note: '긴 메모' })], people, ctx });
  for (const [scroll, want] of [[600, '602px'], [40, `${9 * 21 + 18}px`]]) {
    reset();
    const tree = render(P.default, { space: 'me', id: 'p1', taskSpace: 'me', onClose() {} });
    const note = findAll(tree, (n) => n.type === 'textarea' && hasClass(n, 'tk-note'))[0];
    const el = { style: {}, scrollHeight: scroll, clientWidth: 320, closest: () => null };
    note.props.ref.current = el;
    flush();
    assert.equal(el.style.height, want, `글 높이 ${scroll}px`);
  }
});

// 할 일 패널의 '분류 관리'도 같은 규칙 — 보고 있는 공간의 할 일에만(개인 공간에서 연 조직 할 일에는 없다)
test('할 일 패널: 분류 관리는 보고 있는 공간의 할 일에만', async () => {
  const P = await panelB();
  Object.assign(T, { rows: [row({ id: 'b1', space: 'boss' })], people, ctx });
  const manage = (space) => { reset(); return buttons(render(P.default, { space, id: 'b1', taskSpace: 'boss', onClose() {}, onManageCats() {} })).filter((b) => textOf(b).includes(ko('task.manageCats'))).length; };
  assert.equal(manage('me'), 0, '개인 공간에서 연 조직 할 일');
  assert.equal(manage('boss'), 1, '그 조직 공간');
});

// 이유(검수 [메뉴 강조]): 메뉴를 열면 강조가 지금 값이 아니라 맨 위에 갔다 — '낮음' 칸에서 ↓로 열고 ↓ Enter를 누르면 '보통'이 골라졌다.
// 진짜 표 칸 단추 → 진짜 메뉴 호스트로 그 순서를 그대로 해 본다
test('메뉴: 표 중요도 칸(낮음)을 ↓로 열면 낮음이 강조되고, Enter는 낮음 그대로·↓ Enter는 다음 값(맨 끝이면 처음)', async () => {
  const { menu, cells } = await menuB();
  const picked = [];
  const open = () => {
    reset();
    const btn = buttons(render(cells.TaskCell, { it: tk({ priority: 3 }), cell: 'priority', ctx, people, actions: cellActions({ setCell: (_it, _c, v) => picked.push(v) }) }))[0];
    const anchor = { getBoundingClientRect: () => ({ left: 10, right: 90, top: 10, bottom: 30 }) };
    btn.props.onKeyDown({ key: 'ArrowDown', currentTarget: anchor, nativeEvent: {}, preventDefault() {}, stopPropagation() {} });
    reset();
    const host = findAll(render(menu.MenuHost), (n) => n.props.role === 'menu')[0];
    host.props.ref.current = { offsetWidth: 160, offsetHeight: 120, focus() {} };
    flush();
    return () => findAll(render(menu.MenuHost), (n) => n.props.role === 'menu')[0];
  };
  const items = (host) => findAll(host, (n) => n.type === 'button');
  let host = open()();
  const on = items(host).filter((b) => hasClass(b, 'on'));
  assert.equal(on.length, 1);
  assert.equal(on[0].props['aria-checked'], true, '열자마자 강조 = 지금 값(낮음)');
  assert.equal(items(host).indexOf(on[0]), 2, '높음·보통·낮음 중 세 번째');
  host.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(picked, [3], 'Enter = 지금 값 그대로');
  const again = open();
  again().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  again().props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(picked, [3, 1], '↓ Enter = 낮음 다음(맨 끝이라 처음 값 높음)');
});

// 지금 값 표시가 없는 메뉴·동작 메뉴는 지금처럼 맨 위에서 — 우클릭 메뉴 중간의 '상태 바꾸기'나 켜 둔 '제한'에 강조가 가면 열자마자 Enter로 그것을 바꾼다
test('메뉴 강조 시작: 값 고르기 메뉴는 지금 값, 표시가 없거나 동작이 먼저인 메뉴는 맨 위(실제 메뉴 목록으로)', async () => {
  const { menu } = await menuB();
  const { board, cells } = await boardB();
  const A = actionsOf(board).get();
  const ctxMenu = A.single(tk({ status: 'doing' }));
  assert.ok(ctxMenu.some((x) => x.checked), '우클릭 메뉴에도 지금 상태 표시가 있다');
  assert.equal(menu.startIndex(ctxMenu), 0, '우클릭 메뉴는 맨 위(열기)');
  assert.equal(menu.startIndex(A.empty({ view: 'list' }, () => {}, ['list', 'kanban'])), 0, '빈 곳 메뉴(새 일정 먼저) — 맨 위');
  assert.equal(menu.startIndex(A.many([tk(), tk({ id: 'p2' })])), 1, '여러 개 메뉴(머리 다음 완료)');
  assert.equal(menu.startIndex([{ label: '열기', run() {} }, { sep: true }, { label: '제한', checked: true, run() {} }]), 0, '페이지 메뉴처럼 동작 뒤 켜짐 표시 — 맨 위');
  assert.equal(menu.startIndex([{ heading: '추가' }, { label: '매출', run() {} }, { label: '비용', run() {} }]), 1, '표시가 없는 메뉴 — 맨 위');
  const views = board.viewMenu({ view: 'kanban', group: 'who', sort: 'title', dir: 'asc' }, () => {}, V.VIEWS);
  assert.equal(views[menu.startIndex(views)].label, board.viewMenu({ view: 'kanban' }, () => {}, ['kanban'])[1].label, '보기 메뉴 — 지금 보기(칸반)');
  T.menus = [];
  reset(); buttons(render(board.Dropdown, { label: '정렬', value: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onChange() {} }))[0].props.onClick({ currentTarget: {} });
  assert.equal(menu.startIndex(T.menus.at(-1)), 1, '드롭다운 — 지금 값(B)');
  T.menus = [];
  buttons(cellTree(cells.TaskCell, tk({ status: 'hold' }), 'status'))[0].props.onClick({ currentTarget: {} });
  const st = T.menus.at(-1);
  assert.equal(st[menu.startIndex(st)].checked, true, '표 상태 칸 — 지금 상태(보류)');
});
