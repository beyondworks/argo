// 능동 비서 1단계 — 리스 글의 비서 엔진 번호(V1)와 리스 판정 값 읽기(leaseCheck).
// V1: 옛 버전 기기가 리더면 그 기기에는 감시기가 없어 비서 실행 0이다. 리더가 아닌 새 버전 기기는 매 주기 읽는 리스 글에서 엔진 번호가 없거나 낮은 것을 보고
//     "실행 기기가 옛 버전이라 비서가 꺼져 있음"(runner_outdated)을 안다. 리스 쓰기 횟수는 그대로다(칸 하나).
// renewLease는 leader-yield.test.mjs와 같은 가짜 저장소로 실제 결선째 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-lease-'));
process.env.ARGO_SYNC = '1';
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
// 동기화 켜짐(syncOn)을 만든다 — 가짜 기기 세션(전부 가짜 값, 네트워크 호출 없음). routine-missed-sync-gate.test.mjs와 같은 방법.
await writeFile(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://fake.supabase.co', anonKey: 'fake-anon', refresh_token: 'fake-r', access_token: 'fake-a', user: { id: 'fake-uid' } }));
delete process.env.ARGO_PREFER_LEADER;
delete process.env.ARGO_NO_LEADER;

const { renewLease, leaseCheck, syncOn, _setSyncClientForTest, LEASE_TTL_MS, LEASE_ASSISTANT_ENGINE } = await import('../src/sync.mjs');
const { getDeviceId } = await import('../src/workspace.mjs');
const { assistantRunnerStatus } = await import('../src/assistant/tick.mjs');

const fakeClient = (initialDoc = null) => {
  const calls = { upload: 0, docs: [] };
  let stored = initialDoc ? Buffer.from(JSON.stringify(initialDoc)) : null;
  const bucket = {
    async download() {
      if (!stored) return { data: null, error: { message: 'Object not found' } };
      const buf = stored;
      return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } };
    },
    async upload(_key, blob) { calls.upload += 1; stored = Buffer.from(await blob.arrayBuffer()); calls.docs.push(JSON.parse(stored.toString())); return { data: {}, error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, calls };
};
const lease = () => (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0, yieldSince: 0 });
const setLease = (patch) => Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0, holder: null }, patch);

test('전제 — 이 테스트 프로세스는 동기화 켜짐(가짜 기기 세션)', () => { assert.equal(syncOn(), true); });

test('V1-a: 이 기기가 리스를 잡으면 리스 글에 비서 엔진 번호를 싣는다(쓰기 1회 그대로) — 상태 "이 기기"', async () => {
  const me = await getDeviceId();
  const { client, calls } = fakeClient(null);
  _setSyncClientForTest(client);
  setLease({});
  await renewLease('owner-v1a', { runnerUsable: true });
  assert.equal(calls.upload, 1, '쓰기 수는 칸이 늘어도 그대로');
  assert.equal(calls.docs[0].assistant, LEASE_ASSISTANT_ENGINE);
  const li = leaseCheck();
  assert.equal(li.leader, true);
  assert.ok(li.ownedAt > 0 && li.checkedAt > 0);
  assert.deepEqual([li.holder.deviceId, li.holder.assistant], [me, LEASE_ASSISTANT_ENGINE]);
  assert.equal(assistantRunnerStatus(li), 'this_device', '확인된 보유자');
});

test('V1-b: 옛 버전 기기(엔진 번호 없음)가 리스를 쥐고 있으면 — 이 기기는 양보하고 상태 "실행 기기가 옛 버전이라 비서가 꺼져 있음"', async () => {
  const { client, calls } = fakeClient({ deviceId: 'old-mac-0197', token: 't', ts: Date.now() }); // 0.1.97 이하가 쓴 리스 글 모양
  _setSyncClientForTest(client);
  setLease({});
  await renewLease('owner-v1b', { runnerUsable: true });
  assert.equal(calls.upload, 0);
  const li = leaseCheck();
  assert.equal(li.leader, false, '비서는 리더에서만 돈다 — 이 기기에서는 실행 0');
  assert.deepEqual(li.holder && [li.holder.deviceId, li.holder.assistant], ['old-mac-0197', 0]);
  assert.equal(assistantRunnerStatus(li), 'runner_outdated');
});

test('V1-c: 새 버전 기기가 쥐고 있으면 "다른 기기가 실행", 리스가 만료됐으면 "실행 기기 없음", 동기화를 안 쓰면 "이 기기"', async () => {
  const { client } = fakeClient({ deviceId: 'new-mac', token: 't', ts: Date.now(), assistant: LEASE_ASSISTANT_ENGINE });
  _setSyncClientForTest(client);
  setLease({});
  await renewLease('owner-v1c', { runnerUsable: true });
  assert.equal(assistantRunnerStatus(leaseCheck()), 'other_device');
  const now = Date.now();
  assert.equal(assistantRunnerStatus({ syncOn: true, leader: false, ownedAt: 0, holder: { deviceId: 'x', assistant: 1, ts: now - LEASE_TTL_MS - 1 } }, now), 'no_runner');
  assert.equal(assistantRunnerStatus({ syncOn: true, leader: false, ownedAt: 0, holder: null }, now), 'no_runner');
  assert.equal(assistantRunnerStatus({ syncOn: false, leader: true, ownedAt: 0, holder: null }, now), 'this_device');
});

test('leaseCheck — 기본값(leader:true, ownedAt 0)은 확인된 보유가 아니다(비서는 이 값으로 리스 확인 전 호출 0)', () => {
  setLease({ leader: true, ownedAt: 0, checkedAt: 0 });
  const li = leaseCheck();
  assert.deepEqual([li.syncOn, li.leader, li.ownedAt, li.checkedAt], [true, true, 0, 0]);
});
