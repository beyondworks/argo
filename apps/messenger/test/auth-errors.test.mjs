// 로그인 화면 오류 문구(검수 D9: ko 화면에 GoTrue 원문 "Invalid login credentials"가 그대로 떴다).
// 서버·브라우저가 실제로 돌려주는 원문 → 사전 키, 키는 ko·en 둘 다 있고, 모르는 문구는 원문 그대로다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authErrorKey, authErrorText } from '../src/auth-errors.mjs';
import { DICT } from '../src/i18n.js';

// GoTrue(supabase auth)·supabase-js·브라우저 fetch가 실제로 내는 문구
const CASES = [
  ['Invalid login credentials', 'auth.err.credentials'],
  ['Email not confirmed', 'auth.err.unconfirmed'],
  ['User already registered', 'auth.err.exists'],
  ['Token has expired or is invalid', 'auth.err.expired'],
  ['Email link is invalid or has expired', 'auth.err.expired'],
  ['Invalid Refresh Token: Refresh Token Not Found', 'auth.err.session'],
  ['Invalid Refresh Token: Already Used', 'auth.err.session'],
  ['Auth session missing!', 'auth.err.session'],
  ['invalid flow state, no valid flow state found', 'auth.err.exchange'],
  ['access_denied', 'auth.err.denied'],
  ['Email rate limit exceeded', 'auth.err.rateLimit'],
  ['For security purposes, you can only request this after 39 seconds.', 'auth.err.rateLimit'],
  ['Signups not allowed for this instance', 'auth.err.signupDisabled'],
  ['Password should be at least 6 characters.', 'auth.err.weakPassword'],
  ['Failed to fetch', 'auth.err.network'],
  ['NetworkError when attempting to fetch resource.', 'auth.err.network'],
  ['Load failed', 'auth.err.network'],
];

test('서버·브라우저 원문 → 사전 키', () => {
  for (const [msg, key] of CASES) assert.equal(authErrorKey(msg), key, msg);
});

test('매핑 키는 ko·en 둘 다 비어 있지 않다', () => {
  for (const key of new Set(CASES.map(([, k]) => k))) {
    const pair = DICT[key];
    assert.ok(Array.isArray(pair) && pair.length === 2, key);
    assert.ok(pair[0]?.trim() && pair[1]?.trim(), key);
    assert.doesNotMatch(pair[0], /Invalid login credentials/, key);
  }
});

test('모르는 문구는 원문 그대로(정직), 번역된 문구를 다시 거쳐도 뜻이 바뀌지 않는다', () => {
  const t = (k) => `T:${k}`;
  assert.equal(authErrorText('something unexpected', t), 'something unexpected');
  assert.equal(authErrorText(undefined, t), '');
  assert.equal(authErrorText('Invalid login credentials', t), 'T:auth.err.credentials');
  // 로그인 화면은 핸드오프가 이미 번역한 문구를 run()에서 한 번 더 거친다 — 번역문이 다른 키로 바뀌면 안 된다
  for (const [, key] of CASES) for (const text of DICT[key]) {
    const again = authErrorKey(text);
    assert.ok(again === null || again === key, `${key}: ${text} → ${again}`);
  }
});
