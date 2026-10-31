// 텔레그램 토큰 클레임 Delete·Put 왕복(2026-10-31 로그 수집 126% — 한 계정의 .tg-claims 파일마다 약 1분에 한 번 Delete 뒤 Put).
// 원인: 게이트웨이(10초마다 토큰 등록)가 회사 연결·회사 파일을 한 번 읽지 못하면 그 토큰이 빠져 setClaimTokens가 '해제'로 표시했고,
// 다음 등록에 토큰이 돌아와도 표시가 남아 다음 갱신(30초)이 원격 클레임을 지운 뒤(Delete) 곧바로 새로 획득(Put·확인 GET)했다.
// 처방: ① 게이트웨이는 읽기 실패한 회사의 직전 토큰을 유지(collectClaimTokens) ② 다시 들어온 토큰은 해제 표시를 거두고, 두 번 연속 없을 때만 해제 확정.
// 경우 표(PR 본문 · artifacts/tg-claims/case-table.md 추가 칸): F1 한 번 빠졌다 돌아옴 · F2 진짜 해제 · F3 연결 파일 읽기 실패 · F4 회사 폴더 삭제
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tgflap-'));
delete process.env.ARGO_SYNC;
await writeFile(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://fake.supabase.co', anonKey: 'fake-anon', refresh_token: 'fake-r', access_token: 'fake-a', user: { id: 'fake-uid' } }));
const { setClaimTokens, renewTokenClaims, tokenOwnership, tokenClaimHash, _setSyncClientForTest, _resetTokenClaimsForTest } = await import('../src/sync.mjs');
const { collectClaimTokens } = await import('../src/gateway.mjs');

/** 가짜 스토리지 — 요청 수를 센다(목록은 없음 → 토큰별 내려받기, 종전 경로). */
function fakeStorage() {
  const store = new Map(); const n = { get: 0, put: 0, del: 0 };
  const bucket = {
    async download(key) { n.get += 1; const v = store.get(key.split('?')[0]); return v ? { data: new Blob([v]) } : { data: null, error: { message: 'Object not found' } }; },
    async upload(key, blob) { n.put += 1; store.set(key, await blob.text()); return { error: null }; },
    async remove(keys) { for (const k of keys) { n.del += 1; store.delete(k); } return { error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, n };
}
const keyOf = (owner, token) => `${owner}/.tg-claims/${tokenClaimHash(token)}.json`;

/** 10분 흉내 — 게이트웨이 등록 10초마다, 갱신 30초마다(등록 뒤). missAt(i) = 그 등록에서 tokA가 빠지는가. */
async function simulate(missAt) {
  _resetTokenClaimsForTest();
  const fs_ = fakeStorage(); _setSyncClientForTest(fs_.client);
  const T0 = Date.now();
  for (let i = 0; i <= 60; i++) {
    const now = T0 + i * 10_000;
    setClaimTokens(missAt(i) ? ['tokB'] : ['tokA', 'tokB']);
    if (i % 3 === 0) await renewTokenClaims('owner1', { now });
  }
  return { ...fs_.n, store: fs_.store };
}

test('F1 — 등록에서 1분에 한 번 빠졌다 돌아오는 토큰: Delete 0, Put·GET은 빠지지 않은 경우와 같다(분당 요청 비증가)', async () => {
  const base = await simulate(() => false);
  const flap = await simulate((i) => i % 6 === 2); // 1분(등록 6번)에 한 번, 갱신 사이에 빠짐 — 종전엔 다음 갱신이 지우고 다시 썼다
  const flapAtRenew = await simulate((i) => i % 6 === 3); // 갱신 직전 등록에서 빠짐(갱신 시점에 집합에 없다)
  console.log(`[tg-flap] 10분 토큰 2개 — 기준 put=${base.put} get=${base.get} del=${base.del} / 갱신 사이 빠짐 put=${flap.put} get=${flap.get} del=${flap.del} / 갱신 직전 빠짐 put=${flapAtRenew.put} get=${flapAtRenew.get} del=${flapAtRenew.del}`);
  for (const r of [flap, flapAtRenew]) {
    assert.equal(r.del, 0, '원격 클레임을 지우지 않는다');
    assert.ok(r.put <= base.put, `Put이 늘지 않는다(${r.put} ≤ ${base.put})`);
    assert.ok(r.get <= base.get, `GET이 늘지 않는다(${r.get} ≤ ${base.get})`);
    assert.ok(r.store.has(keyOf('owner1', 'tokA')), '클레임이 남아 있다');
  }
  assert.equal(tokenOwnership('tokA').mine, true, '수신은 계속 이 기기');
});

test('F2 — 읽기에 성공했고 토큰이 정말 없음(두 번 연속 등록): 다음 갱신에 종전처럼 Delete 1', async () => {
  _resetTokenClaimsForTest();
  const fs_ = fakeStorage(); _setSyncClientForTest(fs_.client);
  setClaimTokens(['tokA']); await renewTokenClaims('owner1', { force: true });
  setClaimTokens([]);
  await renewTokenClaims('owner1', { force: true });
  assert.equal(fs_.n.del, 0, '한 번 빠진 것만으로는 지우지 않는다');
  setClaimTokens([]);
  await renewTokenClaims('owner1', { force: true });
  assert.equal(fs_.n.del, 1, '두 번 연속 없음 = 해제 확정 → 원격 클레임 제거');
  assert.equal(fs_.store.has(keyOf('owner1', 'tokA')), false);
  assert.equal(tokenOwnership('tokA').pending, true, '상태 폐기');
});

test('F3·F4 — collectClaimTokens: 연결 파일을 못 읽은 회사는 직전 토큰 유지, 폴더가 사라진 회사만 해제', () => {
  const last = new Map();
  const conn = (token, agents = {}) => ({ telegram: { enabled: true, token, agents } });
  assert.deepEqual(collectClaimTokens([[{ id: 'c1' }, conn('t1', { a: { token: 't2' } })], [{ id: 'c2' }, conn('t3')]], last, () => true), ['t1', 't2', 't3']);
  assert.deepEqual(collectClaimTokens([[{ id: 'c2' }, conn('t3')]], last, () => true).sort(), ['t1', 't2', 't3'], 'F3 c1 읽기 실패 — 직전 토큰 유지');
  assert.deepEqual(collectClaimTokens([[{ id: 'c1' }, conn('')], [{ id: 'c2' }, conn('t3')]], last, () => true), ['t3'], '읽기 성공 + 토큰 없음 = 해제');
  assert.deepEqual(collectClaimTokens([[{ id: 'c2' }, conn('t3')]], last, (id) => id !== 'c1'), ['t3'], 'F4 폴더가 사라진 회사는 빠진다');
  assert.equal(last.has('c1'), false);
  assert.deepEqual(collectClaimTokens([], last, () => true), ['t3'], '회사 목록 전체를 못 읽어도(빈 목록) 직전 토큰 유지');
});
