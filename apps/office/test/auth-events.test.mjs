import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameUserEcho, switchNeedsReload } from '../src/core/auth-events.js';

// supabase-js는 탭이 숨김 → 보임으로 바뀔 때마다 같은 사용자로 SIGNED_IN을 다시 보낸다(auth-js _recoverAndRefresh).
// 이걸 새 로그인으로 받으면 앱 전체가 로딩 화면으로 바뀌어 열린 창·입력 중인 내용이 사라지고 공간·업무를 다시 읽는다(9/29 실측).
test('a SIGNED_IN for the already signed-in user is an echo, not a new login', () => {
  assert.equal(isSameUserEcho('SIGNED_IN', { user: { id: 'u1' } }, { signedIn: true, uid: 'u1' }), true);
  assert.equal(isSameUserEcho('SIGNED_IN', { user: { id: 'u2' } }, { signedIn: true, uid: 'u1' }), false); // 다른 계정 로그인은 다시 적용
  assert.equal(isSameUserEcho('SIGNED_IN', { user: { id: 'u1' } }, { signedIn: false, uid: 'u1' }), false); // 로그인 전이면 적용
  assert.equal(isSameUserEcho('SIGNED_OUT', null, { signedIn: true, uid: 'u1' }), false);
  assert.equal(isSameUserEcho('USER_UPDATED', { user: { id: 'u1' } }, { signedIn: true, uid: 'u1' }), false);
});

// 이유(10/4 3차 검수 HIGH): 새로고침 없이 다른 계정으로 바뀌면 모듈 캐시(문서함 목록·파일 내용·회사 정보·메일 등)에 남은 앞 계정 데이터가 새 계정 화면에 보였다 —
// 이 페이지에서 처음 읽은 계정과 다른 계정이 들어오면 다시 불러온다. 첫 로그인·같은 계정 다시 로그인·로그아웃은 다시 불러오지 않는다
test('다른 계정으로 바뀔 때만 페이지를 다시 불러온다', () => {
  assert.equal(switchNeedsReload(null, 'u1'), false, '이 페이지의 첫 로그인');
  assert.equal(switchNeedsReload('u1', 'u1'), false, '같은 계정(토큰 갱신·다시 로그인)');
  assert.equal(switchNeedsReload('u1', null), false, '로그아웃');
  assert.equal(switchNeedsReload('u1', 'u2'), true, 'A → B(로그아웃 뒤 다른 계정 로그인 포함)');
});
