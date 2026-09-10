import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { longPressHandlers } from '../src/long-press.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const touch = (x = 0, y = 0) => ({ pointerType: 'touch', clientX: x, clientY: y });

test('길게 누르면 열리고, 스크롤·손 뗌·마우스는 열지 않는다', async () => {
  const state = { timer: null, x: 0, y: 0 };
  let opened = 0;
  const h = longPressHandlers(state, () => { opened += 1; }, 20);

  h.onPointerDown(touch());
  await sleep(40);
  assert.equal(opened, 1, '길게 누르면 열린다');

  h.onPointerDown(touch());
  h.onPointerMove({ clientX: 0, clientY: 30 }); // 스크롤
  await sleep(40);
  assert.equal(opened, 1, '허용치를 넘는 이동은 취소한다');

  h.onPointerDown(touch());
  h.onPointerMove({ clientX: 3, clientY: 4 }); // 5px — 손떨림
  await sleep(40);
  assert.equal(opened, 2, '작은 흔들림은 취소하지 않는다');

  h.onPointerDown({ pointerType: 'mouse', clientX: 0, clientY: 0 });
  await sleep(40);
  assert.equal(opened, 2, '마우스는 hover가 열므로 무시한다');

  h.onPointerDown(touch());
  h.onPointerUp();
  await sleep(40);
  assert.equal(opened, 2, '짧게 떼면 열지 않는다');

  h.onPointerDown(touch());
  h.onPointerCancel();
  await sleep(40);
  assert.equal(opened, 2, '취소된 포인터는 열지 않는다');
});

// 배선 핀 — 훅이 붙어 있어도 래퍼·CSS가 빠지면 액션은 열리지 않거나 계속 노출된다.
test('모바일 액션은 기본 숨김이고 길게 누른 메시지에서만 열린다', async () => {
  const read = async (p) => readFile(new URL(p, import.meta.url), 'utf8');
  const css = await read('../src/styles.css');
  const app = await read('../src/App.jsx');
  const phone = css.slice(css.indexOf('@media (max-width: 720px), (pointer: coarse) and (max-height: 600px) {', css.indexOf('.msgr-shell')));
  assert.match(phone, /\.msgr-acts \{ display: none; \}/, '모바일 기본은 숨김(공간까지 차지하지 않는다)');
  assert.match(phone, /\[data-acts='open'\] \.msgr-acts \{ display: flex;/, '열린 메시지에서만 보인다');
  assert.match(app, /const hold = useLongPress\(\(\) => setActsOpen\(true\)\);/, '길게 누르면 연다');
  for (const cls of ['msgr-mine', 'msgr-row']) {
    assert.match(app, new RegExp(`<div className="${cls}" data-acts=\\{actsOpen \\? 'open' : undefined\\} \\{\\.\\.\\.hold\\}>`), `${cls} 래퍼 배선`);
  }
  assert.match(app, /closest\?\.\('\.msgr-acts, \.msgr-emojipop'\)/, '바깥을 누르면 닫되 액션·이모지 피커는 예외');
  assert.match(phone, /\.msgr-mine \.bubble[^\n]*user-select: none;/, '본문 선택을 막아야 길게 누르기가 시스템 선택 메뉴에 가로채이지 않는다');
});
