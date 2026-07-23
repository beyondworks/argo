// 리스 **배선** 회귀 테스트 — 판정식이 아니라 renewLease의 실제 결선을 잠근다.
// architect 변이 테스트가 증명했다: `if (!heldByMe) { leader=false }` 한 줄을 지워(= 반려 당시 버그 복원)도
// 판정식 테스트(test/sync-lease.test.mjs)는 전부 통과한다. 그래서 배선을 직접 구동해 잠근다.
//
// 격리: Node test runner는 파일별 별도 프로세스라, ARGO_ROOT를 먼저 세팅한 뒤 sync.mjs를 동적 import해야
// WS_ROOT(모듈 로드 시 고정)가 임시 루트를 가리킨다(test/sync-integration.test.mjs와 동일 규약).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-wire-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';

const { renewLease, _setSyncClientForTest, LEASE_TTL_MS } = await import('../src/sync.mjs');

/** 업로드를 항상 거부하는 fake storage — RLS 거부/네트워크 실패 재현. 리스는 원격에 없음(download 빈 응답). */
const rejectingClient = () => {
  const bucket = {
    async download() { return { data: null, error: { message: 'Object not found' } }; },
    async upload() { return { data: null, error: { message: 'new row violates row-level security policy' } }; },
  };
  return { storage: { from: () => bucket } };
};

const lease = () => (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0 });
const setLease = (patch) => Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0 }, patch);

test('배선: 업로드 거부 + 미획득 기본값 → 리더 강등 [이중 리더 차단]', async () => {
  _setSyncClientForTest(rejectingClient());
  setLease({ leader: true, ownedAt: 0 }); // 갓 기동한 프로세스의 기본값
  await renewLease('owner-wire');
  assert.equal(lease().leader, false, '획득을 확인하지 못한 리더십은 유지되면 안 된다');
  assert.equal(lease().ownedAt, 0);
});

test('배선: 업로드 거부 + 확인된 보유자(TTL 내) → 리더 유지 [일시 장애 흡수]', async () => {
  _setSyncClientForTest(rejectingClient());
  setLease({ leader: true, ownedAt: Date.now() - 1_000 });
  await renewLease('owner-wire');
  assert.equal(lease().leader, true, '확인된 보유자는 일시 실패로 끊기지 않아야 한다');
});

test('배선: 업로드 거부 + 보유 이력 TTL 경과 → 강등 [지속 실패는 수렴]', async () => {
  _setSyncClientForTest(rejectingClient());
  setLease({ leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1 });
  await renewLease('owner-wire');
  assert.equal(lease().leader, false);
  assert.equal(lease().ownedAt, 0);
});
