// 서버 기억 조회가 일시 실패하면 같은 크루·채널의 마지막 기억을 쓴다 — 조직 규칙이 조용히 빠지지 않게(검수 #691 M1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-memcache-'));
const M = await import('../src/gateway/msgr.mjs');

test('성공한 기억을 기억해 두었다가 실패하면 그것을 쓰고, 옛 서버(undefined)는 그대로 물러난다', async () => {
  M._resetServerMemoryProbeForTest();
  const mem = { docs: [{ scope: 'org', folder: 'rules', title: '말투', body: '존댓말' }], journal: '' };
  let mode = 'ok';
  const db = { crewMemory: async () => { if (mode === 'fail') throw new Error('net'); return mode === 'old' ? undefined : mem; } };
  assert.deepEqual(await M.crewMemoryCached(db, 'c1', 'ch1'), mem);
  mode = 'fail';
  assert.deepEqual(await M.crewMemoryCached(db, 'c1', 'ch1'), mem, '실패 → 마지막 기억');
  assert.equal(await M.crewMemoryCached(db, 'c1', 'ch2'), undefined, '다른 채널 기억은 섞지 않는다');
  mode = 'old';
  assert.equal(await M.crewMemoryCached(db, 'c1', 'ch1'), undefined, '옛 서버 — 미러 경로');
});

test('새 서버 판별은 가벼운 msgr_channel_access로 — 없으면 false, 예외면 판정 불가(null)', async () => {
  M._resetServerMemoryProbeForTest();
  assert.equal(await M.serverMemoryAvailable({ channelAccess: async () => new Map() }, 'c'), true);
  M._resetServerMemoryProbeForTest();
  assert.equal(await M.serverMemoryAvailable({ channelAccess: async () => null }, 'c'), false);
  M._resetServerMemoryProbeForTest();
  assert.equal(await M.serverMemoryAvailable({ channelAccess: async () => { throw new Error('net'); } }, 'c'), null);
  M._resetServerMemoryProbeForTest();
});
