// 앱 안 업데이트가 저장될 수 없는 설치 위치(맥) 판정 — 고객 문의 2건(2026-10-03·10-04: 업데이트를 눌러도 안 되고, 재설치하면 되다가 껐다 켜면 예전 버전).
// 2026-10-03 GitHub 맥 러너 재현: /Applications는 성공, DMG에서 바로 실행(App Translocation, EROFS)·외장 볼륨(EXDEV)·관리자 소유(EACCES)에서 실패.
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateLocationIssue, updateErrorReason, MOVE_REQUIRED } from '../app/update-location.mjs';

const mac = (over = {}) => ({ platform: 'macos', path: '/Applications/argo.app', translocated: false, parentErrno: null, bundleErrno: null, sameVolume: true, ...over });

test('설치 위치 — 응용 프로그램 폴더(쓸 수 있음·같은 볼륨)는 문제 없음', () => {
  assert.equal(updateLocationIssue(mac()), null);
});

test('설치 위치 — DMG·다운로드 폴더에서 바로 연 앱(App Translocation)', () => {
  assert.equal(updateLocationIssue(mac({ path: '/private/var/folders/x/T/AppTranslocation/1F2E/d/argo.app', translocated: true, bundleErrno: 30, parentErrno: 30, sameVolume: false })), 'translocated');
});

test('설치 위치 — 읽기 전용 볼륨(격리 표시 없이 마운트한 DMG)', () => {
  assert.equal(updateLocationIssue(mac({ path: '/Volumes/Argo/argo.app', bundleErrno: 30, parentErrno: 30, sameVolume: false })), 'read_only', '다른 볼륨이기도 하지만 읽기 전용이 먼저');
});

test('설치 위치 — 다른 볼륨(외장 디스크): 쓸 수 있어도 업데이터가 번들을 임시 폴더로 옮기지 못한다', () => {
  assert.equal(updateLocationIssue(mac({ path: '/Volumes/ArgoExt/Applications/argo.app', sameVolume: false })), 'other_volume');
});

test('설치 위치 — 관리자 소유(다른 계정이 설치): 관리자 암호를 물을 수 있어 옮기기 필수는 아니다', () => {
  assert.equal(updateLocationIssue(mac({ bundleErrno: 13 })), 'needs_admin');
  assert.equal(updateLocationIssue(mac({ parentErrno: 1 })), 'needs_admin');
  assert.equal(MOVE_REQUIRED.has('needs_admin'), false);
  for (const k of ['translocated', 'read_only', 'other_volume']) assert.equal(MOVE_REQUIRED.has(k), true, k);
});

test('설치 위치 — 맥이 아니거나 사실을 모르면(옛 앱에 명령 없음) 판단하지 않는다', () => {
  for (const facts of [null, undefined, {}, { platform: 'windows' }, { platform: 'macos' }, mac({ path: null })]) assert.equal(updateLocationIssue(facts), null, JSON.stringify(facts));
});

test('설치 실패 원문 → 이유 — 업데이터·OS 오류 문구 그대로', () => {
  assert.equal(updateErrorReason('failed to rename app: Read-only file system (os error 30)'), 'read_only');
  assert.equal(updateErrorReason('Cross-device link (os error 18)'), 'other_volume');
  assert.equal(updateErrorReason('Permission denied (os error 13)'), 'needs_admin');
  assert.equal(updateErrorReason('Operation not permitted (os error 1)'), 'needs_admin');
  assert.equal(updateErrorReason('User canceled the authentication'), 'needs_admin');
  assert.equal(updateErrorReason('the signature verification failed'), 'signature');
  assert.equal(updateErrorReason('error sending request for url (https://github.com/...)'), 'network');
  assert.equal(updateErrorReason('No such file or directory (os error 2)'), null, '모르는 오류는 원문만 보인다');
  assert.equal(updateErrorReason('os error 18x'), null, '숫자 뒤에 글자가 붙으면 다른 오류');
  assert.equal(updateErrorReason(undefined), null);
});
