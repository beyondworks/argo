// 리더 양보 판정 회귀 가드(유건 지시 2026-07-25) — 러너 없는 기기는 그레이스 동안 리스 신규 획득을
// 양보하고, 그레이스가 지나면 리더 공백 방지를 위해 그래도 획득한다. 러너 있으면 절대 양보하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldYieldAcquire, YIELD_GRACE_CYCLES } from '../src/sync.mjs';

test('러너 있으면 양보하지 않는다', () => {
  assert.equal(shouldYieldAcquire(true, 0), false);
  assert.equal(shouldYieldAcquire(true, YIELD_GRACE_CYCLES + 5), false);
});

test('러너 없으면 그레이스 동안 양보', () => {
  assert.equal(shouldYieldAcquire(false, 0), true);
  assert.equal(shouldYieldAcquire(false, YIELD_GRACE_CYCLES - 1), true);
});

test('그레이스 소진 후엔 러너 없어도 획득 — 리더 공백 방지', () => {
  assert.equal(shouldYieldAcquire(false, YIELD_GRACE_CYCLES), false);
  assert.equal(shouldYieldAcquire(false, YIELD_GRACE_CYCLES + 1), false);
});

test('그레이스는 리스 TTL보다 길다 — 자격 있는 기기에게 최소 한 TTL의 선점 기회', async () => {
  const { LEASE_TTL_MS } = await import('../src/sync.mjs');
  const CYCLE_MS = 8_000; // sync 기본 주기
  assert.ok(YIELD_GRACE_CYCLES * CYCLE_MS > LEASE_TTL_MS);
});
