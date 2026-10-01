// 모듈 크기 — 가장자리 끌기(유건 10/1 확정). 규칙마다 이유 한 줄. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeLayout, rowsOf, rowHeights, spanOf, heightOf, spanRange } from '../src/core/layout.js';
import { dragSpans, snapH, applySizes, resetSize, sized } from '../src/core/module-size.js';
import { normalizeModuleItems } from '../src/core/module-items.js';
import { normalizeDashboards } from '../src/business/dashboard-model.js';
import { OFFICE_MODULES } from '../src/core/module-registry.js';

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

// 이유: 옛 앱·옛 화면은 size만 읽는다 — 열 수를 바꾸면 size도 가장 가까운 허용 단계로 같이 쓴다. 되돌리면 기본 크기.
test('크기 쓰기: span과 함께 가장 가까운 size, 되돌리면 span·높이를 지우고 기본 단계', () => {
  const items = [{ id: 'a', size: 'm', hidden: false, cfg: { x: 1 } }, { id: 'stats', size: 'full', hidden: false }, { id: 'h', size: 's', hidden: true }];
  const next = applySizes(items, { a: { span: 9 }, stats: { span: 9 } }, modOf);
  assert.deepEqual(next[0], { id: 'a', size: 'l', hidden: false, cfg: { x: 1 }, span: 9 });
  assert.deepEqual(next[1], { id: 'stats', size: 'l', hidden: false, span: 9 });
  assert.strictEqual(next[2], items[2]);
  const tall = applySizes(next, { a: { h: 400 }, stats: { h: 400 } }, modOf);
  assert.equal(tall[0].h, 400);
  const back = applySizes(tall, { a: { span: null, h: 0 } }, modOf);
  assert.deepEqual(back[0], { id: 'a', size: 'm', hidden: false, cfg: { x: 1 } });
  assert.equal(sized(back[0]), false); assert.equal(sized(tall[1]), true);
});

// 이유: 같은 줄은 높이를 같이 쓴다 — 한 모듈만 높이를 지우면 옆 모듈 높이가 줄을 계속 붙잡아 '되돌리기'가 안 된 것처럼 보인다.
test('⋯ 크기 되돌리기: 그 모듈의 폭과 그 줄의 높이를 함께 지운다', () => {
  const items = [{ id: 'a', size: 'l', span: 7, h: 400 }, { id: 'b', size: 's', span: 5, h: 400 }, { id: 'c', size: 'm', h: 200 }];
  const next = resetSize(items, 'a', modOf);
  assert.deepEqual(next.map((x) => [x.id, x.size, x.span, x.h]), [['a', 'm', undefined, undefined], ['b', 's', 5, undefined], ['c', 'm', undefined, 200]]);
});

// 이유: 줄 구성은 CSS 격자 자동 배치와 같은 규칙 — 이제 열 수(span)로 센다. 줄 높이는 그 줄에 정해진 높이 중 가장 큰 값.
test('줄 나누기·줄 높이: span 기준, 같은 줄은 가장 큰 높이를 같이 쓴다', () => {
  const items = [{ id: 'a', size: 'm', span: 7 }, { id: 'b', size: 'm', span: 5, h: 320 }, { id: 'c', size: 's', span: 9 }, { id: 'd', size: 's' }, { id: 'e', size: 'm' }];
  assert.deepEqual(rowsOf(items).map((r) => r.map((i) => i.id)), [['a', 'b'], ['c'], ['d', 'e']]);
  assert.deepEqual([...rowHeights(items)], [['a', 320], ['b', 320], ['c', 0], ['d', 0], ['e', 0]]);
});

// 이유: 홈 배치 병합은 아는 필드만 다시 조립한다 — 새 필드(span·h)를 빠뜨리면 저장한 크기가 새로고침에 사라진다.
test('배치 병합·페이지 모듈·대시보드 정규화가 span·h를 지킨다(잘못된 값은 버림)', () => {
  const reg = [{ id: 'a', sizes: ALL, defaultSize: 'm', spaces: ['me'] }, { id: 'st', sizes: ['l', 'full'], defaultSize: 'full', spaces: ['me'] }];
  const saved = { items: [{ id: 'a', size: 'l', span: 7, h: 360 }, { id: 'st', size: 'full', span: 4, h: 9 }] };
  assert.deepEqual(mergeLayout(saved, reg, 'me', []), [{ id: 'a', size: 'l', span: 7, h: 360, hidden: false }, { id: 'st', size: 'full', hidden: false }]);
  assert.deepEqual(normalizeModuleItems([{ id: 'calendar', size: 'm', span: 5, h: 480 }])[0], { id: 'calendar', moduleId: 'calendar', size: 'm', span: 5, h: 480, hidden: false });
  const [d] = normalizeDashboards([{ id: 'd', name: 'D', widgets: [{ id: 'w', type: 'kpi', metric: 'sales', size: 's', span: 3, h: 200 }] }]);
  assert.deepEqual(d.widgets[0], { id: 'w', type: 'kpi', metric: 'sales', size: 's', span: 3, h: 200 });
});

// 이유(유건 10/1): ⋯ 메뉴의 '1/3 폭' 같은 크기 항목은 없앴다 — 가장자리 끌기로 바꾸고, 바꾼 모듈에만 '크기 되돌리기'.
test('⋯ 메뉴에 크기 단계 항목이 없다', () => {
  const src = readFileSync(new URL('../src/ui/ModuleGrid.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /mod\.size\.\$\{|'mod\.size'\)/);
  assert.match(src, /mod\.size\.reset/);
});
