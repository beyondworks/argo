// 모듈 크기 — 가장자리 끌기(유건 10/1 확정). 규칙마다 이유 한 줄. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeLayout, rowsOf, rowInfo, spanOf, heightOf, spanRange, sizeForSpan, minHeight } from '../src/core/layout.js';
import { dragSpans, snapH, applySizes, resetSize, resetPatch } from '../src/core/module-size.js';
import { normalizeModuleItems } from '../src/core/module-items.js';
import { normalizeDashboards, defaultDashboard } from '../src/business/dashboard-model.js';
import { OFFICE_MODULES, CHART_MODULES } from '../src/core/module-registry.js';

const ALL = ['s', 'm', 'l', 'full'];
const mod = (sizes = ALL, defaultSize = 'm') => ({ sizes, defaultSize });
const modOf = (item) => (item.id === 'stats' ? mod(['l', 'full'], 'full') : mod());

// 이유: 폭은 12열 격자의 열 단위(1열씩), 최소 3열 — 단 등록부가 작은 단계를 허용하지 않는 모듈은 그 단계보다 작아지지 않는다(현황은 8열 이상).
test('열 범위: 1/3을 허용하면 3~12열, 아니면 가장 작은 단계부터', () => {
  assert.deepEqual(spanRange(ALL), [3, 12]);
  assert.deepEqual(spanRange(['l', 'full']), [8, 12]);
  assert.deepEqual(spanRange(['m', 'l', 'full']), [6, 12]);
  assert.deepEqual(spanRange(OFFICE_MODULES.find((m) => m.id === 'stats').sizes), [8, 12]);
});

// 이유: 옛 배치(size만)와 새 배치(span)를 같은 규칙으로 읽는다 — 잘못된 값은 단계로 돌아간다.
test('열 수·높이 읽기: span이 있으면 span, 없거나 잘못되면 단계, 높이는 120~1200 정수만', () => {
  assert.equal(spanOf({ size: 'm' }), 6);
  assert.equal(spanOf({ size: 'm', span: 7 }), 7);
  for (const span of [0, 13, 6.5, '7', null]) assert.equal(spanOf({ size: 'l', span }), 8);
  assert.equal(heightOf({ h: 360 }), 360);
  for (const h of [undefined, 119, 1201, 300.5, '300']) assert.equal(heightOf({ h }), 0);
});

// 이유: 같은 줄 옆 모듈과 맞닿은 경계는 두 모듈을 같이 바꿔 줄 폭 합을 유지한다(노션 열 방식) — 끝까지 당겨도 옆을 밀어내지 않는다.
test('경계 끌기: 합은 유지, 양쪽 최소 열에서 멈춘다', () => {
  const r = [3, 12];
  assert.deepEqual(dragSpans({ a: 6, b: 6, d: 1, ra: r, rb: r }), [7, 5]);
  assert.deepEqual(dragSpans({ a: 6, b: 6, d: -2, ra: r, rb: r }), [4, 8]);
  assert.deepEqual(dragSpans({ a: 6, b: 6, d: 9, ra: r, rb: r }), [9, 3]);  // 옆은 3열에서 멈춘다
  assert.deepEqual(dragSpans({ a: 6, b: 6, d: -9, ra: r, rb: r }), [3, 9]);
  assert.deepEqual(dragSpans({ a: 4, b: 8, d: -3, ra: r, rb: [8, 12] }), [3, 9]);
  assert.deepEqual(dragSpans({ a: 4, b: 8, d: 2, ra: r, rb: [8, 12] }), [4, 8]); // 옆(현황)이 8열 밑으로 못 줄면 그대로
});

// 이유: 줄 끝 바깥 가장자리는 그 모듈만 바뀐다 — 같은 줄에 남은 폭 안에서만(넘치면 다음 줄로 떨어져 엉뚱한 곳이 바뀐다).
test('줄 끝 끌기: 혼자 바뀌고, 남은 폭·최소·최대에서 멈춘다', () => {
  assert.deepEqual(dragSpans({ a: 6, b: null, d: 3, ra: [3, 12], room: 12 }), [9, null]);
  assert.deepEqual(dragSpans({ a: 6, b: null, d: 3, ra: [3, 12], room: 8 }), [8, null]);
  assert.deepEqual(dragSpans({ a: 6, b: null, d: -9, ra: [3, 12], room: 12 }), [3, null]);
  assert.deepEqual(dragSpans({ a: 12, b: null, d: -9, ra: [8, 12], room: 12 }), [8, null]);
});

// 이유: 높이는 8px 단위로 붙고 120~1200px — 너무 작으면 제목만 남고, 끝없이 늘면 화면을 다 덮는다.
test('높이 눈금: 8px 단위, 최소 120(모듈 최소가 크면 그 값), 최대 1200', () => {
  assert.equal(snapH(363), 360); assert.equal(snapH(364), 368);
  assert.equal(snapH(40), 120); assert.equal(snapH(5000), 1200);
  assert.equal(snapH(150, 200), 200);
});

// 이유: 옛 앱·옛 화면은 size만 읽는다 — 열 수를 바꾸면 size도 가장 가까운 허용 단계로 같이 쓴다. 끌기 전 단계는 baseSize로 남긴다.
test('크기 쓰기: span과 함께 가장 가까운 size, 끌기 전 단계는 baseSize, 폭을 지우면 끌기 전 단계로', () => {
  const items = [{ id: 'a', size: 'm', hidden: false, cfg: { x: 1 } }, { id: 'stats', size: 'full', hidden: false }, { id: 'h', size: 's', hidden: true }];
  const next = applySizes(items, { a: { span: 9 }, stats: { span: 9 } }, modOf);
  assert.deepEqual(next[0], { id: 'a', size: 'l', hidden: false, cfg: { x: 1 }, span: 9, baseSize: 'm' });
  assert.deepEqual(next[1], { id: 'stats', size: 'l', hidden: false, span: 9, baseSize: 'full' });
  assert.strictEqual(next[2], items[2]);
  const again = applySizes(next, { a: { span: 11 } }, modOf); // 두 번 끌어도 끌기 전 단계는 처음 것
  assert.deepEqual([again[0].size, again[0].baseSize, again[0].span], ['full', 'm', 11]);
  const tall = applySizes(again, { a: { h: 400 }, stats: { h: 400 } }, modOf);
  assert.equal(tall[0].h, 400);
  const back = applySizes(tall, { a: { span: null, h: 0 } }, modOf);
  assert.deepEqual(back[0], { id: 'a', size: 'm', hidden: false, cfg: { x: 1 } });
});

// 이유(검수 10/1): 끌기 전 열 수로 되돌려 놓으면 바꾼 게 없다 — span이 남으면 ⋯에 '크기 되돌리기'가 계속 보인다.
test('끌기 전 열 수로 돌아오면 span·baseSize를 지운다', () => {
  const dragged = applySizes([{ id: 'stats', size: 'full' }], { stats: { span: 8 } }, modOf);
  assert.deepEqual(applySizes(dragged, { stats: { span: 12 } }, modOf), [{ id: 'stats', size: 'full' }]);
  assert.deepEqual(applySizes([{ id: 'a', size: 'l' }], { a: { span: 8 } }, modOf), [{ id: 'a', size: 'l' }]);
});

// 이유(검수 10/1): 높이만 바꾼 모듈을 되돌리면 높이만 — 폭을 등록부 기본값으로 바꾸면 홈 기본 배치(할 일 8열)가 6열이 되어 줄에 빈칸이 생겼다.
test('⋯ 크기 되돌리기: 높이만 바꿨으면 폭은 그대로', () => {
  const items = [{ id: 'todos', size: 'l', h: 400 }, { id: 'pages', size: 's', h: 400 }];
  assert.deepEqual(resetSize(items, 'todos', modOf), [{ id: 'todos', size: 'l' }, { id: 'pages', size: 's' }]);
  const [dash] = normalizeDashboards([defaultDashboard('D', new Date('2026-10-01T12:00:00+09:00'), (() => { let n = 0; return () => `w${n++}`; })())]);
  const line = dash.widgets.find((w) => w.type === 'line');
  const tall = applySizes(dash.widgets, { [line.id]: { h: 480 } }, modOf);
  const reset = resetSize(tall, line.id, modOf).find((w) => w.id === line.id);
  assert.deepEqual([reset.size, 'span' in reset, 'h' in reset], ['full', false, false]);
});

// 이유(검수 10/1): 경계를 같이 끈 두 모듈은 같이 끌기 전으로 — 8|4를 9|3으로 끈 뒤 되돌리면 6|6이 아니라 8|4.
test('⋯ 크기 되돌리기: 그 줄에서 바꾼 폭(경계를 같이 끈 옆 모듈 포함)과 줄 높이를 끌기 전으로', () => {
  const dragged = applySizes([{ id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'c', size: 'm', h: 200 }], { todos: { span: 9, h: 400 }, pages: { span: 3, h: 400 } }, modOf);
  assert.deepEqual(dragged.map((x) => [x.id, x.size, x.span]), [['todos', 'l', 9], ['pages', 's', 3], ['c', 'm', undefined]]);
  const next = resetSize(dragged, 'todos', modOf);
  assert.deepEqual(next, [{ id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'c', size: 'm', h: 200 }]);
  assert.deepEqual(rowsOf(next).map((r) => r.map((x) => x.id)), [['todos', 'pages'], ['c']]);
});

// 이유: 줄 구성은 CSS 격자 자동 배치와 같은 규칙 — 이제 열 수(span)로 센다. 줄 높이는 그 줄에 정해진 높이 중 가장 큰 값.
test('줄 나누기·줄 높이: span 기준, 같은 줄은 가장 큰 높이를 같이 쓴다', () => {
  const items = [{ id: 'a', size: 'm', span: 7 }, { id: 'b', size: 's', span: 5, h: 320 }, { id: 'c', size: 'l', span: 9 }, { id: 'd', size: 's' }, { id: 'e', size: 'm' }];
  assert.deepEqual(rowsOf(items).map((r) => r.map((i) => i.id)), [['a', 'b'], ['c'], ['d', 'e']]);
  assert.deepEqual([...rowInfo(items, () => ({}))].map(([id, r]) => [id, r.h]), [['a', 320], ['b', 320], ['c', 0], ['d', 0], ['e', 0]]);
});

// 이유: 홈 배치 병합은 아는 필드만 다시 조립한다 — 새 필드(span·h)를 빠뜨리면 저장한 크기가 새로고침에 사라진다.
test('배치 병합·페이지 모듈·대시보드 정규화가 span·h를 지킨다(잘못된 값은 버림)', () => {
  const reg = [{ id: 'a', sizes: ALL, defaultSize: 'm', spaces: ['me'] }, { id: 'st', sizes: ['l', 'full'], defaultSize: 'full', spaces: ['me'] }];
  const saved = { items: [{ id: 'a', size: 'm', span: 7, baseSize: 'l', h: 360 }, { id: 'st', size: 'full', span: 4, baseSize: 'm', h: 9 }, { id: 'b', moduleId: 'a', size: 's', span: 5, baseSize: 'zz' }] };
  assert.deepEqual(mergeLayout(saved, reg, 'me', []), [{ id: 'a', size: 'm', span: 7, baseSize: 'l', h: 360, hidden: false }, { id: 'st', size: 'full', hidden: false }, { id: 'b', moduleId: 'a', size: 's', span: 5, hidden: false }]);
  assert.deepEqual(normalizeModuleItems([{ id: 'calendar', size: 's', span: 5, h: 480 }])[0], { id: 'calendar', moduleId: 'calendar', size: 's', span: 5, h: 480, hidden: false });
  const [d] = normalizeDashboards([{ id: 'd', name: 'D', widgets: [{ id: 'w', type: 'kpi', metric: 'sales', size: 's', span: 3, h: 200 }] }]);
  assert.deepEqual(d.widgets[0], { id: 'w', type: 'kpi', metric: 'sales', size: 's', span: 3, h: 200 });
});

// 이유(유건 10/1): ⋯ 메뉴의 '1/3 폭' 같은 크기 항목은 없앴다 — 가장자리 끌기로 바꾸고, 바꾼 모듈에만 '크기 되돌리기'.
test('⋯ 메뉴에 크기 단계 항목이 없다', () => {
  const src = readFileSync(new URL('../src/ui/ModuleGrid.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /mod\.size\.\$\{|'mod\.size'\)/);
  assert.match(src, /mod\.size\.reset/);
});

// 이유(검수 10/1): 배포 전 코드가 열린 옛 탭의 '크기' 메뉴는 size만 바꾸고 span·baseSize를 그대로 남긴다 — 그 변경이 새 화면에서 무시되면 안 된다.
test('옛 탭이 size만 바꾸면 남은 span보다 size가 이기고, 다음 끌기의 끌기 전 단계도 그 size', () => {
  const stale = { id: 'a', size: 'full', span: 5, baseSize: 'm' }; // 새 화면에서 5열(s)로 끈 뒤 옛 탭에서 '전체 폭'
  assert.equal(spanOf(stale), 12);
  assert.deepEqual(rowsOf([stale, { id: 'b', size: 's' }]).map((r) => r.map((x) => x.id)), [['a'], ['b']]);
  assert.deepEqual(applySizes([stale], { a: { span: 9 } }, modOf)[0], { id: 'a', size: 'l', span: 9, baseSize: 'full' });
  assert.deepEqual(applySizes([stale], { a: { span: null } }, modOf)[0], { id: 'a', size: 'full' });
  assert.equal(spanOf({ id: 'a', size: 's', span: 5, baseSize: 'm' }), 5); // 새 화면이 쓴 것(가장 가까운 단계)은 그대로
});

// 이유: span과 같이 쓰는 size는 '가장 가까운 단계'(sizeForSpan) — 그 모듈이 허용하는 열 범위 안이면 늘 허용 단계여야 옛 화면이 읽는다.
test('허용 열 범위 안의 가장 가까운 단계는 늘 그 모듈의 허용 단계', () => {
  for (const m of [...OFFICE_MODULES, ...CHART_MODULES, { sizes: ALL }]) {
    const [lo, hi] = spanRange(m.sizes);
    for (let span = lo; span <= hi; span += 1) assert.ok(m.sizes.includes(sizeForSpan(span)), `${m.id} ${span}`);
  }
});

// 이유(유건 10/1 C.2·검수): 높이 최소 120px, 본문 최소가 있는 모듈(달력·그래프)은 머리 + 본문 최소 — 카드 120px까지 줄면 달력 본문이 60px만 남았다.
test('모듈 최소 높이: 기본 120, 본문 최소가 있으면 머리 + 본문(8px 올림)', () => {
  assert.equal(minHeight({}), 120);
  const cal = OFFICE_MODULES.find((m) => m.id === 'calendar');
  assert.equal(minHeight(cal), 248); assert.equal(minHeight(cal, 0), 200); // 머리를 숨긴 모양이면 본문만
  assert.equal(minHeight(CHART_MODULES.find((m) => m.id === 'line'), 52), 224);
  assert.equal(minHeight(CHART_MODULES.find((m) => m.id === 'kpi')), 120);
  assert.equal(snapH(130, minHeight(cal)), 248);
});

// 이유(검수 10/1 2차 재현): 두 번 눌러 폭을 되돌릴 때 그 모듈만 되돌리면, 경계를 같이 끈 앞 모듈은 늘어난 채라 줄 합이 12를 넘어 모듈이 다음 줄로 떨어졌다.
// 폭 되돌리기는 그 줄의 바꾼 폭을 모두 끌기 전으로 — 끌기 전 줄 구성이 그대로 돌아온다. 높이는 건드리지 않는다.
test('두 번 눌러 폭 되돌리기: 그 줄 전체를 끌기 전으로, 줄 구성 유지', () => {
  const start = [{ id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'cal', size: 'm' }, { id: 'work', size: 'm' }];
  const dragged = applySizes(start, { todos: { span: 9, h: 400 }, pages: { span: 3, h: 400 } }, modOf); // 할 일|최근 페이지 경계를 끈 뒤
  const row = rowsOf(dragged)[0];
  assert.deepEqual(resetPatch(row, 'span'), { todos: { span: null }, pages: { span: null } }); // 줄 끝(최근 페이지)을 두 번 눌러도 앞 모듈까지
  const back = applySizes(dragged, resetPatch(row, 'span'), modOf);
  assert.deepEqual(rowsOf(back).map((r) => r.map((x) => x.id)), rowsOf(start).map((r) => r.map((x) => x.id)));
  assert.deepEqual(back.slice(0, 2).map((x) => [x.size, x.span, x.h]), [['l', undefined, 400], ['s', undefined, 400]]);
  // A|B|C에서 A|B를 끈 뒤 B|C 경계를 두 번 눌러도 C가 떨어지지 않는다
  const abc = applySizes([{ id: 'a', size: 's' }, { id: 'b', size: 's' }, { id: 'c', size: 's' }], { a: { span: 5 }, b: { span: 3 } }, modOf);
  const reset = applySizes(abc, resetPatch(rowsOf(abc)[0], 'span'), modOf);
  assert.deepEqual(rowsOf(reset).map((r) => r.map((x) => x.id)), [['a', 'b', 'c']]);
  assert.ok(rowsOf(reset).every((r) => r.reduce((sum, x) => sum + spanOf(x), 0) <= 12));
  assert.deepEqual(resetPatch([{ id: 'x', size: 'm' }], 'span'), {}); // 바꾼 게 없으면 저장하지 않는다
  assert.deepEqual(resetPatch(row, 'h'), { todos: { h: 0 }, pages: { h: 0 } });
});

// 이유(검수 10/1 2차): 줄 첫 모듈의 왼쪽 가장자리는 잡은 선이 손을 따라오지 않는다(반대편이 움직인다) — 그 손잡이는 그리지 않는다(first).
// 높이 손잡이가 알리는 최소는 그 줄 모듈 최소 중 가장 큰 값 — 줄 높이를 같이 쓰므로 실제로 그 밑으로 줄지 않는다(min).
test('줄 정보: 줄 높이·줄 최소 높이·줄 첫 모듈', () => {
  const cal = OFFICE_MODULES.find((m) => m.id === 'calendar');
  const items = [{ id: 'cal', size: 'm', h: 320 }, { id: 'work', size: 'm' }, { id: 'c', size: 'full' }];
  const info = rowInfo(items, (item) => (item.id === 'cal' ? cal : {}));
  assert.deepEqual([...info], [['cal', { h: 320, min: 248, first: true }], ['work', { h: 320, min: 248, first: false }], ['c', { h: 0, min: 120, first: true }]]);
});
