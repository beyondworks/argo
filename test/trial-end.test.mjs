// trialBadgeState — 체험 D-day 배지·임박 배너의 단일 원천. 여기가 어긋나면 배너 시점과
// 서버 실제 차단 시점이 조용히 불일치한다(분리 검수 권고로 잠금).
//
// 2026-09-29 변경: trialEnd(가입일+14일을 클라이언트에서 계산)는 제거했다 — 14일 무료 체험 폐지(R1)
// 이후 "T(마이그레이션 20260929110000) 이전 가입자만 남은 체험"이라는 조건은 서버만 안다. trialEndsAt은
// 이제 항상 서버(my_plan() RPC)가 준 값이고, 이 파일은 그 값을 받은 **뒤의** 배지 표시 로직만 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trialBadgeState } from '../src/entitlement.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-28T00:00:00Z');

test('trialBadgeState: 만료자는 완전 비활성 — D-0 영구 표시 회귀(H1) 잠금', () => {
  const s = trialBadgeState(new Date(NOW - 90 * DAY).toISOString(), 'free', NOW);
  assert.deepEqual(s, { active: false, imminent: false, daysLeft: null });
});

test('trialBadgeState: 임박(3일 미만)과 여유(12일)의 경계', () => {
  const near = trialBadgeState(new Date(NOW + 2 * DAY).toISOString(), null, NOW);
  assert.equal(near.active, true); assert.equal(near.imminent, true); assert.equal(near.daysLeft, 2);
  const far = trialBadgeState(new Date(NOW + 12 * DAY).toISOString(), null, NOW);
  assert.equal(far.active, true); assert.equal(far.imminent, false); assert.equal(far.daysLeft, 12);
});

test('trialBadgeState: 잔여가 하루 미만이어도 최소 D-1 — 살아 있는데 D-0이 없다', () => {
  const s = trialBadgeState(new Date(NOW + 0.2 * DAY).toISOString(), null, NOW);
  assert.equal(s.active, true); assert.equal(s.daysLeft, 1);
});

test('trialBadgeState: pro·파싱 불가·부재는 비활성', () => {
  assert.equal(trialBadgeState(new Date(NOW + 5 * DAY).toISOString(), 'pro', NOW).active, false);
  assert.equal(trialBadgeState('not-a-date', null, NOW).active, false);
  assert.equal(trialBadgeState(null, null, NOW).active, false);
});

test('trialBadgeState: trialEndsAt이 null이면(서버가 "체험 없음"으로 판정) 항상 비활성 — T 이후 가입자', () => {
  // R1: T 이후 가입자는 my_plan()이 trialEndsAt=null을 준다(entitlement.mjs 주석 참조). plan이
  // 무엇이든(보통 'free') 이 값 하나로 배지가 꺼져야 한다 — 클라가 따로 가입일을 계산하지 않는다.
  assert.equal(trialBadgeState(null, 'free', NOW).active, false);
});
