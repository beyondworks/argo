// 위험 파일 검수 R-1(2026-09-23): 두 기기가 동시에 E2EE를 켜도 서로 다른 DEK가 둘 다 확정되지 않는다.
// 전에는 "다른 기기 랩 없음 확인 → 자기 랩 기록" 순서라 동시에 누르면 둘 다 통과해 열쇠가 갈라졌다(서로 암호문을 못 연다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-e2ee-race-'));
const { claimFirstWrap } = await import('../src/e2ee.mjs');

// wrapped_deks 한 계정분(RLS가 user_id로 거른 모양) — 호출마다 한 틱 양보해 두 요청이 실제로 엇갈리게 한다.
function fakeSb() {
  const rows = new Map();
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    rows,
    from: () => ({
      upsert: async (row) => { await tick(); rows.set(row.device_id, row); return { error: null }; },
      select: () => ({ neq: (_c, id) => ({ limit: async () => { await tick(); return { data: [...rows.keys()].filter((k) => k !== id).map((device_id) => ({ device_id })), error: null }; } }) }),
      delete: () => ({ eq: async (_c, id) => { await tick(); rows.delete(id); return { error: null }; } }),
    }),
  };
}

test('claimFirstWrap: 동시에 켜면 둘 다 확정되지 않고, 물러난 기기의 새 랩은 남지 않는다', async () => {
  const sb = fakeSb();
  const [a, b] = await Promise.all([
    claimFirstWrap(sb, { userId: 'u', deviceId: 'A', wrap: 'wa', fresh: true }),
    claimFirstWrap(sb, { userId: 'u', deviceId: 'B', wrap: 'wb', fresh: true }),
  ]);
  assert.ok(!(a && b), '두 기기가 서로 다른 DEK로 동시에 확정되면 안 된다');
  for (const [id, won] of [['A', a], ['B', b]]) assert.equal(sb.rows.has(id), won, `${id}: 확정한 기기만 랩이 남는다`);
});

test('claimFirstWrap: 혼자 켜면 확정, 뒤이어 다른 기기가 켜려 하면 물러난다', async () => {
  const sb = fakeSb();
  assert.equal(await claimFirstWrap(sb, { userId: 'u', deviceId: 'A', wrap: 'wa', fresh: true }), true);
  assert.equal(await claimFirstWrap(sb, { userId: 'u', deviceId: 'B', wrap: 'wb', fresh: true }), false);
  assert.deepEqual([...sb.rows.keys()], ['A']);
});

test('claimFirstWrap: 기존 자기 랩을 이어 쓴 경우(fresh:false)는 물러나도 지우지 않는다', async () => {
  const sb = fakeSb();
  sb.rows.set('B', { device_id: 'B' });
  assert.equal(await claimFirstWrap(sb, { userId: 'u', deviceId: 'A', wrap: 'wa', fresh: false }), false);
  assert.ok(sb.rows.has('A'));
});
