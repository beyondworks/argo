// 모듈 크기 — 가장자리 끌기(유건 10/1 확정). 규칙마다 이유 한 줄. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeLayout, rowsOf, rowInfo, spanOf, heightOf, spanRange, sizeForSpan, minHeight } from '../src/core/layout.js';
import { snapH, stepH, applySizes, resetSize, resetPatch } from '../src/core/module-size.js';
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
  assert.deepEqual(resetSize(items, 'todos', modOf), [{ id: 'todos', size: 'l' }, { id: 'pages', size: 's', h: 400 }]); // 그 모듈만(유건 10/1 저녁)
  const [dash] = normalizeDashboards([defaultDashboard('D', new Date('2026-10-01T12:00:00+09:00'), (() => { let n = 0; return () => `w${n++}`; })())]);
  const line = dash.widgets.find((w) => w.type === 'line');
  const tall = applySizes(dash.widgets, { [line.id]: { h: 480 } }, modOf);
  const reset = resetSize(tall, line.id, modOf).find((w) => w.id === line.id);
  assert.deepEqual([reset.size, 'span' in reset, 'h' in reset], ['full', false, false]);
});

// 이유(유건 10/1 저녁 자유 격자): 크기 되돌리기는 그 모듈만 — 경계를 같이 끄는 일이 없어졌으므로 옆 모듈의 폭·높이는 그대로 둔다.
test('⋯ 크기 되돌리기: 그 모듈의 폭·높이만 끌기 전으로', () => {
  const dragged = applySizes([{ id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'c', size: 'm', h: 200 }], { todos: { span: 9, h: 400 }, pages: { span: 3, h: 400 } }, modOf);
  assert.deepEqual(dragged.map((x) => [x.id, x.size, x.span]), [['todos', 'l', 9], ['pages', 's', 3], ['c', 'm', undefined]]);
  assert.deepEqual(resetSize(dragged, 'todos', modOf), [{ id: 'todos', size: 'l' }, dragged[1], dragged[2]]);
  assert.deepEqual(resetPatch(dragged, 'pages', 'span'), { pages: { span: null } }); // 두 번 누르기 = 그 방향만
  assert.deepEqual(resetPatch(dragged, 'pages', 'h'), { pages: { h: 0 } });
  assert.deepEqual(resetPatch([{ id: 'x', size: 'm' }], 'x', 'span'), {}); // 바꾼 게 없으면 저장하지 않는다
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

// 이유(검수 10/1 2차, 유건 10/1 확정): 줄 첫 모듈의 왼쪽 가장자리는 잡은 선이 손을 따라오지 않는다(반대편이 움직인다) — 그 손잡이는 그리지 않는다(first).
// 높이 손잡이가 알리는 최소는 그 줄 모듈 최소 중 가장 큰 값 — 줄 높이를 같이 쓰므로 실제로 그 밑으로 줄지 않는다(min).
test('줄 정보: 줄 높이·줄 최소 높이·줄 첫 모듈', () => {
  const cal = OFFICE_MODULES.find((m) => m.id === 'calendar');
  const items = [{ id: 'cal', size: 'm', h: 320 }, { id: 'work', size: 'm' }, { id: 'c', size: 'full' }];
  const info = rowInfo(items, (item) => (item.id === 'cal' ? cal : {}));
  assert.deepEqual([...info], [['cal', { h: 320, min: 248, first: true }], ['work', { h: 320, min: 248, first: false }], ['c', { h: 0, min: 120, first: true }]]);
});

// 이유(유건 10/1 C4 "↑/↓ = 16px", 통합 검수 10/1): 정한 적 없는 줄의 높이는 내용대로(8의 배수가 아님)다. 거기서 바로 16을 더하고 맞추면 418→432(+14)가 됐다.
// 먼저 눈금(손잡이가 알리는 값 416)에 맞춘 뒤 더해 알리는 값 기준으로 늘 정확히 16씩 움직인다.
test('키보드 높이: 한 번에 정확히 16px(알리는 값 기준)', () => {
  assert.equal(stepH(418, 1), 432); assert.equal(stepH(418, -1), 400); // 알리는 값 416 기준 ±16
  assert.equal(stepH(422, 1), 440); // 알리는 값 424 기준
  let h = stepH(418, 1);
  for (let i = 0; i < 5; i++) { const next = stepH(h, 1); assert.equal(next - h, 16); h = next; }
  for (let i = 0; i < 5; i++) { const next = stepH(h, -1); assert.equal(h - next, 16); h = next; }
  assert.equal(stepH(130, -1), 120); assert.equal(stepH(1196, 1), 1200); // 최소·최대에서 멈춘다
  assert.equal(stepH(260, -1, 248), 248);
});

// 이유(유건 10/1 C4 "aria-valuenow"): 높이 손잡이도 지금 높이를 알린다 — 정한 적 없는 줄은 그릴 때 값이 없어 화면에서 잰다(ResizeObserver).
test('높이 손잡이: 지금 높이를 알린다, 줄 첫 모듈은 왼쪽 손잡이 없음', () => {
  const src = readFileSync(new URL('../src/ui/ModuleGrid.jsx', import.meta.url), 'utf8');
  assert.match(src, /new ResizeObserver[\s\S]{0,160}\.edge-y[\s\S]{0,80}'aria-valuenow'/);
  assert.match(src, /place\.first && side === 'l'\) return null/);
});
