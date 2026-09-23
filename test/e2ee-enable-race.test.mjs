// 위험 파일 검수 R-1(2026-09-23): 두 기기가 동시에 E2EE를 켜도 서로 다른 DEK가 둘 다 확정되지 않는다.
// 전에는 "다른 기기 랩 없음 확인 → 자기 랩 기록" 순서라 동시에 누르면 둘 다 통과해 열쇠가 갈라졌다(서로 암호문을 못 연다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-e2ee-race-'));
const { claimFirstWrap, tryClaimDek, _resetClaimForTest, loadDeviceE2ee, wrapDekFor, dek } = await import('../src/e2ee.mjs');

// wrapped_deks 한 계정분(RLS가 user_id로 거른 모양) — 호출마다 한 틱 양보해 두 요청이 실제로 엇갈리게 한다.
function fakeSb({ deleteFails = false } = {}) {
  const rows = new Map();
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    rows,
    from: () => ({
      upsert: async (row) => { await tick(); rows.set(row.device_id, row); return { error: null }; },
      select: () => ({
        neq: (_c, id) => ({ limit: async () => { await tick(); return { data: [...rows.keys()].filter((k) => k !== id).map((device_id) => ({ device_id })), error: null }; } }),
        eq: (_c, id) => ({ maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }) }),
      }),
      delete: () => ({ eq: async (_c, id) => { await tick(); if (deleteFails) return { error: { message: 'timeout' } }; rows.delete(id); return { error: null }; } }),
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

test('물러난 기기의 랩 삭제가 실패해도, 그 기기는 남은 자기 랩을 열쇠로 집지 않는다(검수 #687 MEDIUM)', async () => {
  const sb = fakeSb({ deleteFails: true });
  const b = await loadDeviceE2ee();
  sb.rows.set('A', { device_id: 'A', wrap: 'wa', wrapped_by: 'A' });
  const wrap = wrapDekFor(b.pub, Buffer.alloc(32, 9)).toString('base64');
  assert.equal(await claimFirstWrap(sb, { userId: 'u', deviceId: 'B', wrap, fresh: true }), false);
  assert.ok(sb.rows.has('B'), '삭제 실패 — B의 새 랩이 남았다');
  _resetClaimForTest();
  assert.equal(await tryClaimDek(sb, 'B', { force: true }), false, 'A가 켠 계정에서 B의 새 DEK를 확정하면 열쇠가 갈라진다');
  assert.equal(dek(), null);
  sb.rows.delete('A'); _resetClaimForTest();
  assert.equal(await tryClaimDek(sb, 'B', { force: true }), true, '다른 기기가 없으면 자기 랩도 회수한다');
});
