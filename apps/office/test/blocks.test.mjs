// 9차(유건 10/2) — 노션식 블록 배치(줄 → 열 → 위아래 모듈). 규칙마다 이유 한 줄. node --test test/*.test.mjs
// 앞 절반은 바꾸기 전에 잠근 인접 행동이다 — 블록 배치를 넣어도 그대로여야 한다(정규화·숨김·새 모듈·사본·저장본·옛 배치 화면·저장 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayout, freeOrder, pack, spanOf, heightOf, tOf, rowsOf } from '../src/core/layout.js';
import { normalizeModuleItems } from '../src/core/module-items.js';
import { normalizeDashboards } from '../src/business/dashboard-model.js';
import { LIBRARY_MODULES } from '../src/core/module-registry.js';
import { createModuleItem, addModuleItem } from '../src/core/module-placement-model.js';
import { capture, addPreset, presetsFor } from '../src/core/presets-model.js';

const REG = [
  { id: 'a', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me'] },
  { id: 'b', sizes: ['m', 'full'], defaultSize: 'full', spaces: ['me'] },
  { id: 'n', sizes: ['s', 'm'], defaultSize: 's', spaces: ['me'] },
  { id: 'top', sizes: ['full'], defaultSize: 'full', spaces: ['me'], intro: 'top' },
  { id: 'r', sizes: ['s', 'm'], defaultSize: 's', spaces: ['me'], repeatable: true },
];
const GAP = 12;
// 5400 예시 데이터에 유건님이 실제로 저장해 둔 7차 배치(t 포함, 10/2 화면에서 읽음) — 화면에서 잰 높이와 위치도 그때 값
const R7 = [
  { id: 'stats', moduleId: 'stats', size: 'full', x: 0, y: 0, t: 0, hidden: false },
  { id: 'calendar', moduleId: 'calendar', size: 's', span: 4, baseSize: 'm', h: 418, x: 0, y: 1, t: 227, hidden: false, cfg: { views: { view: 'month' } } },
  { id: 'todos', moduleId: 'todos', size: 'l', h: 253, x: 4, y: 2, t: 227, hidden: false },
  { id: 'mail', moduleId: 'mail', size: 'l', span: 8, baseSize: 'm', h: 153, x: 4, y: 3, t: 492, hidden: false },
  { id: 'work', moduleId: 'work', size: 'm', h: 324, x: 0, y: 4, t: 657, hidden: false },
  { id: 'approvals', moduleId: 'approvals', size: 'm', h: 324, x: 6, y: 5, t: 657, hidden: false },
  { id: 'pages', moduleId: 'pages', size: 'full', span: 12, baseSize: 's', h: 161, x: 0, y: 6, t: 993, hidden: false },
  { id: 'biz-orders', moduleId: 'biz-orders', size: 'm', hidden: true },
];
const R7_H = { stats: 215 }; // 높이를 정하지 않은 현황만 화면에서 잰 내용 높이
// 7차 화면(1126px 격자): 모듈마다 [시작 열(12열), 열 수, 위 끝 px] — 9차가 같은 모습이어야 한다
const R7_SCREEN = { stats: [0, 12, 0], calendar: [0, 4, 227], todos: [4, 8, 227], mail: [4, 8, 492], work: [0, 6, 657], approvals: [6, 6, 657], pages: [0, 12, 993] };

// ── 바꾸기 전에 잠근 인접 행동 ──

// 이유: 저장값 정규화(등록부 없는 모듈 버림·중복 id 버림·허용 크기 밖은 기본값·cfg·숨김 보존·새 모듈은 숨김으로 뒤에·도입 모듈은 맨 위)는 블록 배치에서도 그대로다.
test('잠금: 배치 병합 정규화 규칙', () => {
  const saved = { items: [{ id: 'gone', size: 'm' }, { id: 'b', size: 's', cfg: { k: 1 } }, { id: 'a', size: 'l', hidden: true }, { id: 'a', size: 'm' }, { id: 'r1', moduleId: 'r', size: 'm' }] };
  assert.deepEqual(mergeLayout(saved, REG, 'me', []), [
    { id: 'top', size: 'full', hidden: false },
    { id: 'b', size: 'full', hidden: false, cfg: { k: 1 } },
    { id: 'a', size: 'l', hidden: true },
    { id: 'r1', moduleId: 'r', size: 'm', hidden: false },
    { id: 'n', size: 's', hidden: true },
  ]);
});

// 이유: 저장값이 없으면 기본 배치 — 자리 정보(x·y·t·줄·열)가 하나도 없는 옛 배치로 그린다.
test('잠금: 기본 배치에는 자리 필드가 없다', () => {
  const home = mergeLayout(null, LIBRARY_MODULES, 'me', [{ id: 'stats', size: 'full' }, { id: 'calendar', size: 'm' }, { id: 'work', size: 'm' }]);
  assert.equal(home.some((it) => ['x', 'y', 't', 'r', 'c', 'cw'].some((k) => k in it)), false);
  assert.deepEqual(home.slice(0, 3).map((it) => [it.id, it.hidden]), [['stats', false], ['calendar', false], ['work', false]]);
});

// 이유(저장 0): 읽기만으로는 저장값이 바뀌지 않는다 — 7차 배치를 병합해도 필드가 더해지거나 빠지지 않는다(손대기 전 DB 쓰기 0의 전제).
test('잠금: 7차 배치를 읽어도 필드가 그대로', () => {
  const merged = mergeLayout({ items: R7 }, LIBRARY_MODULES, 'me', []);
  for (const it of R7) assert.deepEqual(merged.find((m) => m.id === it.id), it);
});

// 이유: 같은 모듈 여러 번(5차) — 사본은 맨 뒤에 붙고, 여러 번 놓을 수 없는 모듈은 숨긴 것을 그 자리에서 되살린다.
test('잠금: 사본은 뒤에, 한 번만 놓는 모듈은 되살리기', () => {
  const items = [{ id: 'calendar', moduleId: 'calendar', size: 'm', hidden: false }, { id: 'mail', moduleId: 'mail', size: 'm', hidden: true, x: 0, y: 1 }];
  const copy = createModuleItem('calendar', {}, () => 'cal-2');
  assert.deepEqual(addModuleItem(items, copy).map((it) => it.id), ['calendar', 'mail', 'cal-2']);
  assert.deepEqual(addModuleItem(items, createModuleItem('mail', {}, () => 'x')).map((it) => [it.id, it.hidden]), [['calendar', false], ['mail', false]]);
});

// 이유: 페이지 안 모듈·업무 대시보드 정규화는 모르는 필드를 지킨다 — 줄·열 필드(r·c·cw)도 그대로 지나가야 저장한 배치가 남는다.
test('잠금: 페이지 모듈·대시보드 정규화는 다른 필드를 지킨다', () => {
  assert.deepEqual(normalizeModuleItems([{ id: 'calendar', size: 'm', r: 1, c: 0, cw: 12 }])[0], { id: 'calendar', moduleId: 'calendar', size: 'm', r: 1, c: 0, cw: 12, hidden: false });
  const [d] = normalizeDashboards([{ id: 'd', name: 'D', widgets: [{ id: 'w', type: 'kpi', metric: 'sales', size: 's', r: 0, c: 1, cw: 8 }] }]);
  assert.deepEqual(d.widgets[0], { id: 'w', type: 'kpi', metric: 'sales', size: 's', r: 0, c: 1, cw: 8 });
});

// 이유(6차 저장본): 저장본은 배치 항목을 통째로 보관한다 — 새 필드(r·c·cw)도 되돌릴 때 그대로 돌아온다.
test('잠금: 저장본은 배치 항목을 통째로', () => {
  const home = [{ id: 'calendar', size: 'm', r: 0, c: 0, cw: 8, h: 480, cfg: { view: 'month' } }, { id: 'todos', size: 'm', r: 0, c: 1, cw: 16 }, { id: 'mail', size: 'm', hidden: true }];
  const { items } = addPreset([], capture({ space: 'me', name: 'p', home, display: {}, at: '2026-10-02T00:00:00Z' }));
  assert.deepEqual(presetsFor(items, 'me')[0].home, home);
});

// 이유(유건: 바꾼 직후 화면이 달라지면 안 된다): 7차 그리기 규칙으로 그 배치를 그리면 화면에서 읽은 자리와 같다 — 9차 변환이 맞춰야 할 기준.
test('잠금: 7차 배치의 7차 화면 자리', () => {
  const visible = R7.filter((it) => !it.hidden);
  const placed = pack(freeOrder(visible).map(({ it, x }) => ({ id: it.id, x, w: spanOf(it), h: heightOf(it) || R7_H[it.id], t: tOf(it) })), GAP);
  assert.deepEqual(Object.fromEntries(placed.map((b) => [b.id, [b.x, b.w, b.top]])), R7_SCREEN);
});

// 이유: 옛 배치(자리 없음)의 줄 나누기는 CSS 격자 자동 배치와 같다 — 9차가 줄을 만드는 기준.
test('잠금: 옛 배치 줄 나누기', () => {
  const home = mergeLayout(null, LIBRARY_MODULES, 'me', [{ id: 'stats', size: 'full' }, { id: 'approvals', size: 'm' }, { id: 'mail', size: 'm' }, { id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'calendar', size: 'm' }, { id: 'work', size: 'm' }]);
  assert.deepEqual(rowsOf(home.filter((it) => !it.hidden)).map((r) => r.map((it) => `${it.id}:${spanOf(it)}`)), [['stats:12'], ['approvals:6', 'mail:6'], ['todos:8', 'pages:4'], ['calendar:6', 'work:6']]);
});

// ── 9차 새 규칙 ──
import { layoutRows, placeRows, tidy, hasRC } from '../src/core/layout.js';
import { drop, flatTarget, stepTarget, resizeCols, equalize, settle, find } from '../src/core/block-move.js';

const MODS = Object.fromEntries(LIBRARY_MODULES.map((m) => [m.id, m]));
const modOf = (it) => MODS[it.moduleId ?? it.id] ?? { sizes: ['s', 'm', 'l', 'full'] };
const minOf = (id) => (id === 'stats' ? 16 : 6);
const ids = (rows) => rows.map((row) => row.map((col) => `${col.w}:${col.ids.join('+')}`).join(' | '));
const H = { stats: 215, calendar: 418, todos: 253, mail: 153, work: 324, approvals: 324, pages: 161, a: 100, b: 100, c: 100, d: 100, e: 100 };
const hOf = (it) => heightOf(it) || H[it.id] || 100;
const rowsOf9 = (items) => layoutRows(items.filter((it) => !it.hidden), hOf, GAP, minOf);
const screen = (items) => { const rows = rowsOf9(items), { pos } = placeRows(rows, (id) => hOf(items.find((it) => it.id === id)), GAP); return Object.fromEntries([...pos].map(([id, p]) => [id, [p.x / 2, p.w / 2, p.top]])); };

// 이유(유건: 바꾼 직후 화면이 달라지면 안 된다): 7차 배치(t 포함)는 세로로 겹치는 묶음 = 한 줄, 열 범위로 열을 나눠 같은 모습 — 캘린더 옆 할 일 + 메일이 한 열.
test('변환: 7차 배치는 7차 화면과 같은 자리', () => {
  assert.deepEqual(ids(rowsOf9(R7)), ['24:stats', '8:calendar | 16:todos+mail', '12:work | 12:approvals', '24:pages']);
  assert.deepEqual(screen(R7), R7_SCREEN);
});

// 이유: 5·6차 배치(x·y, t 없음)는 그때 규칙(세로 중력)으로 쌓은 모양, 옛 배치(자리 없음)는 CSS 격자 줄 그대로 — 모듈마다 한 열, 폭 = 열 수.
test('변환: 5·6차 배치·옛 배치', () => {
  const r6 = [{ id: 'stats', size: 'full', x: 0, y: 0 }, { id: 'calendar', size: 'm', h: 480, x: 0, y: 1 }, { id: 'todos', size: 'm', h: 232, x: 6, y: 2 }, { id: 'approvals', size: 'm', h: 236, x: 6, y: 3 }, { id: 'work', size: 'm', x: 0, y: 4 }];
  assert.deepEqual(ids(rowsOf9(r6)), ['24:stats', '12:calendar | 12:todos+approvals', '24:work']);
  const legacy = mergeLayout(null, LIBRARY_MODULES, 'me', [{ id: 'stats', size: 'full' }, { id: 'approvals', size: 'm' }, { id: 'mail', size: 'm' }, { id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'calendar', size: 'm' }, { id: 'work', size: 'm' }]);
  assert.deepEqual(ids(rowsOf9(legacy)), ['24:stats', '12:approvals | 12:mail', '16:todos | 8:pages', '12:calendar | 12:work']);
});

// 이유: 줄·열(r·c·cw)이 있으면 그대로 읽는다 — 열 안 위아래는 배열 순서, 줄·열이 없는 모듈(새로 넣은 것·사본)은 맨 아래 한 줄씩, 정수 0 이상만 자리로 읽는다.
test('읽기: 줄·열 그대로, 자리 없는 모듈은 맨 아래', () => {
  const items = [{ id: 'new', size: 'm' }, { id: 'b', size: 'm', r: 0, c: 1, cw: 16 }, { id: 'a', size: 'm', r: 0, c: 0, cw: 8 }, { id: 'c', size: 'm', r: 0, c: 1, cw: 16 }, { id: 'd', size: 'm', r: 3, c: 0, cw: 24 }];
  assert.deepEqual(ids(rowsOf9(items)), ['8:a | 16:b+c', '24:d', '24:new']);
  assert.equal(hasRC({ r: 1, c: 4 }), false); assert.equal(hasRC({ r: -1, c: 0 }), false); assert.equal(hasRC({ r: 0.5, c: 0 }), false);
  const merged = mergeLayout({ items: [{ id: 'a', size: 'm', r: 2, c: 1, cw: 30 }, { id: 'b', size: 'm', r: 1, c: 0, cw: 10 }] }, REG, 'me', []);
  assert.deepEqual(merged.slice(1, 3).map((it) => [it.id, it.r, it.c, it.cw]), [['a', 2, 1, undefined], ['b', 1, 0, 10]]);
});

// 이유(설계): 열이 하나 남은 줄은 전체 폭(모듈마다 한 줄), 한 줄 최대 4열(넘치면 아래 줄), 열 폭 합은 24이고 모듈 최소 폭 밑으로는 안 간다.
test('정리: 전체 폭·4열·최소 폭', () => {
  assert.deepEqual(ids(tidy([[{ w: 8, ids: ['a', 'b'] }, { w: 16, ids: [] }]], minOf)), ['24:a', '24:b']);
  assert.deepEqual(ids(tidy([[1, 1, 1, 1, 1].map((w, i) => ({ w, ids: ['abcde'[i]] }))], minOf)), ['6:a | 6:b | 6:c | 6:d', '24:e']);
  assert.deepEqual(ids(tidy([[{ w: 20, ids: ['stats'] }, { w: 4, ids: ['a'] }]], minOf)), ['18:stats | 6:a']);
});

const ROWS = tidy([[{ w: 24, ids: ['stats'] }], [{ w: 8, ids: ['calendar'] }, { w: 16, ids: ['todos', 'mail'] }], [{ w: 12, ids: ['work'] }, { w: 12, ids: ['approvals'] }], [{ w: 24, ids: ['pages'] }]], minOf);

// 이유(유건 10/2): 모듈 위·아래 절반에 놓으면 그 위·아래(열 안), 줄 사이에 놓으면 새 줄. 빈 열은 사라지고 열이 하나 남은 줄은 전체 폭이 된다.
test('놓기: 위아래·새 줄, 빈 열은 사라진다', () => {
  assert.deepEqual(ids(drop(ROWS, 'pages', { kind: 'col', anchor: 'mail', after: false }, minOf)), ['24:stats', '8:calendar | 16:todos+pages+mail', '12:work | 12:approvals']);
  assert.deepEqual(ids(drop(ROWS, 'approvals', { kind: 'row', anchor: 'stats', after: false }, minOf)), ['24:approvals', '24:stats', '8:calendar | 16:todos+mail', '24:work', '24:pages']);
  assert.deepEqual(ids(drop(ROWS, 'calendar', { kind: 'row', anchor: null, after: true }, minOf)), ['24:stats', '24:todos', '24:mail', '12:work | 12:approvals', '24:pages', '24:calendar']);
});

// 이유(유건 10/2): 모듈의 왼쪽·오른쪽 끝에 놓으면 열이 생긴다 — 캘린더 옆에 할 일 + 결재 대기를 위아래로. 한 줄 4열이면, 또는 최소 폭을 못 지키면 안 생긴다.
test('옆에 놓기: 새 열, 4열·최소 폭 제한', () => {
  const cal = tidy([[{ w: 24, ids: ['stats'] }], [{ w: 24, ids: ['calendar'] }], [{ w: 24, ids: ['todos'] }], [{ w: 24, ids: ['approvals'] }]], minOf);
  const one = drop(cal, 'todos', { kind: 'side', anchor: 'calendar', after: true }, minOf);
  assert.deepEqual(ids(one), ['24:stats', '12:calendar | 12:todos', '24:approvals']);
  const two = drop(one, 'approvals', { kind: 'col', anchor: 'todos', after: true }, minOf);
  assert.deepEqual(ids(two), ['24:stats', '12:calendar | 12:todos+approvals']);
  const four = tidy([['a', 'b', 'c', 'd'].map((id) => ({ w: 6, ids: [id] })), [{ w: 24, ids: ['e'] }]], minOf);
  assert.equal(drop(four, 'e', { kind: 'side', anchor: 'a', after: false }, minOf), null);
  assert.deepEqual(ids(drop(four, 'd', { kind: 'side', anchor: 'a', after: false }, minOf)), ['6:d | 6:a | 6:b | 6:c', '24:e']); // 같은 줄 안 열 순서는 4열이어도
  assert.deepEqual(ids(drop(cal, 'calendar', { kind: 'side', anchor: 'stats', after: true }, minOf)), ['16:stats | 8:calendar', '24:todos', '24:approvals']); // 현황은 16 밑으로 안 줄어든다
  const wide = (id) => (id === 'stats' ? 16 : id === 'outputs' ? 12 : 6);
  assert.equal(drop(tidy([[{ w: 24, ids: ['stats'] }], [{ w: 24, ids: ['outputs'] }]], wide), 'outputs', { kind: 'side', anchor: 'stats', after: true }, wide), null); // 16 + 12 > 24
});

// 이유: 같은 줄 안에서 열 순서만 바꾸면 폭은 원래대로, 자기 자리에 놓으면 아무것도 안 바뀐다(드래그 코드는 같은 결과면 선을 숨기고 저장하지 않는다).
test('놓기: 같은 줄 열 순서는 폭 유지, 자기 자리는 그대로', () => {
  const two = tidy([[{ w: 8, ids: ['calendar'] }, { w: 16, ids: ['todos'] }]], minOf);
  assert.deepEqual(ids(drop(two, 'todos', { kind: 'side', anchor: 'calendar', after: false }, minOf)), ['16:todos | 8:calendar']);
  assert.deepEqual(drop(two, 'todos', { kind: 'side', anchor: 'calendar', after: true }, minOf), two);
  assert.equal(drop(two, 'todos', { kind: 'col', anchor: 'todos', after: true }, minOf), null);
});

// 이유(유건 10/2): 키보드 ↑/↓ = 위아래 한 칸(열 안·줄 사이), ←/→ = 옆 열로 — 키보드만으로 캘린더 옆에 할 일 + 결재 대기를 쌓을 수 있다.
test('키보드: 위아래 한 칸·옆 열로', () => {
  let rows = tidy([[{ w: 24, ids: ['calendar'] }], [{ w: 24, ids: ['todos'] }], [{ w: 24, ids: ['approvals'] }]], minOf);
  const step = (id, key, pc) => { const tg = stepTarget(rows, id, key, pc); return tg && drop(rows, id, tg, minOf); };
  rows = step('todos', 'ArrowRight'); // 위 줄(캘린더) 옆 새 열
  assert.deepEqual(ids(rows), ['12:calendar | 12:todos', '24:approvals']);
  rows = step('approvals', 'ArrowUp', 1); // 위 줄의 기억한 열(1) 맨 아래로
  assert.deepEqual(ids(rows), ['12:calendar | 12:todos+approvals']);
  rows = step('approvals', 'ArrowUp'); // 열 안 한 칸 위
  assert.deepEqual(ids(rows), ['12:calendar | 12:approvals+todos']);
  rows = step('approvals', 'ArrowLeft'); // 옆 열(같은 높이 순서)
  assert.deepEqual(ids(rows), ['12:approvals+calendar | 12:todos']);
  assert.deepEqual(ids(step('approvals', 'ArrowUp')), ['24:approvals', '12:calendar | 12:todos']); // 열 맨 위 = 그 줄 위 새 줄
  assert.equal(stepTarget(tidy([[{ w: 24, ids: ['a'] }]], minOf), 'a', 'ArrowUp'), null); // 더 갈 곳 없음
});

// 이유: 좁은 폭(한 줄에 하나)은 순서만 — 같은 줄 두 모듈 사이면 앞 모듈의 열로(넓은 화면 모양을 지킨다), 줄 사이면 새 줄.
test('좁은 폭 놓기', () => {
  assert.deepEqual(flatTarget(ROWS, 'pages', 2), { kind: 'col', anchor: 'calendar', after: true });
  assert.deepEqual(flatTarget(ROWS, 'pages', 0), { kind: 'row', anchor: 'stats', after: false });
  assert.deepEqual(flatTarget(ROWS, 'stats', 6), { kind: 'row', anchor: 'pages', after: true });
});

// 이유(유건 10/2): 열 경계선을 끌면 두 열 폭만 나눈다(합 유지, 1/24 눈금, 최소 폭은 지킨다). 두 번 누르면 똑같이.
test('열 경계선: 합 유지·최소 폭·똑같이', () => {
  assert.deepEqual(ids(resizeCols(ROWS, 1, 1, 3, minOf)), ['24:stats', '11:calendar | 13:todos+mail', '12:work | 12:approvals', '24:pages']);
  assert.deepEqual(ids(resizeCols(ROWS, 1, 1, -9, minOf)).at(1), '6:calendar | 18:todos+mail');
  assert.deepEqual(ids(resizeCols(ROWS, 1, 1, 30, minOf)).at(1), '18:calendar | 6:todos+mail');
  assert.deepEqual(ids(equalize(ROWS, 1, minOf)).at(1), '12:calendar | 12:todos+mail');
  const three = tidy([[{ w: 4, ids: ['a'] }, { w: 10, ids: ['b'] }, { w: 10, ids: ['c'] }]], minOf);
  assert.deepEqual(ids(equalize(three, 0, minOf)), ['8:a | 8:b | 8:c']);
});

// 이유(옛 앱 호환): 저장은 줄·열(r·c·cw)을 더하고 옛 필드도 같이 쓴다 — span = 열 폭을 12열로 반올림, x = 열 시작, y = 줄→열→위아래 순서, t = 위 끝.
// 7차 앱이 그 값을 읽어 그리면 같은 모습이고, 9차가 다시 읽어도 같은 줄 목록이다. 숨긴 모듈은 뒤에, 줄·열은 지운다(되살리면 맨 아래).
test('저장: 줄·열 + 옛 필드, 다시 읽어도 같다', () => {
  const items = R7.map((it) => (it.id === 'pages' ? { ...it, hidden: true, r: 9, c: 0, cw: 24 } : it));
  const rows = rowsOf9(items), next = settle(items, rows, (id) => hOf(items.find((it) => it.id === id)), GAP, modOf);
  assert.deepEqual(next.map((it) => it.id), ['stats', 'calendar', 'todos', 'mail', 'work', 'approvals', 'pages', 'biz-orders']);
  const by = Object.fromEntries(next.map((it) => [it.id, it]));
  assert.deepEqual([by.calendar.r, by.calendar.c, by.calendar.cw, by.calendar.span, by.calendar.size, by.calendar.x, by.calendar.t], [1, 0, 8, 4, 's', 0, 227]);
  assert.deepEqual([by.mail.r, by.mail.c, by.mail.cw, by.mail.span, by.mail.x, by.mail.y, by.mail.t], [1, 1, 16, 8, 4, 3, 492]);
  assert.deepEqual([by.stats.span, by.stats.size, by.calendar.cfg.views.view, by.calendar.h], [undefined, 'full', 'month', 418]);
  assert.equal(['r', 'c', 'cw'].some((k) => k in by.pages), false);
  assert.deepEqual(ids(rowsOf9(next)), ['24:stats', '8:calendar | 16:todos+mail', '12:work | 12:approvals']);
  // 7차 앱이 그리는 자리(x·span·t)
  const merged = mergeLayout({ items: next }, LIBRARY_MODULES, 'me', []).filter((it) => !it.hidden);
  const old = pack(freeOrder(merged).map(({ it, x }) => ({ id: it.id, x, w: spanOf(it), h: hOf(it), t: tOf(it) })), GAP);
  assert.deepEqual(Object.fromEntries(old.map((b) => [b.id, [b.x, b.w, b.top]])), (({ pages, ...rest }) => rest)(R7_SCREEN));
});
