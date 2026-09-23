// 위험 파일 검수 R-1(2026-09-23): 두 기기가 동시에 E2EE를 켜도 서로 다른 DEK가 둘 다 확정되지 않는다.
// 전에는 "다른 기기 랩 없음 확인 → 자기 랩 기록" 순서라 동시에 누르면 둘 다 통과해 열쇠가 갈라졌다(서로 암호문을 못 연다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-e2ee-race-'));
const { claimFirstWrap, tryClaimDek, _resetClaimForTest, loadDeviceE2ee, wrapDekFor, dek, clearDekCache } = await import('../src/e2ee.mjs');

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
      delete: () => { // .eq(열, 값)을 이어 붙인 조건을 모두 만족하는 행만 지운다
        const conds = [];
        const q = { eq: (c, v) => { conds.push([c, v]); return q; },
          then: (ok, bad) => (async () => {
            await tick(); if (deleteFails) return { error: { message: 'timeout' } };
            for (const [id, r] of rows) if (conds.every(([c, v]) => (c === 'device_id' ? id : r[c]) === v)) rows.delete(id);
            return { error: null };
          })().then(ok, bad) };
        return q;
      },
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

test('회수를 거절한 자기 랩은 지워져 다른 기기 화면에 승인 대상으로 돌아온다(검수 #687 LOW) — 로컬에 열쇠가 없는 기기만', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-e2ee-nodek-'));
  const sb = fakeSb();
  clearDekCache();
  const b = await loadDeviceE2ee({ root });
  sb.rows.set('A', { device_id: 'A', wrap: 'wa', wrapped_by: 'A' });
  sb.rows.set('B', { device_id: 'B', wrap: wrapDekFor(b.pub, Buffer.alloc(32, 7)).toString('base64'), wrapped_by: 'B' });
  clearDekCache(); _resetClaimForTest();
  assert.equal(await tryClaimDek(sb, 'B', { force: true, root }), false);
  assert.equal(sb.rows.has('B'), false, 'B 행이 남으면 hasWrap=true라 A에서 승인 버튼이 안 뜬다');
  assert.ok(sb.rows.has('A'), '다른 기기 행은 건드리지 않는다');
});

// 검수 #693 MEDIUM 재현: 처음 켠 기기(자기 랩)가 재시작하면 sync 첫 사이클이 키 파일을 읽기 전에 회수를 부른다 — 그때 자기 행을 지우면
// 열쇠를 가진 기기가 다른 기기 화면에 '승인 대기'로 뜨고 제거될 수 있다. 로컬 DEK가 있으면 서버 행을 건드리지 않고 true.
test('로컬 키 파일에 열쇠가 있는 기기는 재시작 직후(캐시 비움) 회수에서도 자기 랩을 지우지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-e2ee-restart-'));
  clearDekCache();
  const a = await loadDeviceE2ee({ root });
  const { setDek } = await import('../src/e2ee.mjs');
  await setDek(Buffer.alloc(32, 5), { root });
  const sb = fakeSb();
  sb.rows.set('A', { device_id: 'A', wrap: wrapDekFor(a.pub, Buffer.alloc(32, 5)).toString('base64'), wrapped_by: 'A' });
  sb.rows.set('B', { device_id: 'B', wrap: 'wb', wrapped_by: 'A' });
  clearDekCache(); _resetClaimForTest(); // 재시작: 메모리 캐시 없음, 디스크엔 열쇠
  assert.equal(await tryClaimDek(sb, 'A', { force: true, root }), true);
  assert.ok(sb.rows.has('A'), '정상 기기의 자기 랩은 남는다');
});

test('거절 뒤 삭제는 자기가 랩한 행만 — 그 사이 커밋된 승인 랩은 지우지 않는다(검수 #693 LOW)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-e2ee-approve-race-'));
  clearDekCache();
  const b = await loadDeviceE2ee({ root });
  const sb = fakeSb();
  sb.rows.set('A', { device_id: 'A', wrap: 'wa', wrapped_by: 'A' });
  sb.rows.set('B', { device_id: 'B', wrap: wrapDekFor(b.pub, Buffer.alloc(32, 7)).toString('base64'), wrapped_by: 'B' });
  const from = sb.from; // 다른 기기 조회 직후 A의 승인 upsert가 커밋된다
  sb.from = () => { const t = from(); const sel = t.select; t.select = (...a) => { const s = sel(...a); const neq = s.neq; s.neq = (...n) => ({ limit: async () => { const r = await neq(...n).limit(); sb.rows.set('B', { device_id: 'B', wrap: 'approved', wrapped_by: 'A' }); return r; } }); return s; }; return t; };
  clearDekCache(); _resetClaimForTest();
  assert.equal(await tryClaimDek(sb, 'B', { force: true, root }), false);
  assert.equal(sb.rows.get('B')?.wrapped_by, 'A', '승인 랩이 남는다');
});
