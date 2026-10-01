import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameUserEcho } from '../src/core/auth-events.js';

// supabase-js는 탭이 숨김 → 보임으로 바뀔 때마다 같은 사용자로 SIGNED_IN을 다시 보낸다(auth-js _recoverAndRefresh).
// 이걸 새 로그인으로 받으면 앱 전체가 로딩 화면으로 바뀌어 열린 창·입력 중인 내용이 사라지고 공간·업무를 다시 읽는다(9/29 실측).
test('a SIGNED_IN for the already signed-in user is an echo, not a new login', () => {
  assert.equal(isSameUserEcho('SIGNED_IN', { user: { id: 'u1' } }, { signedIn: true, uid: 'u1' }), true);
  assert.equal(isSameUserEcho('SIGNED_IN', { user: { id: 'u2' } }, { signedIn: true, uid: 'u1' }), false); // 다른 계정 로그인은 다시 적용
  assert.equal(isSameUserEcho('SIGNED_IN', { user: { id: 'u1' } }, { signedIn: false, uid: 'u1' }), false); // 로그인 전이면 적용
  assert.equal(isSameUserEcho('SIGNED_OUT', null, { signedIn: true, uid: 'u1' }), false);
  assert.equal(isSameUserEcho('USER_UPDATED', { user: { id: 'u1' } }, { signedIn: true, uid: 'u1' }), false);
});
