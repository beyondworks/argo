// 예비(standby) 실행 기기 — 맥이 켜진 동안은 맥이, 맥이 꺼지거나 연결이 끊기면 서버(VPS)가 실행 담당을 맡고, 맥이 다시 켜지면 맥이 되찾는다(유건 요구 2026-10-08).
// 역할 순위: 우선(argo run 기본) > 일반(맥 앱·상주·--no-prefer) > 예비(argo run --standby). 더 높은 역할의 기기는 낮은 역할이 잡은 새 리스를
// **러너가 있을 때만** 가져오고(그레이스로도 우회하지 않는다), 가져올 때는 한 주기를 기다려 앞 담당이 물러난 뒤에 담당을 시작한다(겹침 0).
// 담당이던 기기가 잠들었다 깨면 그 사이 다른 기기가 가져갔을 수 있으므로 다시 확인하기 전까지 담당이 아니다.
// 가짜 저장소로 renewLease 결선을 직접 구동한다(leader-prefer.test.mjs와 같은 방식). 쓰기 횟수는 DB 위생(storage.objects 업서트) 기준이다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-standby-'));
process.env.ARGO_SYNC = '1';
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-standby', email: '' } }), { mode: 0o600 });
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER']) delete process.env[k];
const { renewLease, isCloudLeader, standbyIdle, _setSyncClientForTest, LEASE_TTL_MS, YIELD_GRACE_MS, HANDOVER_WAIT_MS, AWAKE_MIN_MS = 30_000, LEASE_CONFIRM_VALID_MS = 0 } = await import('../src/sync.mjs');
const { existsSync, readFileSync, rmSync } = await import('node:fs');
const { leaseRole } = await import('../src/lease-role.mjs');
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();

/** 가짜 저장소. failReads(...errs) = 다음 리스 읽기들이 차례대로 돌려줄 오류(supabase-js download는 오류를 던지지 않고 { data: null, error }로 준다 —
    { throw }를 주면 그 읽기가 던진다: 응답 본문 중단 등). staleCdn(doc) = CDN이 들고 있는 옛 사본 — cacheNonce·?t= 없는 읽기는 이걸 받는다. */
const fakeClient = (initialDoc = null) => {
  const calls = { upload: 0, download: 0 };
  let stored = initialDoc ? Buffer.from(JSON.stringify(initialDoc)) : null;
  let cdn = null;
  let delayMs = 0;
  let upDelayMs = 0;
  const failNext = [];
  const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
  const bucket = {
    async download(key, opts) {
      calls.download += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const f = failNext.shift();
      if (f?.throw) throw f.throw;
      if (f) return { data: null, error: f };
      const busted = opts?.cacheNonce != null || String(key).includes('?t=');
      if (cdn && !busted) return body(cdn);
      if (!stored) return { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } };
      return body(stored);
    },
    async upload(_key, blob) { calls.upload += 1; stored = Buffer.from(await blob.arrayBuffer()); if (upDelayMs) await new Promise((r) => setTimeout(r, upDelayMs)); return { data: {}, error: null }; },
  };
  return {
    client: { storage: { from: () => bucket } }, calls,
    doc: () => (stored ? JSON.parse(stored.toString()) : null),
    set: (doc) => { stored = Buffer.from(JSON.stringify(doc)); }, // 다른 기기의 쓰기
    failReads: (...errs) => { failNext.push(...errs); },
    staleCdn: (doc) => { cdn = Buffer.from(JSON.stringify(doc)); },
    slow: (ms) => { delayMs = ms; }, // 읽기 응답이 이만큼 늦게 온다
    slowUpload: (ms) => { upDelayMs = ms; }, // 쓰기 응답이 이만큼 늦게 온다(서버에는 바로 닿는다)
  };
};
/** supabase-js가 실제로 돌려주는 읽기 오류 모양(2.110.2 handleError) — 없음('Object not found')이 아닌 것들. */
const READ_ERRORS = [
  { name: 'StorageApiError', message: 'Internal Server Error', status: 500, statusCode: '500' },
  { name: 'StorageApiError', message: 'Bad Gateway', status: 502, statusCode: '502' },
  { name: 'StorageUnknownError', message: 'fetch failed' },
  { name: 'StorageApiError', message: 'Bucket not found', status: 400, statusCode: '404' }, // 만료 토큰 GET을 Storage가 익명으로 처리(2026-10-05 운영 storage_logs)
  { throw: new TypeError('terminated') }, // 응답 본문을 받다 끊김 — blob()이 던진다
];
const lease = () => (globalThis.__argoSyncLease ??= { leader: true, checkedAt: 0, ownedAt: 0, yieldSince: 0 });
/** 이 프로세스가 ms 전부터 끊김 없이 깨어 있던 것으로(되찾기 조건 AWAKE_MIN_MS). 관찰 시각도 지금으로 맞춰 '잠들었다 깸'으로 읽히지 않게 하고,
    2초 관찰 타이머는 끈다 — 부하가 큰 CI에서 테스트 사이 멈춤을 잠자기로 읽어 깨어 있은 시간을 다시 세지 않게(관찰은 renewLease·isCloudLeader가 부를 때만). */
const awakeFor = (ms) => {
  const a = (globalThis.__argoSyncAwake ??= {});
  if (a.timer && typeof a.timer !== 'string') clearInterval(a.timer);
  return Object.assign(a, { timer: 'test', since: Date.now() - ms, wall: Date.now(), mono: performance.now(), wokeAt: 0 });
};
/** 이 파일의 계정(기기 세션 사용자) — 다른 기기를 본 적 있음 표지는 계정마다 둔다. */
const ACCT = 'u-standby';
/** sawPeer: true = 이 계정이 방금 다른 기기의 리스를 봤다(엄격 판정) — 테스트마다 정한다(앞 테스트가 본 기기가 남지 않게). 기본은 본 적 없는 단일 기기. */
const reset = (patch = {}) => {
  awakeFor(10 * 60_000); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000;
  const { sawPeer, ...rest } = patch;
  return Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false, token: null, validUntil: 0,
    peers: sawPeer ? { [ACCT]: { at: Date.now(), normals: [] } } : {}, peersSavedAt: sawPeer ? { [ACCT]: Date.now() } : {} }, rest);
};
/** 확인된 보유자 상태 — 리스 글(doc)이 내 것이고 방금 확인했다(엄격 판정의 담당 기한 안). */
const held = (doc, patch = {}) => reset({ leader: true, ownedAt: Date.now() - 5_000, checkedAt: Date.now(), token: doc.token, validUntil: Date.now() + 10_000, ...patch });
const role = (r) => {
  delete process.env.ARGO_PREFER_LEADER; delete process.env.ARGO_STANDBY_LEADER;
  if (r === 'preferred') process.env.ARGO_PREFER_LEADER = '1';
  if (r === 'standby') process.env.ARGO_STANDBY_LEADER = '1';
};
afterEach(() => role('normal'));
const fresh = (deviceId, extra = {}) => ({ deviceId, token: `t-${deviceId}`, ts: Date.now(), assistant: 2, ...extra });
/** 넘겨받기 대기(HANDOVER_WAIT_MS)가 지난 것으로 — 내 글을 쓴 시각(메모리)만 앞당긴다. 리스 글의 ts는 그대로라 보유 시각 단언이 흔들리지 않는다. */
const elapseHandover = () => { if (lease().pending) lease().pending.ts -= HANDOVER_WAIT_MS; };

/* ── 역할 ── */

test('역할: 예비 > 우선 표지 순으로 읽고, 둘 다 없으면 일반 — 둘 다 켜져 있으면 예비(가져가지 않는 쪽)', () => {
  assert.equal(leaseRole({}), 'normal');
  assert.equal(leaseRole({ ARGO_PREFER_LEADER: '1' }), 'preferred');
  assert.equal(leaseRole({ ARGO_STANDBY_LEADER: '1' }), 'standby');
  assert.equal(leaseRole({ ARGO_PREFER_LEADER: '1', ARGO_STANDBY_LEADER: '1' }), 'standby');
});

/* ── 예비 기기(VPS) ── */

test('예비 기기는 다른 기기(일반·우선·예비)가 잡은 새 리스에 양보한다 — 쓰기 0', async () => {
  role('standby');
  for (const doc of [fresh('mac'), fresh('srv', { preferred: true }), fresh('vps2', { standby: true })]) {
    const f = fakeClient(doc); _setSyncClientForTest(f.client); reset();
    for (let i = 0; i < 3; i++) await renewLease('owner-s1', { runnerUsable: true });
    assert.equal(lease().leader, false, `${doc.deviceId}에 양보`);
    assert.equal(f.calls.upload, 0);
  }
});

test('예비 기기는 맥을 두 대 이상 봤으면 남의 리스가 만료되고 두 주기(16초)가 더 지났을 때만 가져오고, 리스 글에 standby 표지를 남긴다 — 남은 맥이 먼저 가져가게', async () => {
  role('standby');
  const f = fakeClient({ ...fresh('mac'), ts: Date.now() - LEASE_TTL_MS - 1_000 }); // 막 만료 — 일반 기기(남은 맥)는 이 주기에 가져간다
  _setSyncClientForTest(f.client); reset();
  lease().peers = { [ACCT]: { at: Date.now(), normals: ['mac', 'mac2'] } }; // 맥 두 대를 본 적 있다
  await renewLease('owner-s2', { runnerUsable: true });
  assert.equal(f.calls.upload, 0, '만료 직후에는 기다린다(D 3차 검수: 세 기기에서 예비가 먼저 가져가 맥2가 다시 되찾음)');
  assert.equal(isCloudLeader(), false);
  f.set({ ...fresh('mac'), ts: Date.now() - LEASE_TTL_MS - 2 * 8_000 - 1_000 });
  await renewLease('owner-s2', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(isCloudLeader(), true, '가져온 예비 기기는 확인 기한 안에서 담당');
  assert.equal(f.calls.upload, 1);
  assert.equal(f.doc().standby, true);
  assert.equal(f.doc().preferred, undefined);
});

test('예비 기기가 담당일 때 갱신 간격은 일반 기기와 같다 — 30초 안에는 쓰지 않는다(DB 위생)', async () => {
  role('standby');
  const f = fakeClient(fresh(ME, { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: true, ownedAt: Date.now() - 5_000 });
  await renewLease('owner-s3', { runnerUsable: true });
  assert.equal(f.calls.upload, 0);
  assert.equal(lease().leader, true);
  reset({ leader: true, ownedAt: Date.now() - (LEASE_TTL_MS / 4 + 1_000) });
  await renewLease('owner-s3', { runnerUsable: true });
  assert.equal(f.calls.upload, 1);
  assert.equal(f.doc().standby, true, '갱신 글에도 표지가 남는다');
});

/* ── 일반 기기(맥)의 되찾기 ── */

test('맥(일반·러너 있음)은 예비 기기가 잡은 새 리스를 되찾는다 — 가져온 주기는 쓰기만 하고 담당이 아니며, 넘겨받기 대기(한 주기 + 2초) 뒤 그 글이 그대로면 담당(쓰기 합계 1)', async () => {
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-m1', { runnerUsable: true });
  assert.equal(lease().leader, false, '앞 담당(VPS)이 다음 주기에 이 글을 읽고 물러날 때까지 담당을 시작하지 않는다 — 둘이 겹치지 않게');
  assert.equal(f.calls.upload, 1);
  assert.equal(f.doc().deviceId, ME);
  assert.equal(f.doc().standby, undefined);
  elapseHandover();
  await renewLease('owner-m1', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.calls.upload, 1, '확인 주기는 쓰지 않는다');
  assert.ok(Date.now() - lease().ownedAt < 5_000, '보유 시각 = 넘겨받은 글을 쓴 시각(30초 갱신 규칙의 기준)');
});

test('넘겨받기 대기는 주기 수가 아니라 시간으로 센다 — 맥에서 대화를 보내 동기화 주기가 연달아 돌아도(nudgeSync) 대기 시간 전에는 담당이 아니고 쓰지 않는다', async () => {
  for (const [label, r, doc] of [['맥(일반) ← 예비', 'normal', fresh('vps', { standby: true })], ['우선 ← 일반', 'preferred', fresh('mac-app')]]) {
    role(r);
    const f = fakeClient(doc);
    _setSyncClientForTest(f.client); reset({ leader: false });
    for (let i = 0; i < 6; i++) await renewLease('owner-h1', { runnerUsable: true });
    assert.equal(lease().leader, false, `${label}: 앞 담당이 리스를 다시 읽을 시간(한 주기 + 2초)이 지나기 전에는 담당을 시작하지 않는다 — 둘이 함께 담당인 창`);
    assert.equal(isCloudLeader(), false, label);
    assert.equal(f.calls.upload, 1, `${label}: 기다리는 주기는 읽기만 한다(쓰기 합계 1)`);
    assert.ok(f.calls.download >= 6, label);
    elapseHandover();
    await renewLease('owner-h1', { runnerUsable: true });
    assert.equal(lease().leader, true, `${label}: 대기 시간이 지난 뒤 그 글이 그대로면 담당`);
    assert.equal(f.calls.upload, 1, label);
  }
  assert.ok(HANDOVER_WAIT_MS > 8_000, '운영 주기(8초)보다 길다');
});

test('되찾는 사이 VPS가 마침 갱신해 내 글을 덮었으면 다시 넘겨받기를 시도한다(담당 시작 안 함)', async () => {
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-m2', { runnerUsable: true });
  f.set(fresh('vps', { standby: true, token: 't-vps-renew' })); // VPS의 30초 갱신이 내 글 뒤에 도착
  await renewLease('owner-m2', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 2);
  assert.equal(f.doc().deviceId, ME);
  elapseHandover();
  await renewLease('owner-m2', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.calls.upload, 2);
});

test('맥에 러너가 없으면 예비 기기의 새 리스를 가져오지 않는다 — 그레이스가 지나도(답할 수 없는 기기가 담당을 뺏으면 안 된다)', async () => {
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-m3', { runnerUsable: false });
  Object.assign(lease(), { yieldSince: Date.now() - YIELD_GRACE_MS - 1_000 });
  f.set(fresh('vps', { standby: true }));
  await renewLease('owner-m3', { runnerUsable: false });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

test('일반 기기끼리는 종전대로 먼저 잡은 쪽을 존중한다 — 맥 두 대가 서로 뺏지 않는다', async () => {
  const f = fakeClient(fresh('macbook'));
  _setSyncClientForTest(f.client); reset({ leader: false });
  for (let i = 0; i < 3; i++) await renewLease('owner-m4', { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

/* ── 우선 기기 ── */

test('우선 기기는 예비 기기의 새 리스도 가져온다(우선 > 예비)', async () => {
  role('preferred');
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-p1', { runnerUsable: true });
  elapseHandover();
  await renewLease('owner-p1', { runnerUsable: true });
  assert.equal(lease().leader, true);
  assert.equal(f.doc().preferred, true);
  assert.equal(f.calls.upload, 1);
});

test('러너 없는 우선 기기는 그레이스(160초)가 지나도 러너 있는 일반 기기의 새 리스를 빼앗지 않는다(배포본: 그레이스 뒤 빼앗았다)', async () => {
  role('preferred');
  const f = fakeClient(fresh('mac-with-runner'));
  _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-p2', { runnerUsable: false });
  Object.assign(lease(), { yieldSince: Date.now() - YIELD_GRACE_MS - 1_000 });
  f.set(fresh('mac-with-runner'));
  await renewLease('owner-p2', { runnerUsable: false });
  assert.equal(lease().leader, false);
  assert.equal(f.calls.upload, 0);
});

/* ── 잠들었다 깬 담당 ── */

test('엄격 판정(예비·다른 기기를 본 적 있는 기기)의 담당은 마지막 확인 읽기를 보낸 뒤 확인 기한까지다 — 잠들었다 깨거나 리스 판정이 멈추면 기한이 지나 담당이 아니다', () => {
  for (const [r, peer] of [['standby', false], ['normal', true], ['preferred', true]]) {
    role(r);
    reset({ leader: true, ownedAt: Date.now() - 40_000, checkedAt: Date.now() - 2_000, token: 't', validUntil: Date.now() + 1_000, sawPeer: peer });
    assert.equal(isCloudLeader(), true, `${r}: 확인 기한 안`);
    assert.equal(isCloudLeader(Date.now() + 2_000), false, `${r}: 확인 기한이 지나면 — 깬 직후 첫 스케줄러 틱이 낡은 표시로 루틴을 다시 돌리면 안 된다`);
  }
  assert.ok(LEASE_CONFIRM_VALID_MS <= HANDOVER_WAIT_MS - 2_000, `확인 기한 ${LEASE_CONFIRM_VALID_MS}ms — 넘겨받기 대기보다 여유(업로드 지연·시계 차이)만큼 짧다`);
});

test('확인 읽기가 한 번 실패해도(그다음 판정이 응답 1초 걸려도) 보유자의 담당이 끊기지 않는다 — 8초마다 읽으니 다음 확인은 실패 뒤 8초', async () => {
  role('standby');
  const doc = fresh(ME, { standby: true });
  const f = fakeClient(doc); _setSyncClientForTest(f.client);
  held(doc, { validUntil: 0 });
  const t0 = Date.now();
  await renewLease('owner-v1', { runnerUsable: true }); // 확인(보낸 시각 t0)
  f.failReads(READ_ERRORS[0]);
  await renewLease('owner-v1', { runnerUsable: true }); // t0 + 8초 판정이 실패했다고 치면
  assert.equal(isCloudLeader(t0 + 2 * 8_000 + 1_000), true, '다음 확인(t0 + 16초, 응답 1초)이 오기 전에 담당이 꺼지면 혼자 쓰는 예비 기기도 주기마다 깜빡인다');
  assert.equal(isCloudLeader(t0 + LEASE_CONFIRM_VALID_MS + 1), false);
});

test('다른 기기를 본 적 없는 단일 기기는 배포본처럼 표시를 따른다 — 확인 기한 없이 담당, 단 내 글이 만료되기 전까지만, 잠들었다 깬 뒤 리스를 다시 확인하기 전은 아니다', async () => {
  reset({ leader: true, ownedAt: Date.now() - 100_000, checkedAt: Date.now() - 1_000 });
  assert.equal(isCloudLeader(), true, '확인 읽기가 밀려도(리스 읽기 실패) 내 글이 살아 있는 동안은 담당 — 혼자 쓰는 기기의 루틴은 멈추지 않는다');
  reset({ leader: true, ownedAt: Date.now() - LEASE_TTL_MS + 3_000, checkedAt: Date.now() - 1_000 });
  assert.equal(isCloudLeader(), false, '내 글이 곧 만료(TTL − 여유) — 갱신하지 못한 채(세션 끊김·네트워크) 계속 담당이면, 만료 뒤 서버(예비)가 가져갈 때 겹친다. 맥은 서버가 한 번 맡기 전까지 서버의 글을 본 적이 없다');
  reset({ leader: true, ownedAt: Date.now() - 40_000, checkedAt: Date.now() - 1_000 });
  Object.assign(globalThis.__argoSyncAwake, { wall: Date.now() - 60_000, mono: performance.now() - 8_000 }); // 52초 잠들었다 깸
  assert.equal(isCloudLeader(), false, '깬 직후 첫 스케줄러 틱이 낡은 표시로 루틴을 다시 돌리지 않게 — 그 사이 다른 기기가 처음으로 맡았을 수 있다');
  const f = fakeClient(fresh(ME)); _setSyncClientForTest(f.client);
  await renewLease('owner-w0', { runnerUsable: true }); // 다시 확인
  assert.equal(isCloudLeader(), true);
});

test('기동 직후 기본값 — 다른 기기를 본 적 없는 단일 기기는 첫 리스 판정 전(최대 5초)·읽기 오류로 끝난 판정 뒤에는 담당이 아니고 다시 읽어 확인되면 담당, 본 적 있는 일반·우선 기기는 확인 전까지(세션이 끊겨 30초가 지나도) 담당이 아니다', async () => {
  for (const r of ['normal', 'preferred']) {
    role(r);
    reset(); globalThis.__argoSyncLeaseBootAt = Date.now(); // 막 켜짐
    assert.equal(isCloudLeader(), false, `${r} 단일 기기: 첫 리스 판정 전 — 그 판정이 다른 기기의 리스를 보면 겹치지 않게(D 1차 검수)`);
    assert.equal(isCloudLeader(Date.now() + 5_000), true, `${r} 단일 기기: 판정이 걸려도 5초 뒤에는 배포본처럼 담당`);
    const f = fakeClient(null); _setSyncClientForTest(f.client);
    f.failReads(READ_ERRORS[2]);
    await renewLease('owner-b1', { runnerUsable: true }); // 첫 판정이 읽기 오류로 끝남
    assert.equal(isCloudLeader(), false, `${r} 단일 기기: 리스를 읽지 못한 채 기동 기본값으로 담당이 아니다 — 처음 만나는 맥이 VPS와 겹치던 것(D 4차 검수 MEDIUM-A). 세션 실패만 배포본처럼 담당(e2e)`);
    assert.equal(f.calls.upload, 0);
    await renewLease('owner-b1', { runnerUsable: true }); // 다시 읽기(리스 타이머가 1초 뒤 한 번) — 성공하면 바로 가져온다
    assert.equal(isCloudLeader(), true, r);
    reset({ sawPeer: true });
    assert.equal(isCloudLeader(), false, `${r}: 다른 기기를 본 적 있으면 확인 전에는 담당이 아니다 — 맥 앱이 켜지는 순간 VPS와 겹치던 창`);
    assert.equal(isCloudLeader(Date.now() + 31_000), false, `${r}: 세션이 끊겨 리스를 못 읽어도 30초 기본값으로 담당이 되지 않는다(D 3차 검수 MEDIUM-3: VPS와 40초 겹침)`);
    assert.equal(isCloudLeader(Date.now() + 10 * 60_000), false, r);
  }
});

const PEER_FILE = join(process.env.ARGO_ROOT, '.lease-peer.json');
const readPeerFile = async () => { for (let i = 0; i < 50; i++) { try { return JSON.parse(readFileSync(PEER_FILE, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 10)); } } return null; };
test('다른 기기의 리스 글을 보면 데이터 폴더에 계정별 표지를 남긴다 — 다시 켜진 뒤(세션이 끊겨 리스를 못 읽어도) 엄격 판정을 쓰는 근거', async () => {
  rmSync(PEER_FILE, { force: true });
  const f = fakeClient(fresh('mac-a')); _setSyncClientForTest(f.client); reset();
  await renewLease('owner-k1', { runnerUsable: true });
  assert.ok(lease().peers[ACCT]?.at > Date.now() - 5_000);
  const saved = await readPeerFile();
  assert.equal(saved?.v, 2, '기기 로컬 표지 파일');
  assert.deepEqual(saved.accounts[ACCT].normals, ['mac-a'], '본 적 있는 일반 기기');
});

test('표지는 볼 때마다 메모리의 시각만 고치고 파일은 하루에 한 번(또는 처음 보는 일반 기기)만 쓴다 — 리스 판정(8초)마다 쓰지 않게', async () => {
  rmSync(PEER_FILE, { force: true });
  const f = fakeClient(fresh('mac-a')); _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-k2', { runnerUsable: true });
  const first = (await readPeerFile()).accounts[ACCT].at;
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 3; i++) await renewLease('owner-k2', { runnerUsable: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await readPeerFile()).accounts[ACCT].at, first, '같은 날 다시 본 것은 쓰지 않는다');
  assert.ok(lease().peers[ACCT].at > first, '메모리 시각은 고친다(14일 판정)');
  lease().peersSavedAt[ACCT] -= 25 * 3_600_000; // 마지막으로 쓴 지 하루가 넘었다
  await renewLease('owner-k2', { runnerUsable: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await readPeerFile()).accounts[ACCT].at > first, '하루가 지나면 고쳐 쓴다');
  f.set(fresh('mac-b')); await renewLease('owner-k2', { runnerUsable: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await readPeerFile()).accounts[ACCT].normals, ['mac-a', 'mac-b'], '처음 보는 일반 기기는 바로 쓴다');
});

test('표지는 최근 14일 안에 이 계정이 다른 기기를 봤을 때만 엄격 판정을 쓴다 — 두 번째 기기를 없앴거나 다른 계정으로 로그인했으면 단일 기기(배포본처럼 담당)', () => {
  reset({ checkedAt: Date.now() });
  lease().peers = { [ACCT]: { at: Date.now() - 13 * 86_400_000, normals: ['vps'] } };
  assert.equal(isCloudLeader(), false, '13일 전에 본 기기 — 엄격 판정(확인 전 담당 아님)');
  lease().peers = { [ACCT]: { at: Date.now() - 15 * 86_400_000, normals: ['vps'] } };
  assert.equal(isCloudLeader(), true, '15일 동안 다른 기기를 못 봤다 — 단일 기기로 돌아간다(세션이 끊겨도 아무도 실행하지 않는 일이 없게, D 4차 검수 MEDIUM-B)');
  lease().peers = { 'someone-else': { at: Date.now(), normals: ['vps'] } };
  assert.equal(isCloudLeader(), true, '다른 계정이 본 기기는 이 계정과 무관하다');
});

test('예비 기기는 기동 직후 기본값으로 담당이 되지 않는다 — 리스를 확인하지 못한 채(세션 만료 등) 30초가 지나도. 확인된 신선한 보유일 때만 담당이고, 메신저 판정(standbyIdle)과 늘 같다', () => {
  role('standby');
  reset();
  assert.equal(isCloudLeader(), false);
  assert.equal(isCloudLeader(Date.now() + 31_000), false, '맥이 담당인지 알 수 없는 예비 기기가 30초 뒤 맡으면 맥과 같은 루틴을 함께 돌린다(D 1차 검수 실측)');
  assert.equal(isCloudLeader(Date.now() + 10 * 60_000), false);
  reset({ leader: true, ownedAt: 0, checkedAt: Date.now() });
  assert.equal(isCloudLeader(), false, '리스를 읽었어도 가져오지 않았으면(확인 기한 없음) 담당이 아니다');
  reset({ leader: true, ownedAt: Date.now() - 5_000, checkedAt: Date.now(), token: 't', validUntil: Date.now() + 10_000 });
  assert.equal(isCloudLeader(), true, '리스를 가져와 확인한 예비 기기는 담당');
  const states = [{}, { leader: false, checkedAt: Date.now() }, { leader: true, ownedAt: 0, checkedAt: Date.now() }, { leader: true, ownedAt: Date.now() - 5_000, token: 't', validUntil: Date.now() + 10_000 },
    { leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1, checkedAt: Date.now() - LEASE_TTL_MS - 1, token: 't', validUntil: Date.now() - 1 }];
  for (const st of states) for (const dt of [0, 31_000]) {
    reset(st);
    assert.equal(standbyIdle(Date.now() + dt), !isCloudLeader(Date.now() + dt), `예비 기기의 스케줄러·감시(isCloudLeader)와 메신저(standbyIdle) 판정이 갈리면 안 된다 ${JSON.stringify(st)} +${dt}`);
  }
  role('normal'); reset();
  assert.equal(isCloudLeader(Date.now() + 31_000), true, '다른 기기를 본 적 없는 일반 기기는 배포본처럼 담당(동기화가 안 되는 단일 기기의 루틴이 멈추지 않게) — 핀');
});

test('깬 맥이 다음 주기에 리스를 다시 확인하면 — VPS가 가져갔으면 넘겨받기, 아무도 안 가져갔으면 바로 담당', async () => {
  const f = fakeClient(fresh('vps', { standby: true }));
  _setSyncClientForTest(f.client); reset({ leader: true, ownedAt: Date.now() - 10 * 60_000, checkedAt: Date.now() - 10 * 60_000 });
  await renewLease('owner-w1', { runnerUsable: true });
  assert.equal(isCloudLeader(), false);
  elapseHandover();
  await renewLease('owner-w1', { runnerUsable: true });
  assert.equal(isCloudLeader(), true);
  const g = fakeClient({ ...fresh(ME), ts: Date.now() - 10 * 60_000 });
  _setSyncClientForTest(g.client); reset({ leader: true, ownedAt: Date.now() - 10 * 60_000, checkedAt: Date.now() - 10 * 60_000 });
  await renewLease('owner-w2', { runnerUsable: true });
  assert.equal(isCloudLeader(), true);
  assert.equal(g.calls.upload, 1);
});

/* ── 예비 기기의 메신저 ── */

test('standbyIdle — 예비 기기이고 확인된 담당이 아닐 때만 참(그때 팀 메신저를 받지 않는다). 일반·우선 기기는 늘 거짓(종전대로 메신저를 받는다)', () => {
  role('standby');
  reset(); assert.equal(standbyIdle(), true, '기동 직후 기본값(리스 확인 전)은 담당으로 치지 않는다 — 맥이 담당인데 VPS가 켜지자마자 메신저를 받으면 겹친다');
  reset({ leader: false, checkedAt: Date.now() }); assert.equal(standbyIdle(), true);
  reset({ leader: true, ownedAt: Date.now() - 10_000, checkedAt: Date.now(), token: 't', validUntil: Date.now() + 10_000 }); assert.equal(standbyIdle(), false);
  reset({ leader: true, ownedAt: Date.now() - 20_000, checkedAt: Date.now() - 20_000, token: 't', validUntil: Date.now() - 1 }); assert.equal(standbyIdle(), true, '확인 기한이 지난 예비 기기');
  role('normal'); reset({ leader: false, checkedAt: Date.now() }); assert.equal(standbyIdle(), false);
  role('preferred'); reset({ leader: false, checkedAt: Date.now() }); assert.equal(standbyIdle(), false);
});

/* ── 리스 읽기 오류 (D 2차 검수 MEDIUM-1) ──
   supabase-js download는 오류를 던지지 않고 { data: null, error }로 돌려준다. error를 보지 않으면 읽기가 한 번 실패할 때 '리스 없음'으로 읽고 써서,
   예비 VPS가 맥 담당 중에 가져가 겹치고(실측 4.8초), 되찾는 맥은 넘겨받기 대기 없이 담당이 됐다. 없음은 storage-api 'Object not found' 하나뿐이다(isNotFound). */

test('리스를 읽지 못하면(5xx·fetch failed·만료 토큰의 Bucket not found·응답 중단) 없음으로 보지 않는다 — 예비 VPS는 맥 담당 중에 가져가지 않는다(쓰기 0·담당 아님)', async () => {
  for (const err of READ_ERRORS) {
    role('standby');
    const f = fakeClient(fresh('mac')); _setSyncClientForTest(f.client); reset();
    f.failReads(err);
    await renewLease('owner-e1', { runnerUsable: true });
    assert.equal(f.calls.upload, 0, `${err.message ?? err.throw?.message}: 읽기 오류로 맥의 살아 있는 리스를 덮어썼다`);
    assert.equal(isCloudLeader(), false, err.message ?? err.throw?.message);
    assert.equal(standbyIdle(), true);
    await renewLease('owner-e1', { runnerUsable: true }); // 다음 읽기는 성공 — 맥의 새 리스를 보고 양보
    assert.equal(f.calls.upload, 0);
    assert.equal(f.doc().deviceId, 'mac');
  }
});

test('되찾는 맥은 리스를 읽지 못한 주기에 가져가지도 담당을 시작하지도 않는다 — 넘겨받기 대기를 건너뛰지 않는다(쓰기는 읽기가 성공한 뒤 1번)', async () => {
  for (const err of READ_ERRORS) {
    const label = err.message ?? err.throw?.message;
    const f = fakeClient(fresh('vps', { standby: true })); _setSyncClientForTest(f.client); reset({ leader: false });
    f.failReads(err);
    await renewLease('owner-e2', { runnerUsable: true });
    assert.equal(f.calls.upload, 0, `${label}: 읽지 못한 주기에 썼다`);
    assert.equal(isCloudLeader(), false, label);
    await renewLease('owner-e2', { runnerUsable: true }); // 읽기 성공 → 넘겨받기 시작(쓰기 1, 아직 담당 아님)
    assert.equal(f.calls.upload, 1, label);
    assert.equal(isCloudLeader(), false, label);
    elapseHandover();
    f.failReads(err); // 대기가 끝난 뒤 확인 읽기를 못 하면 — 앞 담당이 물러났는지 모르니 시작하지 않는다
    await renewLease('owner-e2', { runnerUsable: true });
    assert.equal(isCloudLeader(), false, `${label}: 확인 읽기 없이 담당을 시작했다`);
    assert.equal(f.calls.upload, 1, label);
    await renewLease('owner-e2', { runnerUsable: true });
    assert.equal(isCloudLeader(), true, label);
    assert.equal(f.calls.upload, 1, `${label}: 넘겨받는 데 쓰기 1번`);
  }
});

test('일반·우선 기기도 읽기 오류 주기에는 쓰지 않는다 — 빈 리스여도 가져가지 않고(다음 주기에 가져감), 남의 리스도 빼앗지 않는다. 담당 표시는 보유자(내 글 만료 전)만 그대로 — 단일 기기도 보유자가 아니면 아님(D 4차 검수 MEDIUM-A)', async () => {
  for (const r of ['normal', 'preferred']) {
    role(r);
    const solo = fakeClient(null); _setSyncClientForTest(solo.client); reset();
    solo.failReads(READ_ERRORS[0]);
    await renewLease('owner-e3', { runnerUsable: true });
    assert.equal(solo.calls.upload, 0, `${r} 단일 기기: 읽기 오류 주기`);
    assert.equal(isCloudLeader(), false, `${r} 단일 기기도 읽기 오류면 기동 기본값으로 담당이 아니다(D 4차 검수 MEDIUM-A — 처음 만나는 기기와 겹치지 않게). 리스 타이머가 1초 뒤 다시 읽는다`);
    const owned = fresh(ME); const g0 = fakeClient(owned); _setSyncClientForTest(g0.client);
    reset({ leader: true, ownedAt: Date.now() - 40_000, checkedAt: Date.now() });
    g0.failReads(READ_ERRORS[0]);
    await renewLease('owner-e3', { runnerUsable: true });
    assert.equal(isCloudLeader(), true, `${r} 단일 기기 보유자는 읽기 오류에도 내 글 만료 전까지 담당(쓰기 0)`);
    assert.equal(g0.calls.upload, 0);
    const f = fakeClient(null); _setSyncClientForTest(f.client); reset({ sawPeer: true });
    f.failReads(READ_ERRORS[0]);
    await renewLease('owner-e3', { runnerUsable: true });
    assert.equal(f.calls.upload, 0, `${r}: 읽기 오류 주기`);
    assert.equal(isCloudLeader(), false, r);
    await renewLease('owner-e3', { runnerUsable: true });
    assert.equal(f.calls.upload, 1, `${r}: 읽기가 되면 빈 리스를 가져온다`);
    assert.equal(isCloudLeader(), true, r);
    const g = fakeClient(fresh('other-mac')); _setSyncClientForTest(g.client); reset();
    g.failReads(READ_ERRORS[2]); // 단일 기기(본 적 없음)도 남의 리스를 읽지 못한 채 덮어쓰지 않는다 — 배포본은 덮어썼다
    await renewLease('owner-e3', { runnerUsable: true });
    assert.equal(g.calls.upload, 0, `${r}: 남의 리스를 읽지 못한 채 덮어썼다`);
    assert.equal(g.doc().deviceId, 'other-mac');
  }
});

test('보유자가 리스를 읽지 못하면 쓰지 않는다 — 엄격 판정은 마지막 확인 기한까지만 담당(그 뒤 스스로 물러남, 넘겨받는 쪽이 대기를 마치기 전에), 단일 기기는 배포본처럼 표시 그대로', async () => {
  for (const [r, peer] of [['standby', false], ['normal', true], ['preferred', true]]) {
    role(r);
    const doc = fresh(ME);
    const f = fakeClient(doc); _setSyncClientForTest(f.client);
    held(doc, { ownedAt: Date.now() - 40_000, validUntil: Date.now() + 5_000, sawPeer: peer }); // 30초 갱신 차례
    f.failReads(READ_ERRORS[0]);
    await renewLease('owner-e4', { runnerUsable: true });
    assert.equal(f.calls.upload, 0, `${r}: 읽지 못한 채 갱신 쓰기 — 그 사이 맥이 쓴 넘겨받기 글을 덮을 수 있다`);
    assert.equal(isCloudLeader(), true, `${r}: 확인 기한 안이면 한 번 오류로 담당을 놓지 않는다`);
    assert.equal(isCloudLeader(Date.now() + 6_000), false, `${r}: 읽기가 이어서 실패해 확인 기한이 지나면 스스로 물러난다(D 3차 검수: 읽기 60초 실패 겹침 39초)`);
    held(doc, { ownedAt: Date.now() - LEASE_TTL_MS - 1_000, validUntil: Date.now() + 5_000, sawPeer: peer });
    f.failReads(READ_ERRORS[2]);
    await renewLease('owner-e4', { runnerUsable: true });
    assert.equal(isCloudLeader(), false, `${r}: 마지막 쓰기가 TTL을 넘었으면 담당이 아니다`);
    assert.equal(f.calls.upload, 0, r);
  }
  role('normal');
  const doc = fresh(ME);
  const f = fakeClient(doc); _setSyncClientForTest(f.client);
  held(doc, { ownedAt: Date.now() - 40_000, validUntil: 0 });
  f.failReads(READ_ERRORS[0], READ_ERRORS[2]);
  await renewLease('owner-e4', { runnerUsable: true }); await renewLease('owner-e4', { runnerUsable: true });
  assert.equal(f.calls.upload, 0);
  assert.equal(isCloudLeader(), true, '다른 기기를 본 적 없는 단일 기기 — 배포본처럼 담당 표시 그대로(혼자라 겹칠 기기가 없다)');
});

test('확인 기한은 읽기를 보낸 시각부터 센다 — 응답이 늦게 와도 기한이 늘지 않고, 내 글의 만료(ts + TTL)를 넘지 않는다', async () => {
  role('standby');
  const doc = fresh(ME, { standby: true });
  const f = fakeClient(doc); _setSyncClientForTest(f.client);
  held(doc, { validUntil: 0 });
  f.slow(400);
  const before = Date.now();
  await renewLease('owner-c2', { runnerUsable: true });
  assert.ok(lease().validUntil <= before + LEASE_CONFIRM_VALID_MS + 50, `응답 시각으로 세면 400ms 늘어난다 — ${lease().validUntil - before}`);
  assert.ok(lease().validUntil >= before + LEASE_CONFIRM_VALID_MS - 50);
  const old = { ...fresh(ME, { standby: true }), ts: Date.now() - LEASE_TTL_MS + 10_000 }; // 10초 뒤 만료되는 내 글(쓰기가 계속 실패한 보유자)
  const g = fakeClient(old); _setSyncClientForTest(g.client);
  held(old, { ownedAt: Date.now() - 5_000, validUntil: 0 });
  await renewLease('owner-c2', { runnerUsable: true }); // 읽기 성공 — 내 글(만료 10초 전)을 확인
  assert.ok(lease().validUntil <= old.ts + LEASE_TTL_MS, '내 글이 만료되면 다른 기기가 가져간다 — 그 뒤까지 담당이면 겹친다');
});

test('넘겨받기 확인은 내가 쓴 글(토큰)일 때만이다 — 같은 기기 id라도 다른 토큰(재시작 경쟁의 다른 프로세스)이면 넘겨받은 것으로 치지 않고 획득을 다시 거쳐 내 글을 쓴다', async () => {
  const f = fakeClient(fresh('vps', { standby: true })); _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-t1', { runnerUsable: true });
  assert.equal(f.calls.upload, 1);
  f.set({ ...fresh(ME), token: 'other-process-same-device' });
  elapseHandover();
  await renewLease('owner-t1', { runnerUsable: true });
  assert.equal(f.calls.upload, 2, '남의 토큰을 내 넘겨받기로 쳤다');
  assert.equal(f.doc().token, lease().token, '담당은 내 토큰의 글로');
  assert.equal(isCloudLeader(), true);
});

test('자가 복구 쓰기는 TTL에 한 번만이고, 쓴 뒤 재확인 읽기도 실패하면 읽기가 돌아올 때까지 다시 쓰지 않는다 — GET만 실패하는 기기가 매 주기 정상 기기의 리스를 덮지 않게', async () => {
  const f = fakeClient(fresh('mac-ok')); _setSyncClientForTest(f.client); reset({ leader: false });
  lease().readFailSince = Date.now() - LEASE_TTL_MS - 1_000;
  f.failReads(READ_ERRORS[0], READ_ERRORS[0]); // 자가 복구 읽기 실패 + 쓴 뒤 재확인 읽기도 실패
  await renewLease('owner-x1', { runnerUsable: true });
  assert.equal(f.calls.upload, 1, '한 번은 써 본다(깨진 객체 자가 복구)');
  assert.equal(isCloudLeader(), false);
  for (let i = 0; i < 4; i++) { f.failReads(READ_ERRORS[0]); await renewLease('owner-x1', { runnerUsable: true }); }
  assert.equal(f.calls.upload, 1, '재확인도 실패했으니 다시 쓰지 않는다(D 3차 검수: 분당 7.2번)');
  lease().escapeAt = Date.now() - LEASE_TTL_MS - 1; // TTL이 지나도
  f.failReads(READ_ERRORS[0]); await renewLease('owner-x1', { runnerUsable: true });
  assert.equal(f.calls.upload, 1, '읽기가 돌아오기 전에는 막혀 있다');
  const g = fakeClient(fresh('mac-ok')); _setSyncClientForTest(g.client); reset({ leader: false });
  lease().readFailSince = Date.now() - LEASE_TTL_MS - 1_000;
  g.failReads(READ_ERRORS[0]); // 자가 복구 — 재확인은 성공
  await renewLease('owner-x2', { runnerUsable: true });
  assert.equal(g.calls.upload, 1);
  for (let i = 0; i < 4; i++) { g.failReads(READ_ERRORS[0]); await renewLease('owner-x2', { runnerUsable: true }); }
  assert.equal(g.calls.upload, 1, 'TTL에 한 번 — 다음 자가 복구는 120초 뒤');
});

test('리스를 TTL(120초) 넘게 한 번도 읽지 못하면 종전처럼 없음으로 보고 갱신을 시도한다 — 읽을 수 없는 리스 객체가 모든 기기의 담당을 영영 막지 않게', async () => {
  const f = fakeClient(fresh('mac-x')); _setSyncClientForTest(f.client); reset({ leader: false });
  f.failReads(READ_ERRORS[0]);
  await renewLease('owner-e5', { runnerUsable: true });
  assert.equal(f.calls.upload, 0, '첫 실패는 건너뛴다');
  lease().readFailSince = Date.now() - LEASE_TTL_MS - 1_000; // 실패가 TTL 넘게 이어졌다
  f.failReads(READ_ERRORS[0]);
  await renewLease('owner-e5', { runnerUsable: true });
  assert.equal(f.calls.upload, 1, '배포본처럼 써서 객체를 새로 만든다(자가 복구)');
  await renewLease('owner-e5', { runnerUsable: true }); // 읽기가 돌아오면 실패 시각을 지운다
  assert.equal(lease().readFailSince, 0);
});

test('앞 담당은 리스를 CDN 옛 사본이 아니라 원본으로 읽는다 — 옛 사본(자기 글)을 읽으면 맥의 넘겨받기 글을 못 보고 계속 담당이다', async () => {
  role('standby');
  const mine = fresh(ME, { standby: true });
  const f = fakeClient(mine); _setSyncClientForTest(f.client);
  held(mine, { validUntil: Date.now() + 1_000 }); // 확인된 보유자(곧 확인 기한) — 옛 사본(내 글)을 읽으면 기한이 다시 늘어난다
  f.staleCdn(mine); // Storage 인증 다운로드도 Cloudflare에 캐시된다(10/5 edge_logs: 리스 첫 읽기 HIT)
  f.set(fresh('mac')); // 맥이 넘겨받기 글을 썼다(원본)
  await renewLease('owner-c1', { runnerUsable: true });
  assert.equal(isCloudLeader(), false, 'CDN 사본을 읽고 계속 담당 — 맥이 대기 뒤 시작하면 둘이 겹친다');
  assert.equal(isCloudLeader(Date.now() + 5_000), false);
  assert.equal(f.calls.upload, 0);
});

/* ── 넘겨받기 대기 길이 (D 2차 검수 LOW) ── */

test('넘겨받기 대기는 앞 담당이 리스를 두 번 읽을 시간이다(2 × 주기 + 4초) — 한 주기 + 2초가 지난 것만으로는 담당을 시작하지 않는다(앞 담당 읽기 간격 실측 8.1~10.2초)', async () => {
  const f = fakeClient(fresh('vps', { standby: true })); _setSyncClientForTest(f.client); reset({ leader: false });
  await renewLease('owner-h2', { runnerUsable: true });
  assert.equal(f.calls.upload, 1);
  lease().pending.ts -= 8_000 + 2_000 + 500; // 옛 대기(한 주기 + 2초)를 넘김
  await renewLease('owner-h2', { runnerUsable: true });
  assert.equal(isCloudLeader(), false, '앞 담당의 읽기 한 번이 늦으면(10.2초) 겹친다');
  lease().pending.ts -= HANDOVER_WAIT_MS;
  await renewLease('owner-h2', { runnerUsable: true });
  assert.equal(isCloudLeader(), true);
  assert.equal(f.calls.upload, 1);
});

/* ── 깨어 있은 시간 (D 2차 검수 MEDIUM-2) ──
   맥이 잠깐 깼다(DarkWake 1~17초·뚜껑 잠깐 열기) 다시 잠들면, 깬 주기에 가져간 리스 때문에 VPS는 물러나고 맥은 담당을 시작하지 못한 채 잠들어
   맥의 글이 만료되는 120초 동안 아무도 맡지 않았다. 더 높은 역할의 기기는 끊김 없이 깨어 있은 지 AWAKE_MIN_MS가 지나야 남의 새 리스를 가져온다. */

test('맥은 끊김 없이 깨어 있은 지 30초가 지나야 예비 기기의 새 리스를 가져온다 — 그 전에는 읽기만(쓰기 0), VPS가 계속 맡는다. 우선 기기도 같다', async () => {
  for (const [r, doc] of [['normal', fresh('vps', { standby: true })], ['preferred', fresh('mac-app')]]) {
    role(r);
    const f = fakeClient(doc); _setSyncClientForTest(f.client); reset({ leader: false });
    awakeFor(6_000); // 깬 지 6초(또는 막 켜짐)
    for (let i = 0; i < 3; i++) await renewLease('owner-a1', { runnerUsable: true });
    assert.equal(f.calls.upload, 0, `${r}: 깬 지 6초에 남의 담당을 가져갔다 — 곧 다시 잠들면 2분 공백`);
    assert.equal(isCloudLeader(), false, r);
    awakeFor(AWAKE_MIN_MS + 1_000);
    await renewLease('owner-a1', { runnerUsable: true });
    assert.equal(f.calls.upload, 1, `${r}: 30초 넘게 깨어 있으면 넘겨받기를 시작한다`);
  }
  assert.equal(AWAKE_MIN_MS, 30_000);
});

test('만료된 리스는 깨어 있은 시간과 무관하게 바로 가져온다 — 아무도 맡지 않은 리스를 기다리면 공백만 늘어난다', async () => {
  const f = fakeClient({ ...fresh('vps', { standby: true }), ts: Date.now() - LEASE_TTL_MS - 1_000 }); _setSyncClientForTest(f.client); reset();
  awakeFor(1_000);
  await renewLease('owner-a2', { runnerUsable: true });
  assert.equal(f.calls.upload, 1);
  assert.equal(isCloudLeader(), true);
});

test('잠들었다 깬 것을 알아채 깨어 있은 시간을 다시 센다 — 벽시계가 단조 시계보다 크게 앞섰거나(시스템 잠자기) 관찰 사이가 크게 벌어졌으면(SIGSTOP·일시 정지)', async () => {
  // [이름, 마지막 관찰 뒤 벽시계 경과, 단조 시계 경과, 가져오는가] — 앞의 둘은 두 감지(시계 차이·관찰 간격)를 하나씩만 건드린다(변이로 각각 확인)
  const cases = [['시스템 잠자기 7초(관찰 간격 9초 — 간격 기준 10초 미만, 단조 시계는 2초만 감)', 9_000, 2_000, false],
    ['프로세스 정지 30초(SIGSTOP — 단조 시계도 흐름)', 30_000, 30_000, false], ['정상(2초 간격 관찰)', 2_000, 2_000, true]];
  for (const [label, wallAgo, monoAgo, takes] of cases) {
    const f = fakeClient(fresh('vps', { standby: true })); _setSyncClientForTest(f.client); reset({ leader: false });
    Object.assign(globalThis.__argoSyncAwake, { wall: Date.now() - wallAgo, mono: performance.now() - monoAgo }); // 마지막 관찰 시각
    await renewLease('owner-a3', { runnerUsable: true });
    assert.equal(f.calls.upload, takes ? 1 : 0, label);
    if (!takes) assert.ok(Date.now() - globalThis.__argoSyncAwake.since < 5_000, `${label}: 깨어 있은 시간을 깬 순간부터 다시 센다`);
  }
});

/* ── 예비 기기 + 동기화 꺼짐 (D 2차 검수 LOW-①) ── */

test('예비 기기는 동기화가 꺼져 있으면(기기 세션 없음·ARGO_SYNC=0) 담당이 아니다 — 맥이 담당인지 알 수 없다(③과 같은 원칙). 일반·우선 기기는 종전대로 단일 기기로 담당', () => {
  const sync = process.env.ARGO_SYNC;
  process.env.ARGO_SYNC = '0';
  try {
    role('standby'); reset();
    assert.equal(isCloudLeader(), false);
    assert.equal(isCloudLeader(Date.now() + 10 * 60_000), false);
    assert.equal(standbyIdle(), true, '메신저 판정도 같다');
    for (const r of ['normal', 'preferred']) {
      role(r); reset({ leader: false });
      assert.equal(isCloudLeader(), true, `${r}: 동기화 off = 단일 기기 — 핀`);
      assert.equal(standbyIdle(), false, r);
    }
  } finally { process.env.ARGO_SYNC = sync; }
});


/* ── D 4차 검수 ── */

test('넘겨받기 대기는 내 쓰기의 응답을 받은 시각부터 센다 — 쓰기가 늦게 닿아도 대기가 줄지 않게(D 4차 검수 LOW-C: 14초 늦게 닿자 겹침 6.6~6.9초)', async () => {
  const f = fakeClient(fresh('vps', { standby: true })); _setSyncClientForTest(f.client); reset({ leader: false });
  f.slowUpload(400);
  const before = Date.now();
  await renewLease('owner-p3', { runnerUsable: true });
  assert.ok(lease().pending, '넘겨받는 중');
  assert.ok(lease().pending.ts >= before + 400, `대기 기준이 쓰기 응답 시각이 아니다 — ${lease().pending.ts - before}ms`);
  assert.ok(f.doc().ts < before + 50, '리스 글의 ts는 그대로 쓰기 전 시각(남이 보는 만료 기준)');
});

test('예비 기기는 일반 기기를 한 대만 봤으면 만료 뒤 기다리지 않고, 두 대 이상 봤으면 두 주기 기다린다 — 흔한 맥 → VPS 넘어가기를 늦추지 않게(D 4차 검수 LOW-D)', async () => {
  role('standby');
  const expired = { ...fresh('mac'), ts: Date.now() - LEASE_TTL_MS - 1_000 };
  const f = fakeClient(expired); _setSyncClientForTest(f.client); reset();
  lease().peers = { [ACCT]: { at: Date.now(), normals: ['mac'] } };
  await renewLease('owner-d1', { runnerUsable: true });
  assert.equal(f.calls.upload, 1, '맥 한 대 — 만료되면 바로 맡는다');
  const g = fakeClient(expired); _setSyncClientForTest(g.client); reset();
  lease().peers = { [ACCT]: { at: Date.now(), normals: ['mac', 'mac2'] } };
  await renewLease('owner-d1', { runnerUsable: true });
  assert.equal(g.calls.upload, 0, '맥 두 대 — 남은 맥이 먼저 가져가게 기다린다');
});
