// 모듈 맞춤·쌓이는 모듈 고정 높이(유건 10/1 밤 6차 확정). 규칙마다 이유 한 줄. node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { bands, share, fitHeights, fitLayout } from '../src/core/fit.js';
import { pack, freeOrder, spanOf, heightOf } from '../src/core/layout.js';

const FIXED_H = 320; // base.css .module.fixed-h — 쌓이는 모듈의 기본 고정 높이
import { OFFICE_MODULES } from '../src/core/module-registry.js';

const GAP = 12;
const box = (id, x, w, top, h) => ({ id, x, w, top, h });
const no = () => false;
const ids = (list) => list.map((band) => band.map((g) => g.map((b) => b.id)));

// 이유: 유건 예시 그대로 — 캘린더 480 옆 할 일 내용 150·결재 대기 내용 330 → 틈 12 빼고 468을 146·322로.
test('1:n — 1의 높이가 기준, n쪽은 내용 비율로 나누고 합(틈 포함)이 기준과 같다', () => {
  const boxes = [box('cal', 0, 6, 0, 480), box('todo', 6, 6, 0, 200), box('appr', 6, 6, 212, 200)];
  const h = fitHeights(boxes, { cal: 480, todo: 150, appr: 330 }, { cal: 120, todo: 120, appr: 120 }, no, GAP);
  assert.deepEqual([h.get('cal'), h.get('todo'), h.get('appr')], [480, 146, 322]);
  assert.equal(h.get('todo') + GAP + h.get('appr'), h.get('cal'));
});

// 이유(유건 10/2 제보): 캘린더를 늘려 둔 뒤 맞춤을 누르면 캘린더가 내용 높이로 줄었다 — '1'은 지금 높이가 기준이고 n쪽이 거기에 맞춘다.
// 지금 높이가 내용보다 작아 스크롤바가 생기는 경우에만 내용 높이까지 늘린다.
test('1:n — 늘려 둔 1은 줄이지 않고, n쪽이 1의 정한 높이에 맞춘다', () => {
  const boxes = [box('cal', 0, 6, 0, 700), box('todo', 6, 6, 0, 200), box('appr', 6, 6, 212, 300)];
  const h = fitHeights(boxes, { cal: 480, todo: 150, appr: 330 }, { cal: 120, todo: 120, appr: 120 }, no, GAP, { cal: 700 });
  assert.equal(h.get('cal'), 700);
  assert.equal(h.get('todo') + GAP + h.get('appr'), 700);
  const short = fitHeights([box('cal', 0, 6, 0, 300), box('todo', 6, 6, 0, 200), box('appr', 6, 6, 212, 300)], { cal: 480, todo: 150, appr: 330 }, { cal: 120, todo: 120, appr: 120 }, no, GAP, { cal: 300 });
  assert.equal(short.get('cal'), 480); // 300이면 캘린더 안에 스크롤바 — 내용 높이까지
  // 정한 적 없는 1(고정 320으로 그려진 쌓이는 모듈 등)은 내용 높이로 — 화면 높이를 기준으로 삼지 않는다
  const unset = fitHeights([box('a', 0, 6, 0, 320), box('b', 6, 6, 0, 320)], { a: 265, b: 150 }, { a: 120, b: 120 }, no, GAP);
  assert.deepEqual([unset.get('a'), unset.get('b')], [265, 265]);
});

// 이유: 모듈 최소 높이 밑으로는 줄이지 않는다 — 모자란 쪽을 최소로 묶고 나머지를 다시 비율로 나눈다.
test('1:n — 최소 높이를 지키고 나머지를 비율로', () => {
  const boxes = [box('cal', 0, 6, 0, 480), box('a', 6, 6, 0, 100), box('b', 6, 6, 112, 100)];
  const h = fitHeights(boxes, { cal: 480, a: 20, b: 600 }, { cal: 120, a: 120, b: 120 }, no, GAP);
  assert.deepEqual([h.get('a'), h.get('b')], [120, 348]);
  // n쪽 최소 합이 기준보다 크면 기준(1)이 늘어나 아래 끝이 맞는다
  const h2 = fitHeights([box('c', 0, 6, 0, 200), box('a', 6, 6, 0, 120), box('b', 6, 6, 132, 120)], { c: 150, a: 50, b: 50 }, { c: 120, a: 160, b: 160 }, no, GAP);
  assert.deepEqual([h2.get('c'), h2.get('a'), h2.get('b')], [332, 160, 160]);
});

// 이유: 1:1(나란히 하나씩)은 둘 중 큰 내용 높이로 같이 맞춘다.
test('1:1 — 큰 내용 높이로 같이', () => {
  const h = fitHeights([box('a', 0, 6, 0, 300), box('b', 6, 6, 0, 250)], { a: 280, b: 410 }, { a: 120, b: 120 }, no, GAP);
  assert.deepEqual([h.get('a'), h.get('b')], [410, 410]);
});

// 이유: 1이 없는 n:m은 내용 높이 합이 가장 큰 묶음이 기준 — 그 묶음은 내용 높이 그대로, 다른 묶음이 비율로 맞춘다.
test('n:m — 내용 합이 큰 묶음이 기준', () => {
  const boxes = [box('a', 0, 6, 0, 300), box('c', 6, 6, 0, 100), box('b', 0, 6, 312, 200), box('d', 6, 6, 112, 400)];
  const nat = { a: 200, b: 300, c: 100, d: 100 };
  const h = fitHeights(boxes, nat, { a: 120, b: 120, c: 120, d: 120 }, no, GAP);
  assert.deepEqual([h.get('a'), h.get('b')], [200, 300]);
  assert.equal(h.get('c') + GAP + h.get('d'), 512);
  assert.deepEqual([h.get('c'), h.get('d')], [250, 250]);
  assert.equal(bands(boxes).length, 1);
});

// 이유: 전체 폭(혼자인 띠)은 내용 높이 — 쌓이지 않는 모듈은 정한 높이를 지워 내용대로, 쌓이는 모듈은 내용 높이를 정해 둔다(기본 고정 높이가 아니라).
test('혼자인 띠 — 쌓이지 않으면 정한 높이 없음, 쌓이면 내용 높이', () => {
  const boxes = [box('stats', 0, 12, 0, 184), box('dec', 0, 12, 196, 320)];
  const h = fitHeights(boxes, { stats: 230, dec: 260 }, { stats: 120, dec: 120 }, (id) => id === 'dec', GAP);
  assert.deepEqual([h.get('stats'), h.get('dec')], [null, 260]);
});

// 이유: 띠 나누기 — 옆 묶음과 세로로 조금만 겹친 모듈(예: 캘린더 아래 끝에 몇 px 걸친 일지)은 다음 띠로 간다(refs6/5 모양).
test('띠 — 살짝 걸친 모듈은 다음 띠, 여러 묶음에 걸친 모듈도 다음 띠', () => {
  const boxes = [box('stats', 0, 12, 0, 200), box('cal', 0, 4, 212, 418), box('todo', 4, 8, 212, 200), box('appr', 4, 8, 424, 190), box('journal', 6, 6, 626, 300), box('work', 0, 6, 642, 200)];
  assert.deepEqual(ids(bands(boxes)), [[['stats']], [['cal'], ['todo', 'appr']], [['journal'], ['work']]]);
  const wide = [box('a', 0, 6, 0, 300), box('b', 6, 6, 0, 100), box('w', 0, 12, 312, 100)];
  assert.deepEqual(ids(bands(wide)), [[['a'], ['b']], [['w']]]);
});

test('비율 나누기 — 정수, 합 보존', () => {
  assert.deepEqual(share(468, [150, 330], [0, 0]), [146, 322]);
  assert.deepEqual(share(100, [1, 1, 1], [0, 0, 0]), [34, 33, 33]);
  assert.equal(share(997, [3, 7, 11, 13], [120, 0, 0, 0]).reduce((a, b) => a + b), 997);
});

// ── 배치 전체 ──
const ITEMS = [
  { id: 'stats', size: 'full', x: 0, y: 0, h: 184 },
  { id: 'cal', size: 's', span: 4, baseSize: 's', x: 0, y: 1, cfg: { view: 'month' } },
  { id: 'todo', size: 'l', x: 4, y: 2 },
  { id: 'appr', size: 'l', x: 4, y: 3, h: 400 },
  { id: 'gone', size: 'm', hidden: true, h: 300 },
];
const STACK = new Set(['todo', 'appr']);
const NAT = { stats: 230, cal: 418, todo: 150, appr: 330 }, MIN = { stats: 120, cal: 248, todo: 120, appr: 120 };
// 화면에서 잰 지금 높이 — 정한 높이(h)가 있으면 그것, 쌓이는 모듈은 고정 높이, 아니면 내용 높이
const curOf = (items) => Object.fromEntries(items.filter((it) => !it.hidden).map((it) => [it.id, heightOf(it) || (STACK.has(it.id) ? FIXED_H : NAT[it.id])]));
const run = (items) => fitLayout(items, { cur: curOf(items), nat: NAT, min: MIN, stack: (id) => STACK.has(id), gap: GAP });

test('배치 맞춤 — 높이만 바뀌고 폭·열·옛 필드·숨김은 그대로, 아래 끝이 맞는다', () => {
  const out = run(ITEMS);
  const by = Object.fromEntries(out.map((it) => [it.id, it]));
  assert.equal('h' in by.stats, false); // 혼자인 현황은 내용대로(스크롤바 없음)
  assert.deepEqual([by.cal.h, by.todo.h, by.appr.h], [418, 127, 279]); // 418 - 틈 12 = 406을 150:330으로
  assert.deepEqual([by.cal.x, by.todo.x, by.appr.x, by.cal.span, by.cal.cfg.view], [0, 4, 4, 4, 'month']);
  assert.deepEqual(out.at(-1), ITEMS.at(-1));
  const placed = pack(freeOrder(out.filter((it) => !it.hidden)).map(({ it, x }) => ({ id: it.id, x, w: spanOf(it), h: heightOf(it) || NAT[it.id] })), GAP);
  const bottom = (id) => { const b = placed.find((p) => p.id === id); return b.top + b.h; };
  assert.equal(bottom('cal'), bottom('appr'));
});

// 이유: 맞춘 뒤 다시 눌러도 같은 결과 — 이미 맞아 있으면 저장하지 않는다(DB 쓰기 0).
test('멱등 — 두 번째는 저장할 것이 없다', () => {
  const once = run(ITEMS);
  assert.ok(once);
  assert.equal(run(once), null);
});

// 이유: 자리(x·y)가 없는 옛 배치는 지금 자리(옛 규칙 순서·열)로 x·y를 만든 뒤 맞춘다.
test('옛 배치 — 지금 자리로 x·y를 만든다', () => {
  const old = [{ id: 'stats', size: 'full' }, { id: 'cal', size: 'm' }, { id: 'todo', size: 'm' }];
  const out = run(old);
  assert.deepEqual(out.map((it) => [it.id, it.x, it.y]), [['stats', 0, 0], ['cal', 0, 1], ['todo', 6, 2]]);
  assert.deepEqual([out[1].h, out[2].h], [418, 418]);
  assert.equal(run(out), null);
});

// ── 쌓이는 모듈은 고정 높이(규칙 7) ──
// 이유: 항목이 늘어나는 모듈만 등록부에 stack 표시 — 정한 높이가 없으면 고정 높이로 그린다(ModuleGrid 카드 class fixed-h + base.css). 현황·캘린더·업무 카드는 내용대로.
test('쌓이는 모듈 목록', () => {
  assert.deepEqual(OFFICE_MODULES.filter((m) => m.stack).map((m) => m.id).sort(), ['approvals', 'decisions', 'journal', 'mail', 'outputs', 'pages', 'todos', 'work']);
});
