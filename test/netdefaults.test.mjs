// happy-eyeballs 시도 제한 상향 회귀 가드 — workspace.mjs(코어 공용 진입)를 import하면
// 프로세스 전역 기본값이 2000ms로 올라가 있어야 한다. 250ms 기본값으로 돌아가면
// RTT 250ms+ 원격지(텔레그램 EU 등) fetch가 전멸한다(2026-07-24 실측).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

test('workspace import가 autoSelectFamilyAttemptTimeout을 2000ms로 올린다', async () => {
  await import('../src/workspace.mjs');
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 2000);
});
