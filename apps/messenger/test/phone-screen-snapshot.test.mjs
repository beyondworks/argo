// 폰 당겨서 새로고침 → 화면 복원 스냅샷(순수 함수) — 유건 제보(2026-09-26): "마지막 보던 페이지에서 이루어지게"
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeScreenSnapshot, consumeScreenSnapshot } from '../src/phone-screen-snapshot.mjs';

// 진짜 Storage처럼 동작하는 최소 가짜 — setItem/getItem/removeItem만 있으면 된다
function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

test('write→consume — 저장한 값을 그대로 돌려주고, 한 번 읽으면 지운다', () => {
  const store = fakeStore();
  writeScreenSnapshot(store, { page: 'chat', dmFilter: 'fav' });
  const snap = consumeScreenSnapshot(store);
  assert.equal(snap.page, 'chat');
  assert.equal(snap.dmFilter, 'fav');
  assert.equal(consumeScreenSnapshot(store), null, '한 번 소비하면 다음엔 없다(콜드 스타트에 잘못 쓰이지 않게)');
});

test('consume — 값이 없거나 깨졌으면 null(기존 기본 동작으로)', () => {
  assert.equal(consumeScreenSnapshot(fakeStore()), null, '키 자체가 없음');
  assert.equal(consumeScreenSnapshot(fakeStore({ 'argo-msgr-pull-snap': '{not json' })), null, '깨진 JSON');
  assert.equal(consumeScreenSnapshot(fakeStore({ 'argo-msgr-pull-snap': '"just a string"' })), null, '객체가 아님');
  assert.equal(consumeScreenSnapshot(fakeStore({ 'argo-msgr-pull-snap': JSON.stringify({ page: 'chat' }) })), null, '버전 표시(v) 없는 값은 우리가 쓴 값이 아니다');
});

test('consume — 너무 낡은 값은 버린다(maxAgeMs)', () => {
  const store = fakeStore({ 'argo-msgr-pull-snap': JSON.stringify({ v: 1, at: Date.now() - 120_000, page: 'chat' }) });
  assert.equal(consumeScreenSnapshot(store, { maxAgeMs: 60_000 }), null);
});

test('write/consume — store가 없어도(SSR·구형 웹뷰) 던지지 않는다', () => {
  assert.doesNotThrow(() => writeScreenSnapshot(null, { page: 'chat' }));
  assert.equal(consumeScreenSnapshot(null), null);
});

test('write — setItem이 예외를 던져도(용량 초과 등) 새로고침 자체를 막지 않는다', () => {
  const throwing = { setItem() { throw new Error('quota'); } };
  assert.doesNotThrow(() => writeScreenSnapshot(throwing, { page: 'chat' }));
});
