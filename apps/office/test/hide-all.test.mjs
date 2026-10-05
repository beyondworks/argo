// 18차 1번 — 화면 전체 가리기: 가릴 대상 규칙(redact-rule.js), 값 하나 가리기와 함께 동작(cell-pick.js redactHandlers), 이 기기 기억(core/hide-all.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMasked, HIDE_ALL_KEEP } from '../src/business/redact-rule.js';
import { redactHandlers } from '../src/business/cell-pick.js';

// 노드에는 localStorage가 없다 — 이 기기 기억을 시험하려고 들여오기 전에 하나 만든다(이미 켜 둔 기기)
const mem = new Map([['argo-office-hide-all', '1']]);
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { hideAllOn, toggleHideAll } = await import('../src/core/hide-all.js');

// 이유(유건 결정 4): 켜면 금액·연락처·계좌·사업자번호·메일 글은 가리고, 거래처 이름·할 일 제목(이름·제목)은 그대로 — 무엇에 관한 화면인지는 알아야 회의를 이어 간다
test('전체 가리기 대상: 이름·제목만 그대로, 나머지 값은 가린다', () => {
  for (const kind of ['amount', 'contact', 'account', 'bizno', 'mail']) assert.equal(isMasked({ on: false, all: true, kind }), true, kind);
  for (const kind of ['name', 'title']) assert.equal(isMasked({ on: false, all: true, kind }), false, kind);
  assert.deepEqual(HIDE_ALL_KEEP, ['name', 'title']);
});

// 이유: 가림 칸이 있는 값은 원래 민감한 값이다 — kind를 빠뜨린 자리가 생겨도 전체 가리기에서 새지 않게 가리는 쪽이 기본
test('전체 가리기 대상: kind를 붙이지 않은 값은 가린다', () => {
  assert.equal(isMasked({ on: false, all: true }), true);
  assert.equal(isMasked({ on: false, all: true, kind: undefined }), true);
});

// 이유: 값마다 가리기와 전체 가리기는 둘 중 하나라도 가리면 가린다 — 전체 가리기를 꺼도 따로 가린 값(이름 포함)은 계속 가려져 있어야 한다
test('값마다 가리기와 함께: 둘 중 하나라도 가리면 가림', () => {
  assert.equal(isMasked({ on: true, all: false, kind: 'amount' }), true);
  assert.equal(isMasked({ on: true, all: false, kind: 'name' }), true, '따로 가린 이름은 전체 가리기와 무관하게 가린다');
  assert.equal(isMasked({ on: true, all: true, kind: 'title' }), true);
  assert.equal(isMasked({ on: false, all: false, kind: 'amount' }), false);
  assert.equal(isMasked({ on: undefined, all: false }), false);
});

const ev = (extra = {}) => { const e = { button: 0, key: '', shiftKey: false, prevented: false, preventDefault() { e.prevented = true; }, ...extra }; return e; };
const rig = (props) => { const calls = { menu: [], peek: [] }; let peek = false; const h = redactHandlers(props, (v) => { peek = typeof v === 'function' ? v(peek) : v; calls.peek.push(peek); }, (e, items) => calls.menu.push(items)); return { h, calls }; };

// 이유: 전체 가리기로만 가려진 값도 누르고 있는 동안만 보인다(값 하나 가리기와 같은 손동작). 우클릭 메뉴 글자는 그 값을 따로 가렸는지를 따른다
test('전체 가리기로 가려진 값: 누르는 동안만 보기, 메뉴는 따로 가린 상태 기준', () => {
  const toggle = () => {};
  let r = rig({ on: false, masked: true, onToggle: toggle });
  r.h.onPointerDown(ev()); r.h.onPointerUp(ev());
  assert.deepEqual(r.calls.peek, [true, false]);
  r.h.onContextMenu(ev());
  assert.equal(r.calls.menu[0][0].label, 'bizui.redact', '따로 가리지 않았으니 메뉴는 "가리기"');
  r = rig({ on: false, masked: true, onToggle: toggle });
  r.h.onKeyDown(ev({ key: 'Enter' }));
  assert.deepEqual(r.calls.peek, [true], 'Enter로도 잠깐 보기');
  // 저장 자리가 없는 값(메일 받는 사람 등, onToggle 없음) — 메뉴는 없고 누르는 동안 보기는 된다
  r = rig({ masked: true });
  r.h.onContextMenu(ev());
  assert.equal(r.calls.menu.length, 0);
  r.h.onPointerDown(ev());
  assert.deepEqual(r.calls.peek, [true]);
  // 가려지지 않은 값은 누름에 반응하지 않는다(masked 없이 부르던 옛 호출은 on을 따른다)
  assert.equal(rig({ on: false, masked: false, onToggle: toggle }).h.onPointerDown, undefined);
  assert.equal(typeof rig({ on: true, onToggle: toggle }).h.onPointerDown, 'function');
});

// 이유(결정 4): 이 기기에만 기억 — 다시 열어도 켜진 채, 끄면 '0'으로 남는다. 같은 값으로 다시 부르면 아무것도 바꾸지 않는다
test('이 기기 기억: 켜 둔 기기는 켜진 채로 시작, 끄고 켜기가 저장된다', () => {
  assert.equal(hideAllOn(), true);
  toggleHideAll();
  assert.equal(hideAllOn(), false);
  assert.equal(mem.get('argo-office-hide-all'), '0');
  toggleHideAll(false);
  assert.equal(mem.get('argo-office-hide-all'), '0');
  toggleHideAll(true);
  assert.equal(hideAllOn(), true);
  assert.equal(mem.get('argo-office-hide-all'), '1');
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  toggleHideAll(false); // 저장소가 막혀도(사생활 창) 화면 상태는 바뀐다
  assert.equal(hideAllOn(), false);
});

// 이유: kind 오타는 조용히 '가림'이 된다(이름이 가려지는 쪽) — 쓰는 값이 정해진 목록 안에 있는지 소스에서 잠근다
test('소스: 가리기 kind는 정해진 값만', () => {
  const SRC = new URL('../src/', import.meta.url).pathname;
  const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
  const known = new Set(['amount', 'contact', 'account', 'bizno', 'mail', 'memo', 'name', 'title']);
  let seen = 0;
  for (const p of files(SRC).filter((x) => x.endsWith('.jsx'))) {
    for (const m of readFileSync(p, 'utf8').matchAll(/<(?:Redact|Hide|HideIn)\b[^>]*?\bkind="([^"]+)"/g)) { seen++; assert.ok(known.has(m[1]), `${p}: ${m[1]}`); }
  }
  assert.ok(seen >= 5, `검사가 kind 자리를 찾지 못했다(${seen}곳) — 정규식이 소스 모양과 어긋났다`); // 회사 정보·거래 건명은 식(kind={…})으로 넘겨 여기 잡히지 않는다
});
