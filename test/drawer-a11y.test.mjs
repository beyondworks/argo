// UL9(2026-10-05 분리 검수): 폰 폭 사이드바 서랍이 Esc로 안 닫히고, 열어도 포커스가 서랍 안으로 안 갔다(키보드·화면 낭독기 사용자는 서랍 뒤 본문에 머문다).
// 잠그는 행동(JSX 없이): Esc 판정(열려 있을 때만·IME 조합 중·다른 곳이 이미 처리한 키는 제외)과 서랍을 열 때의 포커스 대상.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerKeyAction, drawerFocusTarget } from '../app/c/[ws]/drawer.mjs';

test('Esc는 열린 서랍만 닫는다 — 닫혀 있거나 다른 키면 아무것도 하지 않는다', () => {
  assert.equal(drawerKeyAction({ key: 'Escape', open: true }), 'close');
  assert.equal(drawerKeyAction({ key: 'Escape', open: false }), null);
  assert.equal(drawerKeyAction({ key: 'Enter', open: true }), null);
  assert.equal(drawerKeyAction({ key: 'a', open: true }), null);
});

test('IME 조합 중 Esc(한글 입력 취소)·다른 곳이 이미 처리한 Esc는 서랍을 닫지 않는다', () => {
  assert.equal(drawerKeyAction({ key: 'Escape', open: true, composing: true }), null);
  assert.equal(drawerKeyAction({ key: 'Escape', open: true, defaultPrevented: true }), null, '입력창의 자동완성·모달이 먼저 쓴 Esc');
});

test('서랍을 열면 포커스는 서랍 안 첫 조작 요소로, 없으면 서랍 자체로', () => {
  const first = { name: 'logo-link' };
  const container = { querySelector: (sel) => (sel.includes('a[href]') ? first : null) };
  assert.equal(drawerFocusTarget(container), first);
  const empty = { querySelector: () => null };
  assert.equal(drawerFocusTarget(empty), empty);
  assert.equal(drawerFocusTarget(null), null);
});

// 2차 분리 검수 L4(2026-10-05): 폰 서랍 — Tab 18번이면 배경막 뒤 상단바로 나가고, 배경막 클릭으로 닫으면 포커스가 body에 남았다.
// → role="dialog" aria-modal, Tab 순환(첫↔끝), 배경막으로 닫아도 열기 버튼으로 포커스 복귀. 데스크톱(서랍이 아닌 고정 사이드바) 영향 0 — 서랍 속성·순환은 폰 폭에서 열렸을 때만.
import { drawerTabAction, drawerAttrs } from '../app/c/[ws]/drawer.mjs';

test('Tab 순환 — 마지막에서 Tab이면 첫째로, 첫째(또는 서랍 자체)에서 Shift+Tab이면 마지막으로, 서랍 밖에 있으면 안으로 끌어온다', () => {
  const first = { id: 'first' }; const last = { id: 'last' }; const mid = { id: 'mid' }; const outside = { id: 'topbar-button' };
  const container = { id: 'side', contains: (el) => [first, last, mid, container].includes(el) };
  const act = (extra) => drawerTabAction({ key: 'Tab', open: true, first, last, container, shiftKey: false, ...extra });
  assert.equal(act({ active: last }), 'first');
  assert.equal(act({ active: mid }), null, '가운데는 브라우저가 알아서');
  assert.equal(act({ active: first, shiftKey: true }), 'last');
  assert.equal(act({ active: container, shiftKey: true }), 'last', '서랍 자체에 포커스가 있을 때(처음 열린 직후)도');
  assert.equal(act({ active: container }), 'first');
  assert.equal(act({ active: outside }), 'first', '서랍 밖(배경막 뒤 상단바)으로 나갔으면 안으로');
  assert.equal(act({ active: outside, shiftKey: true }), 'last');
  assert.equal(act({ active: last, open: false }), null, '닫혀 있으면 아무것도 안 한다');
  assert.equal(act({ active: last, key: 'Enter' }), null);
  assert.equal(act({ active: last, first: null, last: null }), null, '조작 요소가 없으면 건드리지 않는다');
});

test('서랍 속성 — 폰 폭에서 열렸을 때만 dialog·aria-modal, 그 밖(데스크톱 고정 사이드바·닫힘)은 없다', () => {
  assert.deepEqual(drawerAttrs({ open: true, phone: true, label: '메뉴' }), { role: 'dialog', 'aria-modal': 'true', 'aria-label': '메뉴' });
  assert.deepEqual(drawerAttrs({ open: true, phone: false, label: '메뉴' }), {}, '데스크톱 영향 0');
  assert.deepEqual(drawerAttrs({ open: false, phone: true, label: '메뉴' }), {});
});
