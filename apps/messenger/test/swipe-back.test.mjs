// 뒤로가기 스와이프 판정(유건 2026-09-17: 왼쪽 절반에서 시작, 천천히 밀어도 자연스럽게) — 순수 함수 행동 테스트. 제스처 배선은 mobile-nav.browser.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { swipeRelease, canStartSwipeBack } from '../src/use-phone.js';

test('놓을 때 — 최근 속도가 방향을 정하고, 멈춘 채면 위치 35%가 기준', () => {
  assert.equal(swipeRelease(80, 390, 0.6).go, true, '짧게 밀어도 빠르게 튕기면 넘어간다');
  assert.equal(swipeRelease(170, 390, -0.5).go, false, '44%까지 밀었어도 되돌리며 놓으면 제자리');
  assert.equal(swipeRelease(150, 390, 0).go, true, '38%에서 멈춘 채 놓으면 넘어간다');
  assert.equal(swipeRelease(120, 390, 0).go, false, '31%에서 멈춘 채 놓으면 제자리');
  for (const [dx, v] of [[10, 0], [380, 3], [200, 0.01], [100, -2]]) { const { ms } = swipeRelease(dx, 390, v); assert.ok(ms >= 160 && ms <= 320, `마무리 시간 160~320ms (${dx},${v}→${ms})`); }
});

test('시작 가능 — 왼쪽 절반만, 입력창·가로 스크롤 내용 위는 제외', () => {
  globalThis.getComputedStyle = (el) => ({ overflowX: el.ox ?? 'visible' });
  const el = (props = {}, parent = null) => ({ nodeType: 1, parentElement: parent, scrollWidth: 100, clientWidth: 100, scrollLeft: 0, matches: (sel) => !!props.tag && sel.includes(props.tag), ...props });
  const main = el();
  assert.equal(canStartSwipeBack(el({}, main), 20, 390), true, '가장자리');
  assert.equal(canStartSwipeBack(el({}, main), 190, 390), true, '중앙 바로 왼쪽');
  assert.equal(canStartSwipeBack(el({}, main), 200, 390), false, '오른쪽 절반은 아님');
  assert.equal(canStartSwipeBack(el({ tag: 'textarea' }, main), 50, 390), false, '입력창 위');
  assert.equal(canStartSwipeBack(el({}, el({ ox: 'auto', scrollWidth: 600, clientWidth: 300 }, main)), 50, 390), false, '가로 스크롤 코드 블록 위');
  assert.equal(canStartSwipeBack(el({}, el({ ox: 'auto', scrollWidth: 300, clientWidth: 300 }, main)), 50, 390), true, '넘치지 않는 스크롤 상자는 막지 않는다');
});
