// 앱 안 업데이트가 저장될 수 없는 설치 위치(맥) — 고객 문의 2건(2026-10-03·10-04). 본체 test/update-location.test.mjs와 같은 판정 + 메신저 막대 표시.
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateLocationIssue, updateErrorReason, updateBarView, MOVE_REQUIRED } from '../src/update-location.mjs';

const mac = (over = {}) => ({ platform: 'macos', path: '/Applications/Argo Messenger.app', translocated: false, parentErrno: null, bundleErrno: null, sameVolume: true, ...over });

test('설치 위치 판정 — 응용 프로그램 폴더·DMG(App Translocation)·읽기 전용·외장 디스크·관리자 소유', () => {
  assert.equal(updateLocationIssue(mac()), null);
  assert.equal(updateLocationIssue(mac({ translocated: true, bundleErrno: 30, parentErrno: 30, sameVolume: false })), 'translocated');
  assert.equal(updateLocationIssue(mac({ path: '/Volumes/Argo Messenger/Argo Messenger.app', bundleErrno: 30, sameVolume: false })), 'read_only');
  assert.equal(updateLocationIssue(mac({ sameVolume: false })), 'other_volume');
  assert.equal(updateLocationIssue(mac({ bundleErrno: 13 })), 'needs_admin');
  for (const facts of [null, { platform: 'windows' }, { platform: 'macos' }]) assert.equal(updateLocationIssue(facts), null);
  assert.deepEqual([...MOVE_REQUIRED].sort(), ['other_volume', 'read_only', 'translocated']);
});

test('설치 실패 원문 → 이유', () => {
  assert.equal(updateErrorReason('Read-only file system (os error 30)'), 'read_only');
  assert.equal(updateErrorReason('Cross-device link (os error 18)'), 'other_volume');
  assert.equal(updateErrorReason('Permission denied (os error 13)'), 'needs_admin');
  assert.equal(updateErrorReason('Failed to move the new app into place'), 'needs_admin', '관리자 암호 창 취소(업데이터 2.11.0 문구)');
  assert.equal(updateErrorReason('signature verification failed'), 'signature');
  assert.equal(updateErrorReason('error sending request for url'), 'network');
  assert.equal(updateErrorReason('No such file or directory (os error 2)'), null);
});

test('막대 표시 — 옮겨야 하면 설치 버튼 대신 옮기는 방법, 관리자 소유는 설치 버튼 + 안내, 실패는 이유', () => {
  assert.deepEqual(updateBarView({ phase: 'available', issue: 'translocated' }), { mode: 'move', reason: 'translocated' });
  assert.deepEqual(updateBarView({ phase: 'available', issue: 'other_volume' }), { mode: 'move', reason: 'other_volume' });
  assert.deepEqual(updateBarView({ phase: 'available', issue: 'needs_admin' }), { mode: 'install', reason: 'needs_admin' });
  assert.deepEqual(updateBarView({ phase: 'available', issue: null }), { mode: 'install', reason: null });
  assert.deepEqual(updateBarView({ phase: 'error', error: 'failed: Read-only file system (os error 30)' }), { mode: 'error', reason: 'read_only' });
  assert.deepEqual(updateBarView({ phase: 'error', error: 'weird' }), { mode: 'error', reason: null });
  assert.deepEqual(updateBarView({ phase: 'installing' }), { mode: 'installing', reason: null });
  assert.deepEqual(updateBarView({ phase: 'idle', issue: 'translocated' }), { mode: 'hidden', reason: null }, '새 버전이 없을 때는 막대를 띄우지 않는다');
});
