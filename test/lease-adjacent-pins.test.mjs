// 실행 담당 리스의 인접 행동 핀 — 예비(standby) 역할을 넣기 전부터 있던 동작이 그대로인지 잠근다(배포본에서도 통과해야 한다).
// 일반 기기(맥 앱·상주 :3001)·우선 기기(argo run 기본)·옛 리스 글(역할 표지 없음)의 판정과 쓰기 횟수(DB 위생: storage.objects 업서트)를 본다.
// leader-prefer·leader-yield와 같은 가짜 저장소로 renewLease 결선을 직접 구동한다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-pins-'));
process.env.ARGO_SYNC = '1';
// 동기화 켜짐(syncOn) — 기기 세션 파일이 있어야 isCloudLeader가 리스 표시를 본다(없으면 단일 기기로 보고 늘 참). 네트워크는 쓰지 않는다(가짜 저장소).
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-pins', email: '' } }), { mode: 0o600 });
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER']) delete process.env[k];
const { renewLease, isCloudLeader, _setSyncClientForTest, LEASE_TTL_MS } = await import('../src/sync.mjs');
const { getDeviceId } = await import('../src/workspace.mjs');

const fakeClient = (initialDoc = null) => {
  const calls = { upload: 0, download: 0 };
  let stored = initialDoc ? Buffer.from(JSON.stringify(initialDoc)) : null;
  const bucket = {
    async download() {
      calls.download += 1;
      if (!stored) return { data: null, error: { message: 'Object not found' } };
      const buf = stored;
      return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } };
    },
    async upload(_key, blob) { calls.upload += 1; stored = Buffer.from(await blob.arrayBuffer()); return { data: {}, error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, calls, doc: () => (stored ? JSON.parse(stored.toString()) : null) };
};
const lease = () => (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0, yieldSince: 0 });
const reset = (patch = {}) => Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0 }, patch);
afterEach(() => { delete process.env.ARGO_PREFER_LEADER; });

test('일반 기기는 다른 일반 기기의 새 리스에 양보한다 — 쓰기 0', async () => {
  const f = fakeClient({ deviceId: 'other-mac', token: 'o', ts: Date.now() });
  _setSyncClientForTest(f.client); reset();
  for (let i = 0; i < 3; i++) await renewLease('owner-pin1', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

test('옛 리스 글(역할 표지 없음)은 일반 기기 글로 읽는다 — 일반 기기는 양보, 쓰기 0', async () => {
  const f = fakeClient({ deviceId: 'old-build', token: 'x', ts: Date.now(), assistant: 1, unknownField: true });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-pin2', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

test('만료된 남의 리스는 바로 가져온다 — 쓰기 1번, 그 주기에 담당(맥이 꺼진 뒤 다른 기기가 이어받는 경로)', async () => {
  const f = fakeClient({ deviceId: 'gone-mac', token: 'g', ts: Date.now() - LEASE_TTL_MS - 1_000 });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-pin3', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.calls.upload, 1);
  assert.equal(f.doc().deviceId, await getDeviceId());
});

test('우선 기기(러너 있음)는 일반 기기의 새 리스를 가져와 두 주기 안에 담당이 되고, 쓰기는 1번이다', async () => {
  process.env.ARGO_PREFER_LEADER = '1';
  const f = fakeClient({ deviceId: 'mac-app', token: 'm', ts: Date.now() });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-pin4', { runnerUsable: true });
  await renewLease('owner-pin4', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.calls.upload, 1, '넘겨받는 데 쓰기 1번 — 두 번째 주기는 쓰지 않는다(30초 갱신 규칙)');
  assert.equal(f.doc().preferred, true);
});

test('담당 판정 — 동기화가 꺼져 있으면 담당, TTL 안에 확인한 보유자도 담당, 양보한 기기는 아님', () => {
  const sync = process.env.ARGO_SYNC;
  process.env.ARGO_SYNC = '0';
  try { reset({ leader: false }); assert.equal(isCloudLeader(), true, '동기화 off = 단일 기기'); } finally { process.env.ARGO_SYNC = sync; }
  reset({ leader: true, ownedAt: Date.now() - 20_000, checkedAt: Date.now() - 3_000 });
  assert.equal(isCloudLeader(), true);
  reset({ leader: false, ownedAt: 0, checkedAt: Date.now() });
  assert.equal(isCloudLeader(), false);
});
