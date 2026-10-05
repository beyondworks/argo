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
