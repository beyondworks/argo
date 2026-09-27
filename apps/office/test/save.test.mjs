// 화면 캐시 — 보낼 목록은 페이지 본문을 이 캐시에서 다시 읽는다. 떠나기 직전 밀린 쓰기가 사라지면 마지막 편집이 조용히 유실된다.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
const handlers = {};
globalThis.localStorage = { setItem: (k, v) => mem.set(k, v), getItem: (k) => mem.get(k) ?? null, removeItem: (k) => mem.delete(k) };
globalThis.window = { addEventListener: (k, f) => { (handlers[k] ??= []).push(f); } };
globalThis.document = { hidden: false, addEventListener: (k, f) => { (handlers[k] ??= []).push(f); } };
const { persist, restore } = await import('../src/core/save.js');

// 이유(9/27 실측): 템플릿을 고른 직후 새로고침하자 0.3초 지연 쓰기가 사라져, 다시 연 뒤 빈 본문이 "같은 내용"으로 처리되고 편집이 유실됐다.
test('페이지를 떠나면(pagehide) 밀린 캐시 쓰기를 바로 한다', () => {
  persist('k1', { v: 1 });
  assert.equal(restore('k1', null), null, '지연 중에는 아직 안 썼다');
  handlers.pagehide.forEach((f) => f());
  assert.deepEqual(restore('k1', null), { v: 1 });
});

test('탭이 가려져도(visibilitychange hidden) 바로 쓴다', () => {
  persist('k2', { v: 2 });
  document.hidden = true; handlers.visibilitychange.forEach((f) => f()); document.hidden = false;
  assert.deepEqual(restore('k2', null), { v: 2 });
});
