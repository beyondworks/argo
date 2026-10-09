// 11차(유건 10/2) — 어느 화면에서든 끌어 감싸 여러 개 고르기·고른 모듈 한꺼번에 옮기기. 규칙마다 이유 한 줄. node --test test/*.test.mjs
// 앞 절반은 손대기 전에 잠근 인접 행동이다 — 선택 상자를 넣어도 그대로여야 한다(입력칸·편집기 안 끌기, 모듈 안 글자 선택, 손잡이·열 경계선, 9차 한 개 옮기기).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tidy } from '../src/core/layout.js';
import { drop, stepTarget, flatTarget, dropGroup, collapse, expand, groupOrder, groupMin, dropMany, shapeOf, isMulti, insertShape, shapeSlot } from '../src/core/block-move.js';

// 화면 없이 시험하는 작은 가짜 요소 — closest·matches는 아래 선택자 몇 가지만 안다(태그·속성·역할·클래스)
function el(tag, attrs = {}, parent = null) {
  const node = { tagName: tag.toUpperCase(), attrs, parentElement: parent, isContentEditable: false, cls: (attrs.class ?? '').split(' ').filter(Boolean) };
  node.getAttribute = (k) => (k in attrs ? String(attrs[k]) : null);
  node.hasAttribute = (k) => k in attrs;
  node.matches = (sel) => sel.split(',').map((x) => x.trim()).some((one) => match(node, one));
  node.closest = (sel) => { for (let n = node; n; n = n.parentElement) if (n.matches(sel)) return n; return null; };
  node.contains = (other) => { for (let n = other; n; n = n.parentElement) if (n === node) return true; return false; };
  node.isContentEditable = (() => { for (let n = node; n; n = n.parentElement) { const v = n.attrs.contenteditable; if (v != null) return v !== 'false'; } return false; })();
  return node;
}
function match(n, sel) { // 자손 선택자('a b')까지
  const parts = sel.trim().split(/\s+/);
  if (!one(n, parts.at(-1))) return false;
  let k = parts.length - 2;
  for (let a = n.parentElement; a && k >= 0; a = a.parentElement) if (one(a, parts[k])) k--;
  return k < 0;
}
function one(n, one) {
  const m = /^([a-z]*)((?:\[[^\]]+\]|\.[\w-]+)*)$/i.exec(one);
  if (!m) return false;
  if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(/\[[^\]]+\]|\.[\w-]+/g) ?? []) {
    if (part.startsWith('.')) { if (!n.cls.includes(part.slice(1))) return false; continue; }
    const [, k, v] = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(part);
    if (!(k in n.attrs) || (v !== undefined && String(n.attrs[k]) !== v)) return false;
  }
  return true;
}
globalThis.window = undefined; // 감지 코드는 창이 있을 때만 붙는다 — 시험은 판정 함수만
const { startKind, clickItem } = await import('../src/core/selection.js');

const content = el('div', { class: 'content' });
const grid = el('div', { class: 'grid', 'data-sel-scope': 'mod:home' }, content);
const card = el('section', { class: 'module', 'data-sel': 'calendar' }, grid);
const head = el('header', { class: 'module-head' }, card);
const title = el('a', { href: '/x', class: 'module-title' }, el('h3', {}, head));
const grip = el('button', { type: 'button', class: 'grip' }, head);
const body = el('div', { class: 'module-body' }, card);
const text = el('p', {}, body);
const edge = el('span', { class: 'edge edge-b', role: 'separator' }, card);
const gap = el('span', { class: 'col-gap', role: 'separator' }, grid);

// ── 손대기 전에 잠근 인접 행동 ──

// 이유(유건 10/2): 입력칸·편집기 안에서 끌면 글자 선택이 그대로다 — 선택 상자로 바뀌지 않는다(편집기 글 안도, 그 안의 모듈 섬은 아니다).
test('잠금: 입력칸·편집기 안 끌기는 선택 상자가 아니다', () => {
  const input = el('input', { type: 'text' }, body);
  const area = el('textarea', {}, body);
  const pm = el('div', { class: 'ProseMirror', contenteditable: 'true' }, el('div', {}, content));
  const para = el('p', {}, pm);
  for (const target of [input, area, pm, para, el('span', {}, para)]) assert.equal(startKind(target), 'native');
  const island = el('div', { class: 'page-module-node', contenteditable: 'false' }, pm); // 페이지 안 모듈(편집기 속 섬)
  const pg = el('div', { class: 'grid', 'data-sel-scope': 'mod:p' }, island), pc = el('section', { class: 'module', 'data-sel': 'a' }, pg);
  assert.equal(startKind(el('p', {}, pc)), 'item');
  assert.equal(clickItem(para), null);
});

// 이유(유건 10/2 "가림 해제"·노션식): 페이지 본문(블록 묶음)은 글자 선택으로 시작 — 처음 블록 밖으로 나가면 블록 고르기('item'). 본문 안 링크·할 일 체크는 그대로
test('편집기 본문: 블록 글자 위는 글자 선택으로 시작', () => {
  const wrap = el('div', { class: 'editor', 'data-sel-scope': 'page:p1', 'data-sel-blocks': '' }, content);
  const pm = el('div', { class: 'ProseMirror', contenteditable: 'true' }, wrap);
  const block = el('p', {}, pm), word = el('strong', {}, block);
  assert.equal(startKind(word), 'item');
  assert.equal(startKind(block), 'item');
  assert.equal(startKind(el('a', { href: 'https://x' }, block)), 'native');
  assert.equal(startKind(el('input', { type: 'checkbox' }, el('label', {}, el('li', {}, pm)))), 'native');
  assert.equal(clickItem(word), null); // 본문은 이어진 범위라 ⇧/⌘ 클릭으로 하나씩 더하지 않는다(편집기 글자 선택 그대로)
});

// 이유(유건 10/2 노션식): 모듈 안 글자 위에서 누르면 처음에는 글자 선택 — 처음 누른 모듈 밖으로 나가기 전까지는 브라우저 글자 선택 그대로('item' = 기다림).
test('잠금: 모듈 안 글자 위는 글자 선택으로 시작한다', () => {
  assert.equal(startKind(text), 'item');
  assert.equal(startKind(body), 'item');
  assert.equal(startKind(card), 'item');
});

// 이유: 9차 손잡이(⋮⋮)·아래 가장자리 높이·열 경계선·제목 링크·단추·체크박스는 그 요소 동작이 이긴다.
test('잠금: 손잡이·가장자리·열 경계선·링크·단추는 본래 동작', () => {
  for (const target of [grip, edge, gap, title, el('button', {}, body), el('span', {}, el('button', {}, body)), el('input', { type: 'checkbox' }, body), el('select', {}, body), el('label', {}, body)]) assert.equal(startKind(target), 'native', target.tagName);
  const menu = el('div', { class: 'menu' }, content), dialog = el('div', { role: 'dialog' }, content);
  assert.equal(startKind(el('span', {}, menu)), 'native');
  assert.equal(startKind(el('span', {}, dialog)), 'native');
});

// 이유: 끌어 옮기기가 원래 있는 항목(메일을 크루에게·산출물·칸반 카드 — dnd-kit)과 거래처 표 칸 고르기는 그 끌기가 이긴다.
test('잠금: 이미 끌기가 있는 항목·표 칸 고르기는 그 끌기', () => {
  const list = el('section', { 'data-sel-scope': 'mail' }, content);
  const row = el('button', { type: 'button', 'data-sel': 'm1', 'aria-roledescription': 'draggable' }, list);
  assert.equal(startKind(el('span', {}, row)), 'native');
  const pick = el('div', { class: 'cell-pick', 'data-sel-native': '' }, content);
  assert.equal(startKind(el('td', {}, el('tr', { 'data-sel': 'c1' }, pick))), 'native');
});

// ── 11차 새 규칙 ──

// 이유(유건 10/2 "어디서든 시작"): 모듈 사이 틈·여백·빈 곳은 바로 선택 상자. 행 전체가 단추인 목록(결정 기록 등)과 행 전체 열기 단추([data-sel-body])는 항목 안으로 본다.
test('시작: 빈 곳은 바로, 행 단추·열기 단추는 항목 안', () => {
  assert.equal(startKind(grid), 'box');
  assert.equal(startKind(content), 'box');
  assert.equal(startKind(el('div', { class: 'page-wrap' }, content)), 'box');
  const list = el('div', { 'data-sel-scope': 'dec' }, content);
  const recRow = el('button', { type: 'button', class: 'rec-row', 'data-sel': 'd1' }, list);
  assert.equal(startKind(el('span', { class: 'rec-text' }, recRow)), 'item');
  const ap = el('div', { class: 'rec-row', 'data-sel': 'a1' }, list), open = el('button', { type: 'button', 'data-sel-body': '' }, ap);
  assert.equal(startKind(el('span', {}, open)), 'item');
  assert.equal(startKind(el('button', { type: 'button', class: 'btn' }, el('span', { class: 'ap-quick' }, ap))), 'native'); // 바로 승인 단추
});

// 이유(유건 10/2): ⇧/⌘ + 클릭 = 하나 더하기·빼기 — 모듈 안 목록은 거의 다 링크라 링크·단추 위여도 고른다(⌘클릭이 새 탭을 열면 안 된다, 5400 실측).
// 체크박스·입력칸·손잡이 위는 그 요소 차례, 끌어 옮기는 항목(메일 행)도 고를 수 있다.
test('⇧/⌘ 클릭: 고를 항목', () => {
  assert.equal(clickItem(text), card);
  assert.equal(clickItem(grip), null);
  assert.equal(clickItem(title), card); // 모듈 제목 링크·목록 링크
  assert.equal(clickItem(el('span', {}, el('a', { href: '/o/x/journal' }, body))), card);
  assert.equal(clickItem(el('input', { type: 'checkbox' }, body)), null);
  assert.equal(clickItem(edge), null);
  const row = el('button', { type: 'button', 'data-sel': 'm1', 'aria-roledescription': 'draggable' }, el('section', { 'data-sel-scope': 'mail' }, content));
  assert.equal(clickItem(el('span', {}, row)), row);
  const vrow = el('div', { role: 'button', 'data-sel': 'v1' }, content);
  assert.equal(clickItem(el('button', { type: 'button', class: 'vw-check', role: 'checkbox' }, vrow)), null); // 완료 체크
  assert.equal(clickItem(content), null);
});

import { hits, combine, rectOf, pickRoot, sameSet } from '../src/ui/marquee-model.js';

// 이유: 사각형에 걸치면 골라진다(완전히 감쌀 필요 없음), ⇧/⌘ 누른 채 끌면 기존 선택에 더한다.
test('사각형: 걸친 항목, 더하기', () => {
  const boxes = [{ key: 'a', left: 0, top: 0, right: 100, bottom: 50 }, { key: 'b', left: 0, top: 60, right: 100, bottom: 110 }, { key: 'c', left: 200, top: 0, right: 300, bottom: 50 }];
  assert.deepEqual(hits(rectOf({ x: 90, y: 40 }, { x: 150, y: 70 }), boxes), ['a', 'b']);
  assert.deepEqual([...combine(new Set(['c']), ['a'], true)].sort(), ['a', 'c']);
  assert.deepEqual([...combine(new Set(['c']), ['a'], false)], ['a']);
  assert.equal(sameSet(new Set(['a', 'b']), new Set(['b', 'a'])), true);
  assert.equal(pickRoot([{ left: 0, top: 0, right: 10, bottom: 10 }, { left: 0, top: 0, right: 100, bottom: 100 }], { x: 50, y: 50 }), 1);
  assert.equal(pickRoot([{ left: 0, top: 0, right: 10, bottom: 10 }, { left: 0, top: 0, right: 100, bottom: 100 }], { x: 500, y: 50 }), 1);
});

// ── 고른 모듈 한꺼번에 옮기기 ──
const minOf = (id) => (id === 'stats' ? 16 : 6);
const ids = (rows) => rows.map((row) => row.map((col) => `${col.w}:${col.ids.join('+')}`).join(' | '));
const ROWS = tidy([[{ w: 24, ids: ['stats'] }], [{ w: 8, ids: ['calendar'] }, { w: 16, ids: ['todos', 'mail'] }], [{ w: 12, ids: ['work'] }, { w: 12, ids: ['approvals'] }], [{ w: 24, ids: ['pages'] }]], minOf);

// 이유(9차 잠금 그대로): 하나만 고른 옮기기는 9차 drop과 같은 결과다(여러 개 경로를 타도).
test('잠금: 한 개는 9차 놓기와 같다', () => {
  const tg = { kind: 'col', anchor: 'mail', after: false };
  assert.deepEqual(dropGroup(ROWS, 'pages', ['pages'], tg, minOf), drop(ROWS, 'pages', tg, minOf));
  const side = { kind: 'side', anchor: 'pages', after: true };
  assert.deepEqual(dropGroup(ROWS, 'calendar', ['calendar'], side, minOf), drop(ROWS, 'calendar', side, minOf));
});

// 이유(유건 10/2 정정 — 한 열 구조): 고른 것이 전부 위아래 관계면 놓은 자리에 원래 순서(줄 → 열 → 위아래)대로 위아래로 쌓인다. 잡은 손잡이가 몇 번째든 순서는 화면 순서.
test('여러 개: 놓은 열에 원래 순서대로 쌓는다', () => {
  const g = new Set(['pages', 'calendar', 'work']);
  const list = groupOrder(ROWS, g);
  assert.deepEqual(list, ['calendar', 'work', 'pages']);
  assert.deepEqual(ids(dropGroup(ROWS, 'pages', list, { kind: 'col', anchor: 'mail', after: true }, minOf)), ['24:stats', '24:todos', '24:mail', '24:calendar', '24:work', '24:pages', '24:approvals']); // 캘린더가 빠진 줄은 전체 폭(빈 열 정리), 메일 아래 새 줄에 셋이 차례로
  assert.deepEqual(ids(dropGroup(ROWS, 'calendar', list, { kind: 'col', anchor: 'mail', after: false }, minOf)), ['24:stats', '24:calendar', '24:work', '24:pages', '24:todos', '24:mail', '24:approvals']); // 잡은 모듈이 빠져 열 하나가 된 줄은 9차처럼 그 줄 위에(한 개 옮기기와 같은 결과)
  assert.deepEqual(ids(drop(ROWS, 'calendar', { kind: 'col', anchor: 'mail', after: false }, minOf)).slice(0, 3), ['24:stats', '24:calendar', '24:todos']);
});

// 이유: 새 열에 놓으면 그 열 하나에 쌓인다(4열·최소 폭 규칙 유지, 쌓인 묶음의 최소 폭 = 가장 넓은 것).
test('여러 개: 새 열 하나에 쌓기·4열 제한', () => {
  const rows = tidy([[{ w: 24, ids: ['stats'] }], [{ w: 24, ids: ['calendar'] }], [{ w: 24, ids: ['todos'] }], [{ w: 24, ids: ['approvals'] }], [{ w: 24, ids: ['mail'] }]], minOf);
  const out = dropGroup(rows, 'approvals', ['todos', 'approvals'], { kind: 'side', anchor: 'calendar', after: true }, minOf);
  assert.deepEqual(ids(out), ['24:stats', '12:calendar | 12:todos+approvals', '24:mail']);
  const into = dropGroup(out, 'mail', ['stats', 'mail'], { kind: 'side', anchor: 'calendar', after: false }, minOf); // 현황(16) + 캘린더 + 할 일 열 = 16 + 6 + 6 > 24
  assert.equal(into, null);
  const four = tidy([['a', 'b', 'c', 'd'].map((id) => ({ w: 6, ids: [id] })), [{ w: 24, ids: ['e'] }], [{ w: 24, ids: ['f'] }]], minOf);
  assert.equal(dropGroup(four, 'e', ['e', 'f'], { kind: 'side', anchor: 'a', after: false }, minOf), null);
  assert.deepEqual(ids(dropGroup(four, 'e', ['e', 'f'], { kind: 'col', anchor: 'b', after: true }, minOf)), ['6:a | 6:b+e+f | 6:c | 6:d']);
});

// 이유: 고른 모듈 위(자기 묶음)에 놓거나 결과가 지금과 같으면 아무것도 안 한다(선을 숨기고 저장하지 않는다). 빈 열·줄은 정리된다.
test('여러 개: 자기 위·그대로면 없음, 빈 열 정리', () => {
  const list = ['work', 'approvals'];
  assert.equal(dropGroup(ROWS, 'work', list, { kind: 'col', anchor: 'approvals', after: true }, minOf), null);
  assert.equal(dropGroup(ROWS, 'work', list, { kind: 'col', anchor: 'work', after: true }, minOf), null);
  assert.deepEqual(ids(dropGroup(ROWS, 'approvals', list, { kind: 'row', anchor: null, after: false }, minOf)), ['24:work', '24:approvals', '24:stats', '8:calendar | 16:todos+mail', '24:pages']);
  assert.deepEqual(ids(collapse(ROWS, 'work', new Set(list), minOf)), ['24:stats', '8:calendar | 16:todos+mail', '24:work', '24:pages']);
  assert.deepEqual(ids(expand(collapse(ROWS, 'work', new Set(list), minOf), 'work', list, minOf)), ['24:stats', '8:calendar | 16:todos+mail', '24:work', '24:approvals', '24:pages']);
  assert.equal(groupMin('work', ['stats', 'work'], minOf)('work'), 16);
});

// 이유(9차 키 규칙): 고른 상태에서 손잡이 Space/Enter = 전부 들기 — 화살표는 잡은 모듈 하나처럼 움직이고, 놓으면 그 자리에 쌓인다.
test('여러 개 키보드: 한 모듈처럼 한 칸씩', () => {
  const list = ['calendar', 'pages'];
  const base = collapse(ROWS, 'pages', new Set(list), minOf);
  assert.deepEqual(ids(base), ['24:stats', '24:todos', '24:mail', '12:work | 12:approvals', '24:pages']);
  const tg = stepTarget(base, 'pages', 'ArrowUp', 0);
  const moved = drop(base, 'pages', tg, groupMin('pages', list, minOf));
  assert.deepEqual(ids(expand(moved, 'pages', list, minOf)), ['24:stats', '24:todos', '24:mail', '12:work+calendar+pages | 12:approvals']); // 위 줄 첫 열(기억한 열 0) 맨 아래에 둘이 차례로
  assert.deepEqual(flatTarget(base, 'pages', 1), { kind: 'row', anchor: 'stats', after: true });
});

// ── 정정(유건 10/2, refs10/15~17): 함께 옮기면 원래 배치를 그대로 따라간다 ──

// 이유(제보): 같은 줄에 나란히 있던 결재 대기·에이전트 작업을 현황 위로 옮겼더니 1열씩 2줄로 쌓였다 — 나란히·폭 비율 그대로 한 줄로 가야 한다.
test('정정: 나란히 2개는 다른 줄 사이로 옮겨도 나란히·폭 비율 유지', () => {
  const list = ['work', 'approvals'];
  assert.equal(isMulti(shapeOf(ROWS, new Set(list))), true);
  assert.deepEqual(ids(dropMany(ROWS, 'approvals', list, { kind: 'row', anchor: 'stats', after: false }, minOf)), ['12:work | 12:approvals', '24:stats', '8:calendar | 16:todos+mail', '24:pages']);
  assert.deepEqual(ids(dropMany(ROWS, 'work', list, { kind: 'row', anchor: null, after: true }, minOf)), ['24:stats', '8:calendar | 16:todos+mail', '24:pages', '12:work | 12:approvals']);
  const three = tidy([[{ w: 6, ids: ['a'] }, { w: 6, ids: ['b'] }, { w: 12, ids: ['c'] }], [{ w: 24, ids: ['d'] }]], minOf);
  assert.deepEqual(ids(dropMany(three, 'a', ['a', 'c'], { kind: 'row', anchor: null, after: true }, minOf)), ['24:b', '24:d', '8:a | 16:c']); // 고른 것끼리 다시 합 24(6:12 → 8:16), 빠진 b는 혼자 전체 폭
});

// 이유: 같은 열에 위아래로 있던 것은 다른 열로 옮겨도 위아래(한 열 구조는 9차 규칙대로 어디든 — 열 안·새 열).
test('정정: 위아래 2개는 다른 열로 옮겨도 위아래', () => {
  const list = ['todos', 'mail'];
  assert.equal(isMulti(shapeOf(ROWS, new Set(list))), false);
  assert.deepEqual(ids(dropMany(ROWS, 'mail', list, { kind: 'col', anchor: 'approvals', after: true }, minOf)), ['24:stats', '24:calendar', '12:work | 12:approvals+todos+mail', '24:pages']);
  assert.deepEqual(ids(dropMany(ROWS, 'todos', list, { kind: 'side', anchor: 'pages', after: true }, minOf)), ['24:stats', '24:calendar', '12:work | 12:approvals', '12:pages | 12:todos+mail']);
});

// 이유: 서로 다른 줄에서 고른 것은 원래 줄마다 새 줄 — 각각 열 안에 있던 둘을 줄 사이에 놓으면 줄 2개가 된다(각 줄 안 열 구조 유지).
test('정정: 서로 다른 줄 2개는 줄 2개로', () => {
  assert.deepEqual(ids(dropMany(ROWS, 'approvals', ['calendar', 'approvals'], { kind: 'row', anchor: 'stats', after: false }, minOf)), ['24:calendar', '24:approvals', '24:stats', '24:todos', '24:mail', '24:work', '24:pages']);
  const rows = tidy([[{ w: 12, ids: ['a'] }, { w: 12, ids: ['b'] }], [{ w: 24, ids: ['x'] }], [{ w: 8, ids: ['c'] }, { w: 16, ids: ['d'] }]], minOf);
  assert.deepEqual(ids(dropMany(rows, 'c', ['a', 'b', 'c', 'd'], { kind: 'row', anchor: null, after: true }, minOf)), ['24:x', '12:a | 12:b', '8:c | 16:d']); // 두 줄 다 열 구조 그대로, 원래 순서
});

// 이유: 여러 열 구조는 줄 사이 전체 폭 가로선에만 놓을 수 있다 — 열 안·옆 세로선은 없다(열 안에 열을 넣는 구조가 없다). 자기 줄 그대로면 아무것도 안 한다.
test('정정: 여러 열 구조는 세로선·열 안 놓기 불가, 그대로면 없음', () => {
  const list = ['work', 'approvals'];
  assert.equal(dropMany(ROWS, 'work', list, { kind: 'side', anchor: 'pages', after: true }, minOf), null);
  assert.equal(dropMany(ROWS, 'work', list, { kind: 'col', anchor: 'mail', after: true }, minOf), null);
  assert.equal(dropMany(ROWS, 'work', list, { kind: 'row', anchor: 'pages', after: false }, minOf), null); // 원래 자리(현황·캘린더 줄 다음, 페이지 앞)
  assert.equal(dropMany(ROWS, 'work', list, { kind: 'row', anchor: 'work', after: false }, minOf), null); // 고른 것 위
});

// 이유: 키보드 함께 옮기기도 같은 규칙 — 여러 열 구조는 ↑/↓로 줄 사이 자리(slot)만 한 칸씩, 결과는 같은 모양.
test('정정: 여러 열 구조 키보드는 줄 사이 자리만', () => {
  const list = ['work', 'approvals'];
  const at = shapeSlot(ROWS, list, minOf);
  assert.equal(at, 2); // 현황·캘린더 줄 다음
  assert.deepEqual(ids(insertShape(ROWS, list, at - 1, minOf)), ['24:stats', '12:work | 12:approvals', '8:calendar | 16:todos+mail', '24:pages']);
  assert.deepEqual(ids(insertShape(ROWS, list, at, minOf)), ids(ROWS));
  assert.deepEqual(ids(insertShape(ROWS, list, 3, minOf)), ['24:stats', '8:calendar | 16:todos+mail', '24:pages', '12:work | 12:approvals']);
});

// ── 12차(유건 10/2, refs10/18~20): 칸 단위 영역 선택 + 수정키 ──
import { dragMode, clampRect, rangeKeys } from '../src/ui/marquee-model.js';
import { selectable } from '../src/core/people-model.js';

// 이유(제보 18): 사업자등록번호·계좌 열 위로만 그렸는데 줄 3개가 통째로 골라졌다 — 칸이 있는 화면의 기본 끌기는 칸만, ⇧ + 끌기가 줄 통째(11차 기본 동작이 여기로).
// 모듈·블록 화면은 칸이 없어 기본·⇧ 둘 다 모듈·블록, 가릴 칸이 없는 목록(메일 등)은 줄.
test('12차: 기본 끌기 = 칸, ⇧ = 줄 통째, 모듈·블록은 단위', () => {
  assert.equal(dragMode({ shift: false, units: false, hasCells: true }), 'cells');
  assert.equal(dragMode({ shift: true, units: false, hasCells: true }), 'rows');
  assert.equal(dragMode({ shift: false, units: true, hasCells: true }), 'rows');
  assert.equal(dragMode({ shift: false, units: false, hasCells: false }), 'rows');
  const cells = [{ key: 'c1:biz', left: 500, top: 0, right: 600, bottom: 30 }, { key: 'c1:acct', left: 600, top: 0, right: 700, bottom: 30 }, { key: 'c1:phone', left: 200, top: 0, right: 300, bottom: 30 }, { key: 'c2:biz', left: 500, top: 30, right: 600, bottom: 60 }];
  assert.deepEqual(hits(rectOf({ x: 520, y: 5 }, { x: 650, y: 50 }), cells), ['c1:biz', 'c1:acct', 'c2:biz']); // 사각형 안 칸만(같은 줄 전화 칸은 안 고른다)
});

// 이유(유건 원문 "cmd + 클릭 + 드래그는 다중 영역 선택"): ⌘ 끌기 = 기존 선택을 지우지 않고 영역 하나 더, 이미 고른 칸 위에 다시 그리면 빠진다(파일 탐색기 관례 — 토글).
test('12차: ⌘ 끌기 = 영역 더하기·토글', () => {
  const base = new Set(['a', 'b']);
  assert.deepEqual([...combine(base, ['c', 'd'], 'xor')].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...combine(base, ['b', 'c'], 'xor')].sort(), ['a', 'c']);
  assert.deepEqual([...combine(base, ['c'], false)], ['c']); // 수정키 없으면 새로
});

// 이유: ⇧ + 클릭(끌지 않음) = 마지막으로 고른 것부터 여기까지(화면 순서, 어느 방향이든). ⌘ + 클릭은 하나 더하기·빼기 그대로.
test('12차: ⇧ 클릭 범위', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(rangeKeys(keys, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(rangeKeys(keys, 'e', 'c'), ['c', 'd', 'e']);
  assert.deepEqual(rangeKeys(keys, 'x', 'c'), ['c']);
});

// 이유(제보 19): 줄을 따라 끌면 가는 막대(선택 상자)가 표 오른쪽 밖까지 튀어나왔다 — 그리는 상자는 시작한 표 안으로 자른다(고르는 것은 그대로).
test('12차: 선택 상자는 표 밖으로 그리지 않는다', () => {
  assert.deepEqual(clampRect({ l: 613, t: 495, r: 1410, b: 498 }, { left: 424, top: 372, right: 1370, bottom: 515 }), { l: 613, t: 495, r: 1370, b: 498 });
});

// 이유(제보 20): 직원에서 회색 줄 4·체크 3(계정만 있는 직원은 체크박스가 없었다)·막대 "4개 선택됨"이 달랐다 — 고를 수 있는 줄 = 체크박스가 있는 줄 = 개수, 지우기는 명부 직원만.
test('12차: 직원 선택 표시·체크박스·개수 일치', () => {
  const list = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: null, user_id: 'u9' }];
  const sel = new Set(['p1', 'p2', 'p3', 'u:u9']);
  const s = selectable(list, sel);
  assert.deepEqual(s.keys, ['p1', 'p2', 'p3', 'u:u9']); // 계정만 있는 직원도 체크박스가 있다
  assert.equal(s.picked.length, sel.size); // 회색 = 체크 = 막대 개수
  assert.deepEqual(s.deletable, ['p1', 'p2', 'p3']);
  assert.equal(s.all, true);
  assert.equal(selectable(list, new Set(['p1'])).all, false);
});

// ── 메일 체크박스 고르기(유건 10/9 "이메일 일괄 선택 기능 있어야겠다") ──
import { checkKeys, checkState } from '../src/ui/marquee-model.js';

// 이유: 숨은 손짓(⌘클릭·⌘A)만 있어 유건이 일괄 선택이 없다고 봤다 — 줄마다 보이는 체크박스. 누르면 그 줄 하나만 넣고 뺀다.
test('메일 체크박스: 하나 넣고 빼기', () => {
  const keys = ['a', 'b', 'c', 'd'];
  assert.deepEqual([...checkKeys(new Set(), 'b', { keys })], ['b']);
  assert.deepEqual([...checkKeys(new Set(['a', 'b']), 'b', { keys })], ['a']);
  assert.deepEqual([...checkKeys(new Set(['a']), 'c', { keys, anchor: 'a' })].sort(), ['a', 'c']); // ⇧ 없이 누르면 범위가 아니다
});

// 이유: Gmail 관례 — ⇧ + 체크박스 = 마지막으로 누른 줄부터 여기까지를 누른 줄이 바뀔 상태로(넣기면 다 넣고, 빼기면 다 뺀다). 시작점이 목록에 없으면 하나만.
test('메일 체크박스: ⇧ 범위는 누른 줄 상태를 따른다', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual([...checkKeys(new Set(['b']), 'd', { keys, anchor: 'b', shift: true })].sort(), ['b', 'c', 'd']);
  assert.deepEqual([...checkKeys(new Set(['b']), 'a', { keys, anchor: 'd', shift: true })].sort(), ['a', 'b', 'c', 'd']); // 위로도
  assert.deepEqual([...checkKeys(new Set(['a', 'b', 'c', 'd']), 'c', { keys, anchor: 'a', shift: true })], ['d']); // 고른 줄을 ⇧로 누르면 a~c를 뺀다
  assert.deepEqual([...checkKeys(new Set(), 'c', { keys, anchor: 'gone', shift: true })], ['c']);
});

// 이유: 도구 줄 '전체 선택' — 지금 보이는 목록 기준. 일부만 골랐으면 반쯤(indeterminate), 다시 누르면 전체(앱의 다른 전체 선택 칸과 같은 동작). 사라진 메일은 세지 않는다.
test('메일 전체 선택 칸 상태', () => {
  const keys = ['a', 'b', 'c'];
  assert.equal(checkState(new Set(), keys), 'none');
  assert.equal(checkState(new Set(['a']), keys), 'some');
  assert.equal(checkState(new Set(['a', 'b', 'c']), keys), 'all');
  assert.equal(checkState(new Set(['x']), keys), 'none');
  assert.equal(checkState(new Set(), []), 'none'); // 빈 목록은 '전체'가 아니다
});

// ── 검수 #895 반영(10/9) — 일괄 동작 대상·폰 탭·전체 선택 토글을 행동으로 잠근다 ──
import { bulkTargets, rowTapPicks } from '../src/pages/mail-bulk.js';
import { checkAll } from '../src/ui/marquee-model.js';

const M = (id, o = {}) => ({ id, folder: 'inbox', unread: false, starred: false, ...o });
// 이유(규칙 4, 검수 MEDIUM): 초안에는 별표·보관 단추가 없다(목록 줄·읽기 화면) — 일괄에서도 초안은 별표·별표 빼기·보관 대상이 아니다.
test('일괄 동작: 초안은 별표·별표 빼기·보관에서 빠진다', () => {
  const starredMail = M('m4', { starred: true }), draft = M('d1', { folder: 'drafts' });
  const b = bulkTargets([starredMail, draft], 'inbox');
  assert.deepEqual(b.unstar.map((m) => m.id), ['m4']); // 별표 메일 + 초안 → 별표 빼기는 메일만(전에는 아무것도 안 나왔다)
  assert.deepEqual(b.star, []);
  assert.deepEqual(b.archive.map((m) => m.id), ['m4']);
  const onlyDrafts = bulkTargets([M('d2', { folder: 'drafts', starred: true })], 'drafts');
  assert.deepEqual([onlyDrafts.star, onlyDrafts.unstar, onlyDrafts.archive], [[], [], []]); // Gmail에서 별표 붙은 초안도 건드리지 않는다
});

// 이유: 단일 'e'처럼 이미 보관한 메일은 다시 보관하지 않는다(검색 결과에 섞여 토스트 수가 틀렸다). 보관함 보기에서는 보관이 없다.
test('일괄 동작: 보관 대상', () => {
  const list = [M('a'), M('b', { folder: 'archive' }), M('c', { folder: 'sent' })];
  assert.deepEqual(bulkTargets(list, 'inbox').archive.map((m) => m.id), ['a', 'c']);
  assert.deepEqual(bulkTargets(list, 'archive').archive, []);
});

// 이유: 읽음·안 읽음·별표는 바뀔 메일만 — 안 읽은 것이 하나라도 있으면 '읽음', 모두 읽었으면 '안 읽음', 별표 안 붙은 메일이 있으면 그 메일만 '별표'.
test('일괄 동작: 읽음·안 읽음·별표 대상', () => {
  const b = bulkTargets([M('a', { unread: true }), M('b'), M('c', { starred: true })], 'inbox');
  assert.deepEqual(b.read.map((m) => m.id), ['a']);
  assert.deepEqual(b.unread, []);
  assert.deepEqual(b.star.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(b.unstar, []);
  assert.deepEqual(bulkTargets([M('a'), M('b')], 'inbox').unread.map((m) => m.id), ['a', 'b']);
});

// 이유(규칙 2): 폰(터치)은 한 통이라도 고른 동안 줄을 눌러도 열지 않고 넣고 뺀다. 마우스는 고른 채로도 연다(선택 유지).
test('줄 누르기: 터치 + 고르는 중만 넣고 빼기', () => {
  assert.equal(rowTapPicks(1, true), true);
  assert.equal(rowTapPicks(0, true), false);
  assert.equal(rowTapPicks(3, false), false);
});

// 이유(규칙 3): 전체 선택 칸 — 없음·일부 → 전체, 전체 → 해제.
test('전체 선택 칸 누르기', () => {
  const keys = ['a', 'b', 'c'];
  assert.deepEqual([...checkAll(new Set(), keys)], keys);
  assert.deepEqual([...checkAll(new Set(['a']), keys)], keys);
  assert.deepEqual([...checkAll(new Set(keys), keys)], []);
});
