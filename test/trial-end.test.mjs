// trialEnd — 체험 D-day 배지·임박 배너의 단일 원천. 여기가 어긋나면 배너 시점과
// 서버 실제 차단 시점(is_pro의 14일 창)이 조용히 불일치한다(분리 검수 권고로 잠금).
import test from 'node:test';
import assert from 'node:assert/strict';
import { trialEnd, TRIAL_DAYS } from '../src/entitlement.mjs';

test('trialEnd: pro면 null — 배지·배너 의미 없음', () => {
  assert.equal(trialEnd('2026-07-01T00:00:00Z', 'pro'), null);
});

test('trialEnd: 가입 + TRIAL_DAYS 정확히 — 서버 is_pro 14일 창과 대칭', () => {
  const c = '2026-07-01T00:00:00Z';
  const end = trialEnd(c, null);
  assert.equal(Date.parse(end) - Date.parse(c), TRIAL_DAYS * 86_400_000);
  assert.equal(trialEnd(c, 'free'), end); // free 명시 행도 동일(취소 후에도 잔여 체험창 유지 계약)
});

test('trialEnd: 파싱 불가·부재는 null — D-NaN 배지 원천 차단', () => {
  assert.equal(trialEnd('not-a-date', null), null);
  assert.equal(trialEnd(null, null), null);
  assert.equal(trialEnd(undefined, 'free'), null);
});
