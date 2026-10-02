// 모듈 맞춤·쌓이는 모듈 고정 높이(유건 10/1 밤 6차 확정, 9차 줄 단위). 규칙마다 이유 한 줄. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitHeights, fitLayout } from '../src/core/fit.js';
import { share, layoutRows, placeRows, heightOf } from '../src/core/layout.js';
import { OFFICE_MODULES } from '../src/core/module-registry.js';

const GAP = 12;
const no = () => false;
const MIN = (ids) => Object.fromEntries(ids.map((id) => [id, 120]));
const row = (...cols) => cols.map(([w, ...ids]) => ({ w, ids }));

// 이유: 유건 예시 그대로 — 캘린더 480 옆 할 일 내용 150·결재 대기 내용 330 → 틈 12 빼고 468을 146·322로.
test('1:n — 1의 높이가 기준, n쪽은 내용 비율로 나누고 합(틈 포함)이 기준과 같다', () => {
  const h = fitHeights([row([12, 'cal'], [12, 'todo', 'appr'])], { cal: 480, todo: 150, appr: 330 }, MIN(['cal', 'todo', 'appr']), no, GAP);
  assert.deepEqual([h.get('cal'), h.get('todo'), h.get('appr')], [480, 146, 322]);
  assert.equal(h.get('todo') + GAP + h.get('appr'), h.get('cal'));
});

// 이유(유건 10/2): 늘려 둔 1은 줄이지 않고 n쪽이 거기에 맞춘다. 정한 높이가 내용보다 작아 스크롤바가 생기면 내용 높이까지.
test('1:n — 늘려 둔 1(사용자가 정한 높이)이 기준', () => {
  const rows = [row([12, 'cal'], [12, 'todo', 'appr'])], nat = { cal: 480, todo: 150, appr: 330 };
  const h = fitHeights(rows, nat, MIN(['cal', 'todo', 'appr']), no, GAP, { cal: 700 });
  assert.equal(h.get('cal'), 700);
  assert.equal(h.get('todo') + GAP + h.get('appr'), 700);
  assert.equal(fitHeights(rows, nat, MIN(['cal', 'todo', 'appr']), no, GAP, { cal: 300 }).get('cal'), 480);
});

// 이유: 모듈 최소 높이 밑으로는 줄이지 않는다 — n쪽 최소 합이 기준보다 크면 기준(1)이 늘어나 아래 끝이 맞는다.
test('1:n — 최소 높이를 지킨다', () => {
  const h = fitHeights([row([12, 'cal'], [12, 'a', 'b'])], { cal: 480, a: 20, b: 600 }, MIN(['cal', 'a', 'b']), no, GAP);
  assert.deepEqual([h.get('a'), h.get('b')], [120, 348]);
  const h2 = fitHeights([row([12, 'c'], [12, 'a', 'b'])], { c: 150, a: 50, b: 50 }, { c: 120, a: 160, b: 160 }, no, GAP);
  assert.deepEqual([h2.get('c'), h2.get('a'), h2.get('b')], [332, 160, 160]);
});

// 이유: 1:1(나란히 하나씩)은 둘 중 큰 내용 높이로 같이, n:m은 내용 합이 큰 열이 기준.
test('1:1·n:m', () => {
  const h = fitHeights([row([12, 'a'], [12, 'b'])], { a: 280, b: 410 }, MIN(['a', 'b']), no, GAP);
  assert.deepEqual([h.get('a'), h.get('b')], [410, 410]);
  const nm = fitHeights([row([12, 'a', 'b'], [12, 'c', 'd'])], { a: 200, b: 300, c: 100, d: 100 }, MIN(['a', 'b', 'c', 'd']), no, GAP);
  assert.deepEqual([nm.get('a'), nm.get('b'), nm.get('c'), nm.get('d')], [200, 300, 250, 250]);
});

// 이유: 한 줄을 다 쓰는 모듈은 내용 높이 — 쌓이지 않으면 정한 높이를 지워 내용대로, 쌓이는 모듈은 내용 높이를 정해 둔다(기본 고정 높이가 아니라).
test('전체 폭 줄 — 쌓이지 않으면 정한 높이 없음, 쌓이면 내용 높이', () => {
  const h = fitHeights([row([24, 'stats']), row([24, 'dec'])], { stats: 230, dec: 260 }, MIN(['stats', 'dec']), (id) => id === 'dec', GAP);
  assert.deepEqual([h.get('stats'), h.get('dec')], [null, 260]);
});

test('비율 나누기 — 정수, 합 보존', () => {
  assert.deepEqual(share(468, [150, 330], [0, 0]), [146, 322]);
  assert.deepEqual(share(100, [1, 1, 1], [0, 0, 0]), [34, 33, 33]);
  assert.equal(share(997, [3, 7, 11, 13], [120, 0, 0, 0]).reduce((a, b) => a + b), 997);
});

// ── 배치 전체 ──
const MODS = { stats: { sizes: ['l', 'full'] }, cal: { sizes: ['s', 'm', 'l', 'full'] }, todo: { sizes: ['s', 'm', 'l', 'full'], stack: 1 }, appr: { sizes: ['s', 'm', 'l', 'full'], stack: 1 } };
const modOf = (it) => MODS[it.id] ?? { sizes: ['s', 'm', 'l', 'full'] };
const ITEMS = [
  { id: 'stats', size: 'full', r: 0, c: 0, cw: 24, h: 184 },
  { id: 'cal', size: 's', r: 1, c: 0, cw: 8, cfg: { view: 'month' } },
  { id: 'todo', size: 'l', r: 1, c: 1, cw: 16 },
  { id: 'appr', size: 'l', r: 1, c: 1, cw: 16, h: 400 },
  { id: 'gone', size: 'm', hidden: true, h: 300 },
];
const STACK = new Set(['todo', 'appr']);
const NAT = { stats: 230, cal: 418, todo: 150, appr: 330 }, MINS = { stats: 120, cal: 248, todo: 120, appr: 120 };
const minOf = (id) => (id === 'stats' ? 16 : 6);
const cur = (it) => heightOf(it) || (STACK.has(it.id) ? 320 : NAT[it.id]);
const run = (items) => fitLayout(items, { rows: layoutRows(items.filter((it) => !it.hidden), cur, GAP, minOf), nat: NAT, min: MINS, stack: (id) => STACK.has(id), gap: GAP, modOf });

test('배치 맞춤 — 높이만 바뀌고 열·폭·cfg·숨김은 그대로, 줄마다 아래 끝이 맞는다', () => {
  const out = run(ITEMS), by = Object.fromEntries(out.map((it) => [it.id, it]));
  assert.equal('h' in by.stats, false); // 전체 폭 현황은 내용대로(스크롤바 없음)
  assert.deepEqual([by.cal.h, by.todo.h, by.appr.h], [418, 127, 279]); // 418 - 틈 12 = 406을 150:330으로
  assert.deepEqual([by.cal.r, by.cal.c, by.cal.cw, by.todo.c, by.todo.cw, by.cal.cfg.view], [1, 0, 8, 1, 16, 'month']);
  assert.deepEqual(out.at(-1), ITEMS.at(-1));
  const rows = layoutRows(out.filter((it) => !it.hidden), (it) => heightOf(it) || NAT[it.id], GAP, minOf), { pos } = placeRows(rows, (id) => heightOf(by[id]) || NAT[id], GAP);
  assert.equal(pos.get('cal').top + pos.get('cal').h, pos.get('appr').top + pos.get('appr').h);
});

// 이유: 맞춘 뒤 다시 눌러도 같은 결과 — 이미 맞아 있으면 저장하지 않는다(DB 쓰기 0).
test('멱등 — 두 번째는 저장할 것이 없다', () => {
  const once = run(ITEMS);
  assert.ok(once);
  assert.equal(run(once), null);
});

// 이유: 줄·열이 없는 옛 배치는 지금 모양으로 줄·열을 만든 뒤 맞춘다. 높이가 이미 맞으면 줄·열 필드만 생기는 것은 저장하지 않는다.
test('옛 배치 — 지금 모양으로 줄·열을 만들어 맞추고, 높이가 같으면 저장 0', () => {
  const old = [{ id: 'stats', size: 'full' }, { id: 'cal', size: 'm' }, { id: 'todo', size: 'm' }];
  const out = run(old);
  assert.deepEqual(out.map((it) => [it.id, it.r, it.c, it.cw]), [['stats', 0, 0, 24], ['cal', 1, 0, 12], ['todo', 1, 1, 12]]);
  assert.deepEqual([out[1].h, out[2].h], [418, 418]);
  assert.equal(run(out), null);
  assert.equal(run([{ id: 'stats', size: 'full' }]), null);
});

// ── 쌓이는 모듈은 고정 높이(규칙 7) ──
// 이유: 항목이 늘어나는 모듈만 등록부에 stack 표시 — 정한 높이가 없으면 고정 높이로 그린다(ModuleGrid 카드 class fixed-h + base.css). 현황·캘린더·업무 카드는 내용대로.
test('쌓이는 모듈 목록', () => {
  assert.deepEqual(OFFICE_MODULES.filter((m) => m.stack).map((m) => m.id).sort(), ['approvals', 'decisions', 'journal', 'mail', 'outputs', 'pages', 'todos', 'work']);
});
