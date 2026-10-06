import test from 'node:test';
import assert from 'node:assert/strict';
import { cellsInBox, bulkRedact } from '../src/business/cell-pick.js';

// 표에서 끌어 고른 칸 — 시작 칸과 끝 칸이 만드는 사각형(유건 9/29, 노션처럼)
test('picked cells are the rectangle between the start and end cell, in any drag direction', () => {
  assert.deepEqual(cellsInBox([1, 2], [0, 1]), [[0, 1], [0, 2], [1, 1], [1, 2]]);
  assert.deepEqual(cellsInBox([3, 0], [3, 0]), [[3, 0]]);
});

// 한 번에 가리기·해제는 바뀌는 칸만 보낸다 — 이미 가린 칸을 다시 가리는 쓰기를 만들지 않는다(DB 위생)
test('bulk redact sends only the cells whose state changes', () => {
  const rows = [{ id: 'a', redacted: ['phone'] }, { id: 'b', redacted: [] }];
  const fields = ['manager', 'phone'];
  const cells = cellsInBox([0, 0], [1, 1]);
  assert.deepEqual(bulkRedact(rows, fields, cells, true), [
    { entity: 'customer', id: 'a', field: 'manager', on: true },
    { entity: 'customer', id: 'b', field: 'manager', on: true },
    { entity: 'customer', id: 'b', field: 'phone', on: true },
  ]);
  assert.deepEqual(bulkRedact(rows, fields, cells, false), [{ entity: 'customer', id: 'a', field: 'phone', on: false }]);
  assert.deepEqual(bulkRedact(rows, fields, [[5, 0]], true), []); // 없는 줄은 건너뛴다
});

// ── 11차 잠금(유건 10/2 "가림 해제") — 일괄 가리기를 붙이기 전에 값 하나 가림의 손동작을 고정한다 ──
import { redactHandlers, redactDefaults, redactState, bulkRedactRows } from '../src/business/cell-pick.js';
const ev = (extra = {}) => { const e = { button: 0, key: '', shiftKey: false, prevented: false, preventDefault() { e.prevented = true; }, ...extra }; return e; };
const rig = (props) => { const calls = { menu: [], peek: [] }; let peek = false; const h = redactHandlers(props, (v) => { peek = typeof v === 'function' ? v(peek) : v; calls.peek.push(peek); }, (e, items) => calls.menu.push(items)); return { h, calls }; };

// 이유(9/29): 값 위 우클릭 = 가리기(가려져 있으면 가리기 해제) 한 줄 메뉴. 읽기 전용·바꿀 수 없는 값·여러 칸 고름(표가 한 번에 연다)이면 메뉴 없음
test('잠금: 값 하나 우클릭 가리기·해제', () => {
  let toggled = 0;
  const toggle = () => { toggled += 1; };
  let r = rig({ on: false, onToggle: toggle }); r.h.onContextMenu(ev());
  const [only] = r.calls.menu[0];
  assert.equal(r.calls.menu.length, 1); assert.equal(r.calls.menu[0].length, 1);
  assert.deepEqual({ label: only.label, icon: only.icon }, { label: 'bizui.redact', icon: 'eyeOff' });
  only.run(); assert.equal(toggled, 1, '누르면 그 값의 가리기를 바꾼다(전체 가리기가 켜져 있으면 쓰지 않도록 감싼다 — 18차 2차 검수 LOW-A)');
  r = rig({ on: true, onToggle: toggle }); r.h.onContextMenu(ev());
  assert.equal(r.calls.menu[0][0].label, 'bizui.unredact');
  for (const p of [{ disabled: true }, { onToggle: null }, { picked: true }, { defer: true }]) { r = rig({ on: true, onToggle: toggle, ...p }); r.h.onContextMenu(ev()); assert.equal(r.calls.menu.length, 0, JSON.stringify(p)); }
});

// 이유(9/29): 가린 값은 왼쪽 버튼을 누르고 있는 동안만 보인다(떼거나·벗어나거나·취소되면 다시 가림). 우클릭 누름은 보이지 않는다(메뉴가 표 칸으로 빠지지 않게)
test('잠금: 누르고 있는 동안만 보기', () => {
  const r = rig({ on: true, onToggle: () => {} });
  r.h.onPointerDown(ev({ button: 2 })); assert.deepEqual(r.calls.peek, []);
  r.h.onPointerDown(ev()); r.h.onPointerUp(); r.h.onPointerDown(ev()); r.h.onPointerLeave(); r.h.onPointerDown(ev()); r.h.onPointerCancel();
  assert.deepEqual(r.calls.peek, [true, false, true, false, true, false]);
  assert.equal(rig({ on: false, onToggle: () => {} }).h.onPointerDown, undefined); // 안 가린 값은 누름에 반응하지 않는다
});

// 이유(9/29): 키보드 — 메뉴 키(Shift+F10·ContextMenu)로 메뉴, 가린 값은 Enter로 잠깐 보기 켜고 끄기, 초점이 떠나면 다시 가림. 버튼 안 값(focusable=false)은 초점을 받지 않는다
test('잠금: 키보드 Shift+F10·Enter', () => {
  const r = rig({ on: true, onToggle: () => {} });
  assert.equal(r.h.tabIndex, 0);
  r.h.onKeyDown(ev({ key: 'F10', shiftKey: true })); r.h.onKeyDown(ev({ key: 'ContextMenu' }));
  assert.equal(r.calls.menu.length, 2);
  const enter = ev({ key: 'Enter' }); r.h.onKeyDown(enter); r.h.onKeyDown(ev({ key: 'Enter' })); r.h.onKeyDown(ev({ key: 'Enter' })); r.h.onBlur();
  assert.equal(enter.prevented, true);
  assert.deepEqual(r.calls.peek, [true, false, true, false]);
  assert.equal(rig({ on: true, onToggle: () => {}, focusable: false }).h.tabIndex, undefined);
  assert.equal(rig({ on: true, onToggle: () => {}, disabled: true }).h.onKeyDown, undefined);
});

// 이유(9/29): 새 거래처는 계좌·사업자번호를 가린 채로 시작(이관과 같다), 고치는 거래처·상품은 건드리지 않는다
test('잠금: 새 거래처 기본 가림', () => {
  assert.deepEqual(redactDefaults('customer', { name: 'a' }), { redacted: ['account', 'biz_no'] });
  assert.deepEqual(redactDefaults('customer', { id: 'c1', name: 'a' }), {});
  assert.deepEqual(redactDefaults('item', { name: 'a' }), {});
});

// 이유(유건 10/2): 고른 행 전체 가리기·해제 — 그 행에서 가릴 수 있는 칸 전부, 바뀌는 칸만 보낸다. 일부만 가려져 있으면 메뉴는 가리기·해제 둘 다
test('일괄: 고른 행 가리기·해제와 상태', () => {
  const rows = [{ id: 'a', redacted: ['phone'] }, { id: 'b', redacted: [] }, { id: 'c', redacted: ['manager', 'phone'] }];
  const fields = ['manager', 'phone'];
  assert.deepEqual(bulkRedactRows(rows, fields, ['a', 'c'], true), [{ entity: 'customer', id: 'a', field: 'manager', on: true }]);
  assert.deepEqual(bulkRedactRows(rows, fields, ['a', 'b'], false), [{ entity: 'customer', id: 'a', field: 'phone', on: false }]);
  assert.deepEqual(redactState([1, 2], (x) => x === 1), { any: true, all: false });
  assert.deepEqual(redactState([1, 2], () => true), { any: true, all: true });
  assert.deepEqual(redactState([], () => true), { any: false, all: false });
});

// ── 12차 ──
import { cellPlan, REVEAL_MODE } from '../src/business/cell-pick.js';

// 이유(유건 10/2 "영역을 원하는 만큼만 선택해서 쉬머"): 고른 칸 여러 개 가리기 — 이미 그 상태인 칸은 빼고, 같은 쓰기(거래처 redact.bulk)는 한 번에, 나머지는 칸마다 그 데이터의 저장 방식으로.
test('12차: 고른 칸 가리기 계획 — 바뀌는 칸만, 같은 쓰기는 한 번', () => {
  const sent = [], set = [];
  const bulk = (items) => sent.push(items);
  const cell = (on, extra) => ({ on: () => on, set: (v) => set.push([extra.k, v]), ...extra });
  const cells = [cell(false, { k: 'a', batch: bulk, item: { id: 'c1', field: 'phone' } }), cell(true, { k: 'b', batch: bulk, item: { id: 'c1', field: 'email' } }), cell(false, { k: 'c', batch: bulk, item: { id: 'c2', field: 'phone' } }), cell(false, { k: 'd' })];
  const jobs = cellPlan(cells, true);
  assert.equal(jobs.length, 2);
  jobs.forEach((j) => j());
  assert.deepEqual(sent, [[{ id: 'c1', field: 'phone', on: true }, { id: 'c2', field: 'phone', on: true }]]);
  assert.deepEqual(set, [['d', true]]);
  assert.equal(cellPlan(cells.slice(1, 2), true).length, 0);
});

// 이유(12차 추가 2): 여는 방식은 지금 그대로(누르고 있는 동안만) — 영상처럼 눌러서 열어 두기는 설정값 하나로 바꾼다.
test('12차: 여는 방식 설정값', () => {
  assert.equal(REVEAL_MODE, 'hold');
  const r = rig({ on: true, onToggle: () => {}, mode: 'toggle' });
  r.h.onPointerDown(ev()); assert.equal(r.h.onPointerUp, undefined); r.h.onPointerDown(ev());
  assert.deepEqual(r.calls.peek, [true, false]); // 누를 때마다 열고 닫는다
});
