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
const { renewLease, isCloudLeader, standbyIdle, _setSyncClientForTest, LEASE_TTL_MS, YIELD_GRACE_MS, HANDOVER_WAIT_MS, AWAKE_MIN_MS = 30_000 } = await import('../src/sync.mjs');
const { leaseRole } = await import('../src/lease-role.mjs');
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();

/** 가짜 저장소. failReads(...errs) = 다음 리스 읽기들이 차례대로 돌려줄 오류(supabase-js download는 오류를 던지지 않고 { data: null, error }로 준다 —
    { throw }를 주면 그 읽기가 던진다: 응답 본문 중단 등). staleCdn(doc) = CDN이 들고 있는 옛 사본 — cacheNonce·?t= 없는 읽기는 이걸 받는다. */
const fakeClient = (initialDoc = null) => {
  const calls = { upload: 0, download: 0 };
  let stored = initialDoc ? Buffer.from(JSON.stringify(initialDoc)) : null;
  let cdn = null;
  const failNext = [];
  const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
  const bucket = {
    async download(key, opts) {
      calls.download += 1;
      const f = failNext.shift();
      if (f?.throw) throw f.throw;
      if (f) return { data: null, error: f };
      const busted = opts?.cacheNonce != null || String(key).includes('?t=');
      if (cdn && !busted) return body(cdn);
      if (!stored) return { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } };
      return body(stored);
    },
    async upload(_key, blob) { calls.upload += 1; stored = Buffer.from(await blob.arrayBuffer()); return { data: {}, error: null }; },
  };
  return {
    client: { storage: { from: () => bucket } }, calls,
    doc: () => (stored ? JSON.parse(stored.toString()) : null),
    set: (doc) => { stored = Buffer.from(JSON.stringify(doc)); }, // 다른 기기의 쓰기
    failReads: (...errs) => { failNext.push(...errs); },
    staleCdn: (doc) => { cdn = Buffer.from(JSON.stringify(doc)); },
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
/** 이 프로세스가 ms 전부터 끊김 없이 깨어 있던 것으로(되찾기 조건 AWAKE_MIN_MS). 관찰 시각도 지금으로 맞춰 '잠들었다 깸'으로 읽히지 않게 한다. */
const awakeFor = (ms) => Object.assign((globalThis.__argoSyncAwake ??= {}), { since: Date.now() - ms, wall: Date.now(), mono: performance.now() });
const reset = (patch = {}) => { awakeFor(10 * 60_000); return Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0, pending: null, readFailSince: 0 }, patch); };
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

test('예비 기기는 리스가 만료됐을 때만 가져오고, 리스 글에 standby 표지를 남긴다', async () => {
  role('standby');
  const f = fakeClient({ ...fresh('mac'), ts: Date.now() - LEASE_TTL_MS - 1_000 });
  _setSyncClientForTest(f.client); reset();
  await renewLease('owner-s2', { runnerUsable: true });
  assert.equal(lease().leader, true);
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

test('담당이던 기기가 리스 TTL보다 오래 리스를 다시 쓰지 못했으면(잠자기·멈춘 동기화) 다시 확인하기 전까지 담당이 아니다', () => {
  reset({ leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1_000, checkedAt: Date.now() - LEASE_TTL_MS - 1_000 });
  assert.equal(isCloudLeader(), false, '깬 직후 첫 스케줄러 틱이 낡은 표시로 루틴을 다시 돌리면 안 된다 — 그 사이 다른 기기가 돌렸을 수 있다');
  reset({ leader: true, ownedAt: Date.now() - 40_000, checkedAt: Date.now() - 2_000 });
  assert.equal(isCloudLeader(), true, '정상 보유자(30초마다 갱신)는 그대로');
});

test('기동 직후(리스 확인 전 기본값)는 첫 확인까지 담당이 아니다 — 다른 기기가 담당인데 맥 앱이 켜진 몇 초 동안 둘이 함께 담당이던 창. 30초 안에 확인하지 못하면 종전대로 담당', () => {
  reset();
  assert.equal(isCloudLeader(), false, '첫 리스 확인 전');
  assert.equal(isCloudLeader(Date.now() + 31_000), true, '30초 안에 리스까지 못 가면(세션 만료 등) 종전대로 담당 — 단일 기기 루틴이 멈추지 않게');
  reset({ leader: true, ownedAt: 0, checkedAt: Date.now() });
  assert.equal(isCloudLeader(), true, '리스를 확인했는데 기본값이 남은 경우(로컬 회사 0개 등)');
});

test('예비 기기는 기동 직후 기본값으로 담당이 되지 않는다 — 리스를 확인하지 못한 채(세션 만료 등) 30초가 지나도. 확인된 신선한 보유일 때만 담당이고, 메신저 판정(standbyIdle)과 늘 같다', () => {
  role('standby');
  reset();
  assert.equal(isCloudLeader(), false);
  assert.equal(isCloudLeader(Date.now() + 31_000), false, '맥이 담당인지 알 수 없는 예비 기기가 30초 뒤 맡으면 맥과 같은 루틴을 함께 돌린다(D 1차 검수 실측)');
  assert.equal(isCloudLeader(Date.now() + 10 * 60_000), false);
  reset({ leader: true, ownedAt: 0, checkedAt: Date.now() });
  assert.equal(isCloudLeader(), false, '리스를 읽었어도 가져오지 않았으면(ownedAt 0) 담당이 아니다');
  reset({ leader: true, ownedAt: Date.now() - 5_000, checkedAt: Date.now() });
  assert.equal(isCloudLeader(), true, '리스를 가져온 예비 기기는 담당');
  const states = [{}, { leader: false, checkedAt: Date.now() }, { leader: true, ownedAt: 0, checkedAt: Date.now() }, { leader: true, ownedAt: Date.now() - 5_000 },
    { leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1, checkedAt: Date.now() - LEASE_TTL_MS - 1 }];
  for (const st of states) for (const dt of [0, 31_000]) {
    reset(st);
    assert.equal(standbyIdle(Date.now() + dt), !isCloudLeader(Date.now() + dt), `예비 기기의 스케줄러·감시(isCloudLeader)와 메신저(standbyIdle) 판정이 갈리면 안 된다 ${JSON.stringify(st)} +${dt}`);
  }
  role('normal'); reset();
  assert.equal(isCloudLeader(Date.now() + 31_000), true, '일반 기기는 종전대로 30초 뒤 담당(동기화가 안 되는 단일 기기의 루틴이 멈추지 않게) — 핀');
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
  reset({ leader: true, ownedAt: Date.now() - 10_000, checkedAt: Date.now() }); assert.equal(standbyIdle(), false);
  reset({ leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1, checkedAt: Date.now() - LEASE_TTL_MS - 1 }); assert.equal(standbyIdle(), true);
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

test('일반·우선 기기도 같은 판정이다 — 읽기 오류 주기에는 빈 리스여도 가져가지 않고(다음 주기에 가져감), 남의 리스도 빼앗지 않는다', async () => {
  for (const r of ['normal', 'preferred']) {
    role(r);
    const f = fakeClient(null); _setSyncClientForTest(f.client); reset();
    f.failReads(READ_ERRORS[0]);
    await renewLease('owner-e3', { runnerUsable: true });
    assert.equal(f.calls.upload, 0, `${r}: 읽기 오류 주기`);
    assert.equal(isCloudLeader(), false, r);
    await renewLease('owner-e3', { runnerUsable: true });
    assert.equal(f.calls.upload, 1, `${r}: 읽기가 되면 빈 리스를 가져온다`);
    assert.equal(isCloudLeader(), true, r);
    const g = fakeClient(fresh('other-mac')); _setSyncClientForTest(g.client); reset();
    g.failReads(READ_ERRORS[2]);
    await renewLease('owner-e3', { runnerUsable: true });
    assert.equal(g.calls.upload, 0, `${r}: 남의 리스를 읽지 못한 채 덮어썼다`);
    assert.equal(g.doc().deviceId, 'other-mac');
  }
});

test('보유자가 리스를 읽지 못하면 TTL 안에서만 담당을 유지하고 쓰지 않는다 — 쓰기 실패 규칙(holdsLeaseOnWriteFailure)과 같은 기준, 남의 넘겨받기 글을 덮어쓰지 않게', async () => {
  for (const r of ['standby', 'normal', 'preferred']) {
    role(r);
    const f = fakeClient(fresh(ME)); _setSyncClientForTest(f.client);
    reset({ leader: true, ownedAt: Date.now() - 40_000, checkedAt: Date.now() - 8_000 }); // 30초 갱신 차례
    f.failReads(READ_ERRORS[0]);
    await renewLease('owner-e4', { runnerUsable: true });
    assert.equal(f.calls.upload, 0, `${r}: 읽지 못한 채 갱신 쓰기 — 그 사이 맥이 쓴 넘겨받기 글을 덮을 수 있다`);
    assert.equal(isCloudLeader(), true, `${r}: TTL 안이면 일시 오류로 담당을 놓지 않는다`);
    reset({ leader: true, ownedAt: Date.now() - LEASE_TTL_MS - 1_000, checkedAt: Date.now() - 8_000 });
    f.failReads(READ_ERRORS[2]);
    await renewLease('owner-e4', { runnerUsable: true });
    assert.equal(isCloudLeader(), false, `${r}: TTL이 지나면 담당이 아니다`);
    assert.equal(f.calls.upload, 0, r);
  }
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
  const f = fakeClient(fresh(ME, { standby: true })); _setSyncClientForTest(f.client);
  reset({ leader: true, ownedAt: Date.now() - 5_000, checkedAt: Date.now() });
  f.staleCdn(fresh(ME, { standby: true })); // Storage 인증 다운로드도 Cloudflare에 캐시된다(10/5 edge_logs: 리스 첫 읽기 HIT)
  f.set(fresh('mac')); // 맥이 넘겨받기 글을 썼다(원본)
  await renewLease('owner-c1', { runnerUsable: true });
  assert.equal(isCloudLeader(), false, 'CDN 사본을 읽고 계속 담당 — 맥이 대기 뒤 시작하면 둘이 겹친다');
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
