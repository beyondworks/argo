// 7차(유건 10/2) — 놓은 자리에 그대로(세로 위치 t 저장, 중력 없음)·자리 바꾸기·위 가장자리·되돌리기. 규칙마다 이유 한 줄. node --test test/*.test.mjs
// 앞 절반은 바꾸기 전에 잠근 인접 행동이다 — t를 넣어도 옛 배치·5·6차 저장값은 그대로 그려져야 한다(사용자가 손대기 전 DB 쓰기 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLayout, freeOrder, pack, spanOf, heightOf, hasXY, tOf } from '../src/core/layout.js';
import { normalizeModuleItems } from '../src/core/module-items.js';
import { LIBRARY_MODULES } from '../src/core/module-registry.js';
// pages/modules.jsx DEFAULTS.me 그대로(JSX라 node에서 직접 못 읽는다)
const DEFAULT_HOME = [{ id: 'stats', size: 'full' }, { id: 'approvals', size: 'm' }, { id: 'mail', size: 'm' }, { id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'calendar', size: 'm' }, { id: 'work', size: 'm' }];

const GAP = 12;
const NAT = { stats: 140, calendar: 480, todos: 320, approvals: 320, mail: 320, work: 320, pages: 320 };
/** ModuleGrid가 자유 격자를 그리는 계산 그대로 — 높이는 정한 높이 또는 화면에서 잰 높이 */
const draw = (items) => Object.fromEntries(pack(freeOrder(items.filter((it) => !it.hidden)).map(({ it, x }, o) => ({ id: it.id, x, w: spanOf(it), h: heightOf(it) || NAT[it.moduleId ?? it.id], o, t: tOf(it) })), GAP).map((b) => [b.id, [b.x, b.top]]));

// ── 바꾸기 전에 잠근 인접 행동 ──

// 이유(유건: 바꾼 직후 화면이 달라지면 안 된다): 기본 배치(저장값 없음)는 자리 없는 옛 배치다 — x·y·t 어느 것도 생기지 않아 CSS 격자로 그린다.
test('잠금: 기본 배치는 자리 없는 옛 배치 그대로', () => {
  const home = normalizeModuleItems(mergeLayout(null, LIBRARY_MODULES, 'me', DEFAULT_HOME));
  assert.equal(home.some(hasXY), false);
  assert.equal(home.some((it) => 't' in it), false);
});

// 이유: 5·6차가 저장한 값(x·y·h, t 없음)은 세로 중력으로 쌓은 그 자리 그대로 그린다 — 7차 코드가 읽어도 같은 자리.
test('잠금: t 없는 5·6차 저장값은 중력 쌓기 결과 그대로', () => {
  const saved = { items: [
    { id: 'stats', size: 'full', x: 0, y: 0 }, { id: 'calendar', size: 'm', h: 480, x: 0, y: 1, cfg: { view: 'month' } },
    { id: 'todos', size: 'm', h: 232, x: 6, y: 2 }, { id: 'approvals', size: 'm', h: 236, x: 6, y: 3 }, { id: 'work', size: 'm', x: 0, y: 4 }, { id: 'mail', size: 'm', hidden: true },
  ] };
  const items = normalizeModuleItems(mergeLayout(saved, LIBRARY_MODULES, 'me', []));
  assert.equal(items.some((it) => 't' in it), false);
  assert.deepEqual(draw(items), { stats: [0, 0], calendar: [0, 152], todos: [6, 152], approvals: [6, 396], work: [0, 644] });
});

// ── 7차 새 규칙 ──
import { landing, around, ceiling, settle } from '../src/core/grid-move.js';
import { fitLayout } from '../src/core/fit.js';

const box = (id, x, w, top, h) => ({ id, x, w, top, h });
const tops = (list) => Object.fromEntries(list.map((b) => [b.id, [b.x, b.top]]));
/** 저장한 항목을 다시 그린 자리 — ModuleGrid와 같은 계산(높이는 상자 높이) */
const redraw = (items, hs) => tops(pack(freeOrder(items.filter((it) => !it.hidden)).map(({ it, x }) => ({ id: it.id, x, w: spanOf(it), h: hs[it.id], t: tOf(it) })), GAP));
const hsOf = (boxes) => Object.fromEntries(boxes.map((b) => [b.id, b.h]));
const itemsOf = (boxes) => boxes.map((b) => ({ id: b.id, size: 'm', span: b.w, baseSize: 'm' }));

// 이유: 새 필드 t는 자리(x·y)와 함께일 때만 지킨다 — 정수 0 이상만, 아니면 버려 중력으로 그린다.
test('배치 병합: 올바른 t만 지킨다', () => {
  const REG = [{ id: 'a', sizes: ['m'], defaultSize: 'm', spaces: ['me'] }, { id: 'b', sizes: ['m'], defaultSize: 'm', spaces: ['me'] }, { id: 'c', sizes: ['m'], defaultSize: 'm', spaces: ['me'] }, { id: 'd', sizes: ['m'], defaultSize: 'm', spaces: ['me'] }];
  const out = mergeLayout({ items: [{ id: 'a', size: 'm', x: 0, y: 0, t: 96 }, { id: 'b', size: 'm', x: 6, y: 1, t: -8 }, { id: 'c', size: 'm', t: 40 }, { id: 'd', size: 'm', x: 0, y: 2, t: 12.5 }] }, REG, 'me', []);
  assert.deepEqual(out.map((it) => [it.id, it.t]), [['a', 96], ['b', undefined], ['c', undefined], ['d', undefined]]);
});

// 이유(유건 7차 2): t가 있으면 그 높이에 그대로 — 위가 비어도 올라가지 않는다. 겹치면 아래로 밀리고, 내용 높이가 커져 겹쳐도 아래가 밀린다(겹침 없음).
test('그리기: t 높이에 그대로, 겹치면 아래로', () => {
  const items = [{ id: 'a', size: 'm', x: 0, y: 0, t: 0 }, { id: 'b', size: 'm', x: 6, y: 1, t: 400 }, { id: 'c', size: 'm', x: 0, y: 2, t: 200 }];
  assert.deepEqual(redraw(items, { a: 100, b: 100, c: 100 }), { a: [0, 0], c: [0, 200], b: [6, 400] }); // b 위 빈칸, a·c 사이 빈칸 그대로
  assert.deepEqual(redraw(items, { a: 300, b: 100, c: 100 }), { a: [0, 0], c: [0, 312], b: [6, 400] }); // a가 커지면 c가 밀린다
  // t 순서(같으면 왼쪽부터)가 좁은 폭의 한 줄 순서
  assert.deepEqual(freeOrder(items).map(({ it }) => it.id), ['a', 'c', 'b']);
});

// 이유(유건 7차 1, refs7/12~14): 오른쪽 결재 대기를 왼쪽 에이전트 작업 자리에 놓으면 둘이 자리를 바꾼다 — 왼쪽 모듈들이 아래로 밀리지 않는다.
test('자리 바꾸기: 같은 줄 모듈 위에 놓으면 서로 자리를 바꾼다', () => {
  const now = [box('cal', 0, 6, 0, 480), box('todos', 6, 6, 0, 232), box('mail', 6, 6, 244, 232), box('work', 0, 6, 492, 240), box('pages', 0, 6, 744, 200), box('appr', 6, 6, 488, 360)];
  const out = landing(now, 'appr', 0, 520, GAP); // 윤곽 위 끝이 작업 위 끝과 28px — 작업 높이 절반 안
  assert.equal(out.swap, 'work');
  assert.deepEqual(tops(out), { cal: [0, 0], todos: [6, 0], mail: [6, 244], appr: [0, 492], work: [6, 488], pages: [0, 864] }); // 결재 대기가 더 길어 그 아래 페이지만 밀린다
  // 다시 그려도 같은 자리, 왼쪽의 캘린더는 그대로
  assert.deepEqual(redraw(settle(itemsOf(now), out), hsOf(now)), tops(out));
  // 폭이 다르면 바뀌어 가는 모듈의 열을 12열 안으로 당긴다
  const wide = [box('a', 0, 8, 0, 200), box('b', 8, 4, 0, 200)];
  assert.deepEqual(tops(landing(wide, 'b', 0, 0, GAP)), { b: [0, 0], a: [4, 0] });
  // 같은 줄이 아니면(위 끝이 높이 절반보다 멀면) 바꾸지 않는다
  assert.equal(landing(now, 'appr', 0, 620, GAP).swap, undefined);
});

// 이유: 같은 열에서 위아래로 바꾸면 둘 사이에 빈칸이 생기지 않는다(높이가 달라도).
test('자리 바꾸기: 같은 열 위아래는 붙여서', () => {
  const now = [box('todos', 6, 6, 0, 232), box('work', 6, 6, 244, 100), box('pages', 6, 6, 356, 100)];
  assert.deepEqual(tops(landing(now, 'work', 6, 0, GAP)), { work: [6, 0], todos: [6, 112], pages: [6, 356] });
  assert.deepEqual(tops(landing(now, 'todos', 6, 244, GAP)), { work: [6, 0], todos: [6, 112], pages: [6, 356] });
});

// 이유(유건 7차 2, refs7/15~16): 결재 대기를 아래 빈 곳으로 내리면 그 높이에 그대로 — 위로 붙지 않는다. 다시 그려도 같다.
test('빈 곳에 놓기: 그 높이에 그대로, 빈칸이 남는다', () => {
  const now = [box('cal', 0, 6, 0, 480), box('todos', 6, 6, 0, 232), box('mail', 6, 6, 244, 150), box('appr', 6, 6, 406, 232)];
  const out = landing(now, 'appr', 6, 560, GAP);
  assert.deepEqual(tops(out), { cal: [0, 0], todos: [6, 0], mail: [6, 244], appr: [6, 560] });
  const saved = settle(itemsOf(now), out);
  assert.deepEqual(saved.map((it) => [it.id, it.t]), [['cal', 0], ['todos', 0], ['mail', 244], ['appr', 560]]);
  assert.deepEqual(redraw(saved, hsOf(now)), tops(out));
});

// 이유(유건 7차 3, refs7/17~18): 위 가장자리를 아래로 끌면 아래 끝은 그대로, 위 끝이 내려온다. 위로 끌면 위 모듈 아래 끝 + 틈에서 멈춘다.
test('위 가장자리: 위 끝이 움직이고 아래 끝은 그대로', () => {
  const now = [box('cal', 0, 6, 0, 480), box('mail', 6, 6, 0, 232), box('appr', 6, 6, 244, 400), box('work', 6, 6, 656, 100)];
  const bottom = 244 + 400, h = 320; // 위 끝을 80 내렸다
  const out = around(now, 'appr', { top: bottom - h, h }, GAP);
  assert.deepEqual(tops(out), { cal: [0, 0], mail: [6, 0], appr: [6, 324], work: [6, 656] });
  assert.equal(out.find((b) => b.id === 'appr').top + h, bottom);
  assert.equal(ceiling(now, 'appr', GAP), 244); // 위로는 메일 아래 끝 + 틈까지
  assert.equal(ceiling(now, 'mail', GAP), 0);
  const saved = settle(itemsOf(now).map((it) => (it.id === 'appr' ? { ...it, h } : it)), out);
  assert.deepEqual(redraw(saved, { ...hsOf(now), appr: h }), tops(out));
});

// 이유: 크기를 바꿔도 중력은 없다 — 줄여도 아래 모듈은 그대로(빈칸), 늘려 겹치면 그 모듈만 아래로.
test('크기 조절: 줄이면 빈칸, 늘리면 겹친 모듈만 밀린다', () => {
  const now = [box('mail', 6, 6, 0, 232), box('appr', 6, 6, 244, 200)];
  assert.deepEqual(tops(around(now, 'mail', { h: 120 }, GAP)), { mail: [6, 0], appr: [6, 244] });
  assert.deepEqual(tops(around(now, 'mail', { h: 300 }, GAP)), { mail: [6, 0], appr: [6, 312] });
});

// 이유(정한 설계): 모듈 맞춤은 정리 동작 — 높이를 맞춘 뒤 t를 중력으로 다시 계산해 빈칸을 없앤다. t 없던 배치는 t만 생겨서는 저장하지 않는다.
test('모듈 맞춤: 빈칸을 정리하고, 이미 맞으면 저장 0', () => {
  const nat = { a: 200, b: 200 }, min = { a: 120, b: 120 }, opts = (cur) => ({ cur, nat, min, stack: () => false, gap: GAP });
  const gapped = [{ id: 'a', size: 'full', x: 0, y: 0, t: 0 }, { id: 'b', size: 'full', x: 0, y: 1, t: 600 }];
  const out = fitLayout(gapped, opts({ a: 200, b: 200 }));
  assert.deepEqual(out.map((it) => [it.id, it.t]), [['a', 0], ['b', 212]]);
  assert.equal(fitLayout(out, opts({ a: 200, b: 200 })), null);
  assert.equal(fitLayout([{ id: 'a', size: 'full', x: 0, y: 0 }, { id: 'b', size: 'full', x: 0, y: 1 }], opts({ a: 200, b: 200 })), null);
});
