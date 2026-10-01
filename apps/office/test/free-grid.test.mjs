// 자유 격자(유건 10/1 저녁 확정 — 추가사항 1·2). 규칙마다 이유 한 줄. node --test test/*.test.mjs
// 앞 절반은 바꾸기 전에 잠근 인접 행동(정규화·숨김·새 모듈·옛 줄 규칙)이다 — 자유 격자를 넣어도 그대로여야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayout, rowsOf, rowInfo, spanOf } from '../src/core/layout.js';
import { normalizeModuleItems } from '../src/core/module-items.js';
import { normalizeDashboards } from '../src/business/dashboard-model.js';
import { LIBRARY_MODULES } from '../src/core/module-registry.js';

const REG = [
  { id: 'a', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me'] },
  { id: 'b', sizes: ['m', 'full'], defaultSize: 'full', spaces: ['me'] },
  { id: 'n', sizes: ['s', 'm'], defaultSize: 's', spaces: ['me'] },
  { id: 'top', sizes: ['full'], defaultSize: 'full', spaces: ['me'], intro: 'top' },
  { id: 'r', sizes: ['s', 'm'], defaultSize: 's', spaces: ['me'], repeatable: true },
];

// ── 바꾸기 전에 잠근 인접 행동 ──

// 이유: 저장값 정규화 규칙(등록부 없는 모듈 버림·중복 id 버림·허용 크기 밖은 기본값·cfg·숨김 보존·새 모듈은 숨김으로 뒤에·도입 모듈은 맨 위)은 자유 격자에서도 그대로다.
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

// 이유: 페이지 안 모듈·업무 대시보드 정규화는 모르는 필드를 지킨다 — 새 필드(x·y)도 그대로 지나가야 저장한 자리가 남는다.
test('잠금: 페이지 모듈·대시보드 정규화는 다른 필드를 지킨다', () => {
  assert.deepEqual(normalizeModuleItems([{ id: 'calendar', size: 'zz', x: 6, y: 1, extra: 1 }])[0], { id: 'calendar', moduleId: 'calendar', size: 'm', x: 6, y: 1, extra: 1, hidden: false });
  const [d] = normalizeDashboards([{ id: 'd', name: 'D', widgets: [{ id: 'w', type: 'kpi', metric: 'sales', size: 's', x: 3, y: 0 }] }]);
  assert.deepEqual(d.widgets[0], { id: 'w', type: 'kpi', metric: 'sales', size: 's', x: 3, y: 0 });
});

// 이유: 자리(x·y)가 없는 옛 저장값은 지금처럼 그린다 — 줄 나누기·줄 높이 공유 규칙이 그대로여야 바꾼 직후 홈이 달라 보이지 않는다.
test('잠금: 옛 저장값의 줄 규칙(순서·열 수·줄 높이 공유)', () => {
  const home = mergeLayout(null, LIBRARY_MODULES, 'me', [{ id: 'stats', size: 'full' }, { id: 'approvals', size: 'm' }, { id: 'mail', size: 'm' }, { id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'calendar', size: 'm' }, { id: 'work', size: 'm' }]);
  const visible = home.filter((it) => !it.hidden);
  assert.deepEqual(rowsOf(visible).map((r) => r.map((it) => `${it.id}:${spanOf(it)}`)), [['stats:12'], ['approvals:6', 'mail:6'], ['todos:8', 'pages:4'], ['calendar:6', 'work:6']]);
  const info = rowInfo([{ id: 'a', size: 'm', h: 320 }, { id: 'b', size: 'm' }], () => ({}));
  assert.deepEqual([info.get('a').h, info.get('b').h, info.get('b').first], [320, 320, false]);
});

// ── 자유 격자 ──
import { hasXY, freeOrder, pack } from '../src/core/layout.js';
import { landing, stepY, around, settle } from '../src/core/grid-move.js';
import { resizeX, applySizes, resetSize, resetPatch, magnet, snapH } from '../src/core/module-size.js';

const GAP = 12;
const box = (id, x, w, top, h) => ({ id, x, w, top, h });
const tops = (list) => Object.fromEntries(list.map((b) => [b.id, [b.x, b.top]]));

// 이유: 새 필드 x·y는 더한다 — 옛 필드는 그대로 두고, 잘못된 자리는 버린다(그 모듈은 뒤에 옛 규칙으로 놓인다).
test('배치 병합: 올바른 x·y만 지키고 옛 필드(size·span·h·cfg)는 그대로', () => {
  const saved = { items: [{ id: 'a', size: 'm', span: 7, baseSize: 'm', h: 360, x: 5, y: 0, cfg: { k: 1 } }, { id: 'b', size: 'full', x: 12, y: 1 }, { id: 'n', size: 's', x: 2, y: -1 }, { id: 'top', size: 'full', x: 0.5, y: 2 }] };
  const merged = mergeLayout(saved, REG, 'me', []);
  assert.deepEqual(merged[0], { id: 'a', size: 'm', span: 7, baseSize: 'm', h: 360, x: 5, y: 0, hidden: false, cfg: { k: 1 } });
  assert.deepEqual(merged.slice(1).map((it) => [it.id, 'x' in it, 'y' in it]), [['b', false, false], ['n', false, false], ['top', false, false]]);
});

// 이유(유건: 바꾼 직후 홈이 달라 보이면 안 된다): 자리가 없는 옛 저장값의 열은 옛 줄 규칙과 같다. 자리 없는 모듈(새로 넣은 것)은 자리 있는 모듈 뒤에.
test('그리는 순서: 옛 저장값은 옛 줄 규칙의 열, 자리 없는 모듈은 자리 있는 모듈 뒤', () => {
  const legacy = [{ id: 'a', size: 'm' }, { id: 'b', size: 'm' }, { id: 'c', size: 'l' }, { id: 'd', size: 's' }, { id: 'e', size: 'full' }];
  assert.equal(legacy.some(hasXY), false);
  assert.deepEqual(freeOrder(legacy).map(({ it, x }) => [it.id, x]), [['a', 0], ['b', 6], ['c', 0], ['d', 8], ['e', 0]]);
  const mixed = [{ id: 'new', size: 'm' }, { id: 'p', size: 'm', x: 6, y: 1 }, { id: 'q', size: 'm', x: 0, y: 1 }, { id: 'r', size: 'full', x: 0, y: 0 }];
  assert.deepEqual(freeOrder(mixed).map(({ it, x }) => [it.id, x]), [['r', 0], ['q', 0], ['p', 6], ['new', 0]]);
});

// 이유(유건 예시): 캘린더 6열×480 왼쪽, 오른쪽에 할 일·작업을 위아래로 — 같은 줄 높이 공유 없이 각자 높이, 빈 곳은 위로 붙는다.
test('세로 중력: 각자 높이로 쌓고 빈 곳은 위로, 겹치지 않는다', () => {
  const placed = pack([{ id: 'cal', x: 0, w: 6, h: 480 }, { id: 'todos', x: 6, w: 6, h: 232 }, { id: 'work', x: 6, w: 6, h: 236 }, { id: 'pages', x: 0, w: 12, h: 200 }], GAP);
  assert.deepEqual(tops(placed), { cal: [0, 0], todos: [6, 0], work: [6, 244], pages: [0, 492] });
  assert.equal(placed[2].top + placed[2].h, placed[0].top + placed[0].h); // 두 모듈 높이 + 틈 = 캘린더 높이
  // 위가 비어 있으면 올라간다, 열이 넘치면 안으로 들인다
  assert.deepEqual(tops(pack([{ id: 'a', x: 0, w: 4, h: 100 }, { id: 'b', x: 9, w: 6, h: 100 }], GAP)), { a: [0, 0], b: [6, 0] });
});

// 이유(유건 10/1 저녁 추가사항 1): 끄는 동안 보인 윤곽 자리에 놓이고, 그 자리와 겹치는 모듈은 아래로 밀린 뒤 중력으로 정리된다.
test('놓기: 보인 자리에 놓이고 겹친 모듈은 아래로 밀린다', () => {
  const now = [box('cal', 0, 6, 0, 480), box('todos', 6, 6, 0, 232), box('work', 6, 6, 244, 232), box('pages', 0, 12, 492, 200)];
  // 그대로 놓으면(포인터가 원래 자리) 아무것도 안 바뀐다
  assert.deepEqual(tops(landing(now, 'work', 6, 250, GAP)), tops(now));
  // 작업을 할 일 위쪽 절반에 놓으면 작업이 맨 위, 할 일은 아래로
  assert.deepEqual(tops(landing(now, 'work', 6, 40, GAP)), { cal: [0, 0], work: [6, 0], todos: [6, 244], pages: [0, 492] });
  // 할 일을 캘린더 자리(0열) 위쪽에 놓으면 캘린더가 아래로 밀리고, 오른쪽 작업은 빈 위로 붙는다
  assert.deepEqual(tops(landing(now, 'todos', 0, 10, GAP)), { todos: [0, 0], work: [6, 0], cal: [0, 244], pages: [0, 736] });
  // 맨 아래 빈 곳에 놓아도 공중에 뜨지 않는다(중력)
  assert.deepEqual(tops(landing(now, 'todos', 6, 5000, GAP)).todos, [6, 704]);
});

// 이유(기능 후퇴 금지): 키보드 ↑/↓는 같은 열에 걸친 모듈 하나씩 넘는다(한 칸), 넘을 것이 없으면 그대로.
test('키보드 한 칸: 같은 열의 모듈을 하나씩 넘는다', () => {
  const now = [box('cal', 0, 6, 0, 480), box('todos', 6, 6, 0, 232), box('work', 6, 6, 244, 232)];
  let ty = 244; // 작업의 지금 자리
  ty = stepY(now, 'work', 6, 6, ty, -1);
  assert.deepEqual(tops(landing(now, 'work', 6, ty, GAP)).work, [6, 0]);
  assert.equal(stepY(now, 'work', 6, 6, ty, -1), ty); // 더 위에 넘을 것이 없다
  ty = stepY(now, 'work', 6, 6, ty, 1);
  assert.deepEqual(tops(landing(now, 'work', 6, ty, GAP)).work, [6, 244]);
  assert.equal(stepY(now, 'work', 6, 6, ty, 1), ty);
  // 왼쪽 열(캘린더)로 옮기면 캘린더 하나를 넘는다
  assert.deepEqual(tops(landing(now, 'work', 0, stepY(now, 'work', 0, 6, 0, 1), GAP)).work, [0, 492]);
});

// 이유(유건 10/1 저녁): 가장자리 크기 조절은 그 모듈만 — 옆 모듈과 경계를 같이 끌지 않는다. 늘어나 겹치면 겹친 모듈이 아래로 밀린다.
test('크기 조절: 그 모듈만, 격자·열 범위 안, 겹치면 아래로 밀기', () => {
  assert.deepEqual(resizeX({ x: 0, w: 6, d: 3, side: 'r', ra: [3, 12] }), { x: 0, w: 9 });
  assert.deepEqual(resizeX({ x: 6, w: 6, d: 3, side: 'r', ra: [3, 12] }), { x: 6, w: 6 }); // 격자 끝
  assert.deepEqual(resizeX({ x: 6, w: 6, d: -2, side: 'l', ra: [3, 12] }), { x: 4, w: 8 }); // 왼쪽으로 끌면 시작 열도 왼쪽으로
  assert.deepEqual(resizeX({ x: 2, w: 6, d: -5, side: 'l', ra: [3, 12] }), { x: 0, w: 8 }); // 0열에서 멈춘다
  assert.deepEqual(resizeX({ x: 4, w: 8, d: 4, side: 'l', ra: [8, 12] }), { x: 4, w: 8 }); // 최소 열(현황 8열)
  const now = [box('cal', 0, 6, 0, 480), box('todos', 6, 6, 0, 232), box('work', 6, 6, 244, 232)];
  assert.deepEqual(tops(around(now, 'todos', { x: 4, w: 8 }, GAP)), { todos: [4, 0], cal: [0, 244], work: [6, 244] }); // 왼쪽으로 늘린 할 일이 캘린더를 민다
  assert.deepEqual(tops(around(now, 'todos', { h: 400 }, GAP)), { cal: [0, 0], todos: [6, 0], work: [6, 412] }); // 높이는 그 모듈만, 아래가 밀린다
});

// 이유: 8px 눈금으로는 오른쪽 두 모듈 + 틈이 왼쪽 큰 모듈과 4px 어긋난다 — 끌다가 6px 안에 오면 아래 끝을 맞춘다.
test('높이 자석: 다른 모듈 아래 끝 6px 안이면 맞춘다', () => {
  assert.equal(magnet(snapH(236), 244, [480, 232]), 236);
  assert.equal(magnet(snapH(229), 244, [480, 232]), 236); // 눈금 232 → 아래 끝 476, 480과 4px — 236으로 맞춘다
  assert.equal(magnet(200, 244, [480, 232]), 200);
  assert.equal(magnet(232, 244, [480], 300), 232); // 최소보다 작아지는 자석은 무시
});

// 이유(유건 10/1 저녁): 크기 되돌리기는 그 모듈만 — 옆 모듈의 폭·높이는 그대로.
test('크기 되돌리기: 그 모듈만', () => {
  const modOf = () => ({ sizes: ['s', 'm', 'l', 'full'] });
  const items = applySizes([{ id: 'a', size: 'm' }, { id: 'b', size: 'm' }], { a: { span: 9, h: 400 }, b: { span: 3, h: 400 } }, modOf);
  assert.deepEqual(resetSize(items, 'a', modOf), [{ id: 'a', size: 'm' }, items[1]]);
  assert.deepEqual(resetPatch(items, 'b', 'h'), { b: { h: 0 } });
  assert.deepEqual(resetPatch([{ id: 'c', size: 'm' }], 'c'), {});
});

// 이유: 저장은 x·y를 더하고 옛 필드를 지킨다 — y→x 순으로 정렬(옛 앱은 순서·열 수로 그린다), 숨긴 모듈은 뒤에 그대로.
test('저장할 항목: x·y를 더하고 y→x 순, 숨긴 모듈·옛 필드 보존', () => {
  const items = [{ id: 'cal', size: 'm', h: 480, cfg: { v: 'month' } }, { id: 'hid', size: 's', hidden: true, x: 3, y: 9 }, { id: 'todos', size: 'm', span: 6, baseSize: 'm' }, { id: 'work', size: 'm' }];
  const placed = landing([box('cal', 0, 6, 0, 480), box('todos', 6, 6, 0, 232), box('work', 6, 6, 244, 232)], 'work', 6, 40, GAP);
  const next = settle(items, placed);
  assert.deepEqual(next, [
    { id: 'cal', size: 'm', h: 480, cfg: { v: 'month' }, x: 0, y: 0 },
    { id: 'work', size: 'm', x: 6, y: 1 },
    { id: 'todos', size: 'm', span: 6, baseSize: 'm', x: 6, y: 2 },
    { id: 'hid', size: 's', hidden: true, x: 3, y: 9 },
  ]);
  // 다시 읽어 그리면 같은 자리(순서 y만으로 중력이 같은 배치를 만든다)
  const again = pack(freeOrder(next.filter((it) => !it.hidden)).map(({ it, x }) => ({ id: it.id, x, w: 6, h: { cal: 480, todos: 232, work: 232 }[it.id] })), GAP);
  assert.deepEqual(tops(again), tops(placed));
  // 좁은 폭에서 순서만 바꾸면 넓은 화면의 열은 그대로
  assert.deepEqual(settle(items, [box('todos', 0, 12, 0, 232), box('cal', 0, 12, 244, 480), box('work', 0, 12, 736, 232)], new Map([['todos', 6], ['cal', 0], ['work', 6]])).map((it) => [it.id, it.x, it.y]),
    [['todos', 6, 0], ['cal', 0, 1], ['work', 6, 2], ['hid', 3, 9]]);
});
