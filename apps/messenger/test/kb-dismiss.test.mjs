// 폰 키보드 내리기(kb-dismiss.mjs) 행동 테스트 — iOS 보조 막대 ✓를 숨긴 뒤 키보드를 내리는 유일한 수단(유건 실기기 2026-10-04).
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachKeyboardDismiss, DRAG_PX, LONG_PRESS_MS } from '../src/kb-dismiss.mjs';

function setup({ active = { tagName: 'TEXTAREA' } } = {}) {
  const handlers = {};
  const el = { addEventListener: (k, f) => { handlers[k] = f; }, removeEventListener: (k, f) => { if (handlers[k] === f) delete handlers[k]; } };
  let blurs = 0;
  const focused = active && { ...active, blur() { blurs++; } };
  const doc = { activeElement: focused };
  let clock = 1000;
  const detach = attachKeyboardDismiss(el, { doc, now: () => clock });
  const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }] });
  const plain = { closest: () => null };
  const button = { closest: (sel) => (sel.includes('button') ? {} : null) };
  return {
    handlers, detach, blurs: () => blurs, advance: (ms) => { clock += ms; },
    start: (x, y) => handlers.touchstart?.(touch(x, y)),
    move: (x, y) => handlers.touchmove?.(touch(x, y)),
    end: (target = plain) => handlers.touchend?.({ target, touches: [] }),
    plain, button,
  };
}

test('입력 중 대화 목록을 위아래로 끌면 키보드를 내린다(한 번만)', () => {
  const s = setup();
  s.start(100, 300); s.move(100, 300 + DRAG_PX + 1); s.move(100, 400); s.end();
  assert.equal(s.blurs(), 1);
});

test('위로 끌어도 내린다 — 끌기 거리가 기준 이하이면 끌기가 아니다', () => {
  const s = setup();
  s.start(100, 300); s.move(100, 300 - DRAG_PX - 5); s.end();
  assert.equal(s.blurs(), 1);
  const t = setup();
  t.start(100, 300); t.move(100, 300 + DRAG_PX); // 기준과 같으면 아직 끌기 아님 → 손을 떼면 짧게 누르기로 본다
  assert.equal(t.blurs(), 0);
});

test('짧게 누르면 내린다 — 링크·버튼·입력칸을 누른 것은 건드리지 않는다', () => {
  const s = setup();
  s.start(50, 50); s.end(s.plain);
  assert.equal(s.blurs(), 1);
  const b = setup();
  b.start(50, 50); b.end(b.button);
  assert.equal(b.blurs(), 0);
});

test('길게 누르기(메뉴)와 옆으로 밀기(뒤로 가기)는 내리지 않는다', () => {
  const lp = setup();
  lp.start(50, 50); lp.advance(LONG_PRESS_MS + 1); lp.end();
  assert.equal(lp.blurs(), 0);
  const sw = setup();
  sw.start(20, 300); sw.move(20 + DRAG_PX + 30, 302); sw.end();
  assert.equal(sw.blurs(), 0);
});

test('입력칸에 초점이 없거나 글자 입력칸이 아니면 아무것도 하지 않는다', () => {
  const none = setup({ active: null });
  none.start(100, 300); none.move(100, 360); none.end();
  assert.equal(none.blurs(), 0);
  const cb = setup({ active: { tagName: 'INPUT', type: 'checkbox' } });
  cb.start(100, 300); cb.move(100, 360);
  assert.equal(cb.blurs(), 0);
  const ce = setup({ active: { tagName: 'DIV', isContentEditable: true } });
  ce.start(100, 300); ce.move(100, 360);
  assert.equal(ce.blurs(), 1);
});

test('두 손가락(확대 등)은 무시하고, 떼면 이벤트를 모두 뗀다', () => {
  const s = setup();
  s.handlers.touchstart({ touches: [{ clientX: 1, clientY: 1 }, { clientX: 50, clientY: 50 }] });
  s.move(1, 80); s.end();
  assert.equal(s.blurs(), 0);
  s.detach();
  assert.deepEqual(Object.keys(s.handlers), []);
});
