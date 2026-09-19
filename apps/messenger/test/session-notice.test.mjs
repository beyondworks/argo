// 세션 만료 안내(검수 D10). 앱을 다시 열 때 supabase-js는 구독 전에 SIGNED_OUT을 내 버려 이벤트로는 못 잡는다(로컬 스택 실측) —
// "로그인해 있었다" 표시로 판정한다. 누른 로그아웃·계정 삭제·첫 실행은 안내하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionTransition, SIGNED_IN_MARK } from '../src/session-notice.mjs';
import { DICT } from '../src/i18n.js';

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const S = { user: { id: 'u1' } };

test('로그인해 있다가 세션 없이 들어오면(앱 다시 열기·갱신 실패·모바일 복귀) 만료 안내', () => {
  const s = store();
  assert.equal(sessionTransition(s, S), 'signedIn');
  assert.equal(s.m.get(SIGNED_IN_MARK), '1');
  assert.equal(sessionTransition(s, null), 'expired');
  assert.equal(sessionTransition(s, null), null, '한 번만 — 표시는 지워진다');
});

test('첫 실행·누른 로그아웃·계정 삭제는 안내하지 않는다', () => {
  assert.equal(sessionTransition(store(), null), null, '첫 실행');
  const a = store(); sessionTransition(a, S);
  assert.equal(sessionTransition(a, null, { pending: true }), null, '누른 로그아웃');
  assert.equal(a.m.has(SIGNED_IN_MARK), false, '로그아웃 뒤 표시가 남지 않아 다음 실행에도 안내 없음');
  const b = store(); sessionTransition(b, S);
  assert.equal(sessionTransition(b, null, { deleting: true }), null, '계정 삭제');
});

test('저장소를 못 쓰면 안내 없이 진행(앱을 막지 않는다)', () => {
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.equal(sessionTransition(broken, S), 'signedIn');
  assert.equal(sessionTransition(broken, null), null);
  assert.equal(sessionTransition(undefined, null), null);
});

test('안내 문구는 ko·en 둘 다 있다', () => {
  const pair = DICT['auth.sessionExpired'];
  assert.ok(pair?.[0]?.trim() && pair?.[1]?.trim());
});
