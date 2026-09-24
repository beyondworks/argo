import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCheckDesktop, shouldShowVersion, shouldCheckMobile, CHECK_INTERVAL_MS, MIN_CHECK_GAP_MS } from '../src/update-schedule.mjs';

test('데스크톱 확인 판정 — 막대가 떠 있거나 설치 중이면 절대 다시 확인하지 않는다(중복 확인 금지)', () => {
  const now = 1_000_000;
  for (const phase of ['available', 'installing', 'ready']) {
    assert.equal(shouldCheckDesktop({ phase, now, lastCheckAt: 0, reason: 'focus' }), false, phase);
    assert.equal(shouldCheckDesktop({ phase, now, lastCheckAt: null, reason: 'interval' }), false, phase);
  }
});

test('데스크톱 확인 판정 — 포커스 복귀도 최소 간격(5분)은 지키고, 주기는 30분 지나야', () => {
  const now = 1_000_000;
  assert.equal(shouldCheckDesktop({ phase: 'idle', now, lastCheckAt: now - (MIN_CHECK_GAP_MS - 1), reason: 'focus' }), false, '5분 안 지났으면 포커스라도 참는다(GitHub 60/hr 한도)');
  assert.equal(shouldCheckDesktop({ phase: 'idle', now, lastCheckAt: now - MIN_CHECK_GAP_MS, reason: 'focus' }), true, '5분 지나면 포커스로 확인');
  assert.equal(shouldCheckDesktop({ phase: 'idle', now, lastCheckAt: null, reason: 'interval' }), true, '한 번도 확인 안 했으면 확인');
  assert.equal(shouldCheckDesktop({ phase: 'idle', now, lastCheckAt: now - (CHECK_INTERVAL_MS - 1), reason: 'interval' }), false, '30분 전에는 아직');
  assert.equal(shouldCheckDesktop({ phase: 'idle', now, lastCheckAt: now - CHECK_INTERVAL_MS, reason: 'interval' }), true, '정확히 30분 지나면 확인');
  assert.equal(shouldCheckDesktop({ phase: 'error', now, lastCheckAt: now - CHECK_INTERVAL_MS, reason: 'interval' }), true, '실패 상태(idle 취급)는 다음 주기에 다시 시도');
});

test('"나중에" 억제 — 같은 버전은 다시 안 띄우고, 더 새 버전이 나오면 띄운다', () => {
  assert.equal(shouldShowVersion('0.1.39', '0.1.39'), false);
  assert.equal(shouldShowVersion('0.1.40', '0.1.39'), true);
  assert.equal(shouldShowVersion('0.1.39', null), true, '누른 적 없으면 보여준다');
  assert.equal(shouldShowVersion('', '0.1.39'), false, '버전 없음은 보여줄 것도 없다');
});

test('모바일 확인 판정 — 백그라운드에서는 무엇이 와도 확인하지 않는다(네트워크·DB 부하 0)', () => {
  const now = 1_000_000;
  for (const reason of ['start', 'foreground', 'interval']) {
    assert.equal(shouldCheckMobile({ reason, foreground: false, now, lastCheckAt: null }), false, reason);
  }
});

test('모바일 확인 판정 — 시작·포그라운드 복귀도 최소 간격(5분)을 지키고(새로고침 직후 재요청 방지), 포그라운드 유지 중엔 30분 주기', () => {
  const now = 1_000_000;
  assert.equal(shouldCheckMobile({ reason: 'start', foreground: true, now, lastCheckAt: null }), true, '처음이면(sessionStorage 없음) 바로 확인');
  assert.equal(shouldCheckMobile({ reason: 'start', foreground: true, now, lastCheckAt: now - 1000 }), false, '새로고침 직후 재요청 — 5분 안이면 참는다');
  assert.equal(shouldCheckMobile({ reason: 'foreground', foreground: true, now, lastCheckAt: now - 1000 }), false, '포그라운드 복귀도 5분 안이면 참는다');
  assert.equal(shouldCheckMobile({ reason: 'foreground', foreground: true, now, lastCheckAt: now - MIN_CHECK_GAP_MS }), true, '5분 지나면 복귀로 확인');
  assert.equal(shouldCheckMobile({ reason: 'interval', foreground: true, now, lastCheckAt: now - (CHECK_INTERVAL_MS - 1) }), false);
  assert.equal(shouldCheckMobile({ reason: 'interval', foreground: true, now, lastCheckAt: now - CHECK_INTERVAL_MS }), true);
});
