// 리더 양보 — 판정식 + **배선**을 함께 잠근다(유건 지시 2026-07-25, 사후 검수 M-4 반영).
// 배선 테스트가 필요한 이유는 sync-lease-wiring.test.mjs 머리 주석과 동일: 판정식만 검증하면
// renewLease 안의 양보 분기·인자 결선을 지워도 테스트가 전부 통과한다(변이 테스트로 증명된 패턴).
//
// 격리: ARGO_ROOT를 먼저 세팅한 뒤 동적 import(WS_ROOT가 모듈 로드 시 고정 — 기존 배선 테스트 규약).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-yield-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';

const { renewLease, _setSyncClientForTest, shouldYieldAcquire, YIELD_GRACE_MS, LEASE_TTL_MS } = await import('../src/sync.mjs');
const { getDeviceId } = await import('../src/workspace.mjs');

/* ── 판정식 (순수) ── */

test('판정: 러너 있으면 어떤 시점에도 양보하지 않는다', () => {
  assert.equal(shouldYieldAcquire(true, 0), false);
  assert.equal(shouldYieldAcquire(true, Date.now()), false);
});

test('판정: 러너 없으면 그레이스(시간) 동안 양보, 소진 후엔 획득 — 리더 공백 방지', () => {
  const now = Date.now();
  assert.equal(shouldYieldAcquire(false, 0, now), true, '첫 판정(타이머 미시작)은 양보');
  assert.equal(shouldYieldAcquire(false, now - (YIELD_GRACE_MS - 1000), now), true, '그레이스 내 양보 지속');
  assert.equal(shouldYieldAcquire(false, now - YIELD_GRACE_MS, now), false, '그레이스 소진 → 획득');
});

test('판정: 그레이스는 리스 TTL보다 길다 — 자격 있는 기기에게 최소 한 TTL의 선점 기회', () => {
  assert.ok(YIELD_GRACE_MS > LEASE_TTL_MS);
});

/* ── 배선 (renewLease 실제 결선) ── */

/** fake storage — 업로드를 기록하고, 이후 download는 마지막 업로드 본문(리스 문서)을 돌려준다. */
const fakeClient = (initialDoc = null) => {
  const calls = { upload: 0 };
  let stored = initialDoc ? Buffer.from(JSON.stringify(initialDoc)) : null;
  const bucket = {
    async download() {
      if (!stored) return { data: null, error: { message: 'Object not found' } };
      const buf = stored;
      return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } };
    },
    async upload(_key, blob) {
      calls.upload += 1;
      stored = Buffer.from(await blob.arrayBuffer());
      return { data: {}, error: null };
    },
  };
  return { client: { storage: { from: () => bucket } }, calls };
};

const lease = () => (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0, yieldSince: 0 });
const setLease = (patch) => Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0 }, patch);

test('배선: 러너 없음 + 빈 리스 → 양보(리더 아님 + 업로드 0회)', async () => {
  const { client, calls } = fakeClient(null);
  _setSyncClientForTest(client);
  setLease({});
  await renewLease('owner-y1', { runnerUsable: false });
  assert.equal(lease().leader, false, '양보 중엔 리더가 아니어야 한다');
  assert.equal(calls.upload, 0, '양보 중엔 리스를 쓰지 않아야 한다');
});

test('배선(HIGH-1): 재시작 프로세스는 자기 기기의 잔존 fresh 리스라도 양보 판정을 거친다', async () => {
  const me = await getDeviceId();
  const { client, calls } = fakeClient({ deviceId: me, token: 't0', ts: Date.now() }); // 직전 프로세스가 남긴 fresh 리스
  _setSyncClientForTest(client);
  setLease({ ownedAt: 0 }); // 재시작 = 미획득 기본값
  await renewLease('owner-y2', { runnerUsable: false });
  assert.equal(lease().leader, false, '러너 없는 재시작 프로세스가 잔존 리스로 리더에 복귀하면 안 된다');
  assert.equal(calls.upload, 0);
});

test('배선: 그레이스 소진 후엔 러너 없어도 획득한다(업로드 발생)', async () => {
  const { client, calls } = fakeClient(null);
  _setSyncClientForTest(client);
  setLease({ yieldSince: Date.now() - YIELD_GRACE_MS - 1_000 });
  await renewLease('owner-y3', { runnerUsable: false });
  assert.ok(calls.upload >= 1, '그레이스 소진 후엔 리스를 써야 한다(리더 공백 방지)');
  assert.equal(lease().leader, true);
});

test('배선: 러너 있으면 정상 획득 + 양보 타이머 리셋', async () => {
  const { client, calls } = fakeClient(null);
  _setSyncClientForTest(client);
  setLease({ yieldSince: Date.now() - 5_000 }); // 직전에 양보 중이었더라도
  await renewLease('owner-y4', { runnerUsable: true });
  assert.ok(calls.upload >= 1);
  assert.equal(lease().leader, true);
  assert.equal(lease().yieldSince, 0, '러너 회복 시 양보 타이머는 리셋');
});
