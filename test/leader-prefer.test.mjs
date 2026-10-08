// 실행 담당 우선 기기(ARGO_PREFER_LEADER=1) — 항상 켜진 서버(argo CLI 상주)가 메신저·루틴 담당을 맡는다(유건 결정 2026-09-29).
// 맥 앱이 리스를 잡고 있어도 서버가 가져오고, 맥은 다음 주기에 "다른 기기의 새 리스"를 보고 양보한다(옛 버전 앱도 같은 규칙).
// 배선 테스트 — leader-yield.test.mjs와 같은 가짜 저장소로 renewLease 결선을 직접 잠근다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-prefer-'));
process.env.ARGO_SYNC = '1';
const { renewLease, _setSyncClientForTest, HANDOVER_WAIT_MS } = await import('../src/sync.mjs');

const fakeClient = (initialDoc = null) => {
  const calls = { upload: 0 };
  let stored = initialDoc ? Buffer.from(JSON.stringify(initialDoc)) : null;
  const bucket = {
    async download() {
      if (!stored) return { data: null, error: { message: 'Object not found' } };
      const buf = stored;
      return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } };
    },
    async upload(_key, blob) { calls.upload += 1; stored = Buffer.from(await blob.arrayBuffer()); return { data: {}, error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, calls, doc: () => (stored ? JSON.parse(stored.toString()) : null) };
};
const lease = () => (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0, yieldSince: 0 });
// 깨어 있은 지 오래된 프로세스로 — 되찾기는 끊김 없이 30초 깨어 있은 뒤에만 한다(sync.mjs AWAKE_MIN_MS, lease-standby.test.mjs가 잠근다). 여기서는 역할 판정만 본다.
const awakeLong = () => Object.assign((globalThis.__argoSyncAwake ??= {}), { since: Date.now() - 10 * 60_000, wall: Date.now(), mono: performance.now() });
const reset = () => { awakeLong(); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000; return Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0, pending: null, token: null, validUntil: 0, peers: {}, peersSavedAt: {} }); };
afterEach(() => { delete process.env.ARGO_PREFER_LEADER; });

test('우선 기기는 다른 일반 기기가 잡은 새 리스를 가져온다 — 리스에 preferred 표시', async () => {
  process.env.ARGO_PREFER_LEADER = '1';
  const f = fakeClient({ deviceId: 'mac-app', token: 'm', ts: Date.now() });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-p1', { runnerUsable: true });
  // 넘겨받기(2026-10-08): 남의 새 리스를 가져와도 바로 담당을 시작하지 않는다 — 앞 담당(맥)이 리스를 다시 읽고 물러날 시간(HANDOVER_WAIT_MS = 한 주기 + 2초)까지(겹침 0)
  assert.equal(lease().leader, false, '가져온 주기에는 아직 담당이 아니다');
  assert.equal(f.calls.upload, 1);
  assert.equal(f.doc().preferred, true, '다른 우선 기기와 서로 뺏지 않게 표시를 남긴다');
  await renewLease('owner-p1', { runnerUsable: true });
  assert.equal(lease().leader, false, '앞 담당이 리스를 다시 읽을 시간(HANDOVER_WAIT_MS)이 지나기 전에는 주기가 돌아도 담당이 아니다');
  lease().pending.ts -= HANDOVER_WAIT_MS;
  await renewLease('owner-p1', { runnerUsable: true });
  assert.equal(lease().leader, true, '그 시간이 지난 뒤 그 글이 그대로면 담당');
  assert.equal(f.calls.upload, 1, '확인 주기는 쓰지 않는다');
});

test('우선 기기끼리는 먼저 잡은 쪽을 존중한다(뺏고 뺏기는 요동 금지)', async () => {
  process.env.ARGO_PREFER_LEADER = '1';
  const f = fakeClient({ deviceId: 'other-server', token: 's', ts: Date.now(), preferred: true });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-p2', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

test('일반 기기(맥 앱)는 우선 기기가 잡은 새 리스에 양보한다 — 기존 규칙 그대로', async () => {
  const f = fakeClient({ deviceId: 'server', token: 's', ts: Date.now(), preferred: true });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-p3', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

test('러너가 없는 우선 기기는 가져오지 않는다 — 답할 수 없는 기기가 담당이 되면 안 된다', async () => {
  process.env.ARGO_PREFER_LEADER = '1';
  const f = fakeClient({ deviceId: 'mac-app', token: 'm', ts: Date.now() });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-p4', { runnerUsable: false });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

test('관찰 전용(ARGO_NO_LEADER=1 — argo 대화 화면)은 리스를 잡지도 쓰지도 않는다 — 대화 화면을 열어 둔 것만으로 담당을 빼앗으면 아무도 메신저에 답하지 않는다', async () => {
  process.env.ARGO_NO_LEADER = '1';
  try {
    const f = fakeClient(null); // 빈 리스 — 평소라면 획득한다
    _setSyncClientForTest(f.client); reset();
    await renewLease('owner-p5', { runnerUsable: true });
    assert.equal(lease().leader, false);
    assert.equal(f.calls.upload, 0);
  } finally { delete process.env.ARGO_NO_LEADER; }
});
