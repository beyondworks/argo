// '다른 기기를 본 적 있음' 표지(.lease-peer.json — 켜지면 14일 동안 엄격 판정)는 살아 있는(TTL 안) 남의 리스 글을 볼 때만 켠다(2026-10-17).
// 결함: renewLease가 읽은 글의 deviceId가 내 것과 다르면 글이 살아 있는지 보기 전에 표지를 켰다. 기기 신원(.device-id)이 바뀌면(재설치·데이터 폴더 초기화·새 맥)
// 저장소에 남은 옛 신원의 만료 글을 첫 판정에서 읽어, 혼자 쓰는데도 14일 동안 엄격 판정이 되어 담당이 리스를 15초 대신 8초마다 읽었다(운영 24시간: 단일 기기 8초 무리가
// 리스 GET의 약 37% — 경로는 ①옛 앱·②표지·③프로세스 둘 중 하나, 경우 표 6-1). 만료된 글은 지금 함께 돌고 있는 기기의 증거가 아니다.
// 엄격 판정 여부는 leaseReadInterval()로 본다 — 확인된 담당이면 단일 기기 15초, 엄격 판정 8초(이 수정 전후 같은 규칙).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-peer-'));
process.env.ARGO_SYNC = '1';
const ACCT = 'u-peer';
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ACCT, email: '' } }));
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_SYNC_CYCLE_MS']) delete process.env[k];
const sync = await import('../src/sync.mjs');
const { renewLease, isCloudLeader, leaseReadInterval, _setSyncClientForTest, LEASE_TTL_MS, LEASE_SOLO_READ_MS } = sync;
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();
const OLD = 'Same-Mac-oldid000'; // 재설치 전 이 기기의 옛 신원
const PEER_FILE = join(process.env.ARGO_ROOT, '.lease-peer.json');
const DAY = 86_400_000;

const fakeStore = () => {
  const objs = new Map();
  let beforeCheck = null; // 쓰기 뒤 확인 읽기 직전에 한 번 — 다른 기기가 그 사이 쓴 경우
  const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
  const bucket = {
    async download(key) {
      const k = String(key).split('?')[0];
      if (String(key).includes('?t=') && beforeCheck) { const f = beforeCheck; beforeCheck = null; f(); }
      const b = objs.get(k); return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } };
    },
    async upload(key, blob) { objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
    async remove(keys) { for (const k of keys) objs.delete(k); return { data: [], error: null }; },
  };
  return {
    client: { storage: { from: () => bucket } },
    get: (key) => { const b = objs.get(key); return b ? JSON.parse(b.toString()) : null; },
    set: (key, doc) => { objs.set(key, Buffer.from(JSON.stringify(doc))); },
    onCheck: (f) => { beforeCheck = f; },
  };
};
const KEY = (owner) => `${owner}/_device-lease.json`;
const lease = () => globalThis.__argoSyncLease;
const awakeNow = () => {
  const a = (globalThis.__argoSyncAwake ??= {});
  if (a.timer && typeof a.timer !== 'string') clearInterval(a.timer);
  Object.assign(a, { timer: 'test', wall: Date.now(), mono: performance.now(), wokeAt: 0, since: Date.now() - 10 * 60_000 });
};
/** 막 켠 기기 — 아직 담당 아님(기동 기본값), 표지 peers는 주어진 대로. */
const fresh = (peers = {}) => {
  awakeNow(); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000;
  Object.assign(lease() ?? (globalThis.__argoSyncLease = {}), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false,
    token: null, validUntil: 0, holder: null, peers, peersSavedAt: Object.fromEntries(Object.entries(peers).map(([k, v]) => [k, v.at])) });
  rmSync(PEER_FILE, { force: true });
};
const strictNow = () => leaseReadInterval() !== LEASE_SOLO_READ_MS; // 확인된 담당일 때만 의미 있다
afterEach(() => { mock.timers.reset(); delete process.env.ARGO_STANDBY_LEADER; });

test('재설치 뒤 첫 판정 — 옛 신원의 만료된 리스 글을 봐도 다른 기기 표지를 켜지 않는다: 담당이 되고 단일 기기 15초로 읽는다', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-reinstall'; fresh();
  f.set(KEY(owner), { deviceId: OLD, token: 'old', ts: Date.now() - LEASE_TTL_MS - 5 * 60_000 }); // 재설치 전 신원의 글 — 5분 전에 만료
  await renewLease(owner, { runnerUsable: true });
  assert.equal(lease().leader && lease().ownedAt > 0, true, '만료 글이라 바로 가져와 담당');
  assert.equal(f.get(KEY(owner)).deviceId, ME);
  assert.equal(leaseReadInterval(), LEASE_SOLO_READ_MS, '혼자 쓰는 기기 — 15초(전에는 표지가 켜져 14일 동안 8초)');
  assert.ok(!(lease().peers?.[ACCT]?.at > 0), '다른 기기 표지(엄격 판정)는 켜지 않는다');
  assert.ok(lease().peers?.[ACCT]?.weakAt > 0, '만료 글은 약한 표지로만 남긴다(기동·세션 실패 기본값용 — P9-b)');
  for (let i = 0; i < 50 && !existsSync(PEER_FILE); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(JSON.parse(readFileSync(PEER_FILE, 'utf8')).accounts[ACCT].weakAt > 0, '약한 표지도 파일에 남아 재시작 뒤에 이어진다');
});

test('진짜 두 번째 기기 — 살아 있는 남의 리스를 보면 표지를 켜고 양보한다(엄격 판정)', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-second'; fresh();
  f.set(KEY(owner), { deviceId: 'Other-Mac-live0001', token: 'o', ts: Date.now() - 30_000 });
  await renewLease(owner, { runnerUsable: true });
  assert.equal(isCloudLeader(), false, '같은 역할의 살아 있는 리스 — 양보');
  assert.ok(lease().peers?.[ACCT]?.at > 0, '표지가 켜졌다');
  for (let i = 0; i < 50 && !existsSync(PEER_FILE); i++) await new Promise((r) => setTimeout(r, 10)); // 파일 쓰기는 기다리지 않는 원자 쓰기
  assert.equal(existsSync(PEER_FILE), true, '처음 보는 일반 기기라 바로 파일에 남긴다');
  f.set(KEY(owner), { deviceId: 'Other-Mac-live0001', token: 'o', ts: Date.now() - LEASE_TTL_MS - 1 }); // 그 기기가 꺼졌다
  await renewLease(owner, { runnerUsable: true });
  assert.equal(lease().ownedAt > 0, true, '만료 뒤 가져와 담당');
  assert.equal(strictNow(), true, '한 번 본 다른 기기는 14일 동안 엄격 판정(8초)');
});

test('만료 경계 — 글 나이가 TTL에서 1ms 모자라면 살아 있는 글(표지 켬), TTL이면 만료(표지 안 켬)', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const [age, expect] of [[LEASE_TTL_MS - 1, true], [LEASE_TTL_MS, false]]) {
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `o-edge-${age}`; fresh();
    f.set(KEY(owner), { deviceId: 'Other-Mac-edge0001', token: 'e', ts: Date.now() - age });
    await renewLease(owner, { runnerUsable: true });
    assert.equal(lease().peers?.[ACCT]?.at > 0, expect, `나이 ${age}ms → 표지 ${expect}`);
    assert.equal(lease().peers?.[ACCT]?.weakAt > 0, !expect, `나이 ${age}ms → 약한 표지 ${!expect}`);
  }
});

test('예비 기기(--standby)는 표지와 무관하게 늘 엄격 판정이다 — 만료 글만 본 혼자 쓰는 예비도 담당 간격 8초', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  process.env.ARGO_STANDBY_LEADER = '1';
  const owner = 'o-standby'; fresh();
  f.set(KEY(owner), { deviceId: OLD, token: 'old', ts: Date.now() - LEASE_TTL_MS - 60_000, standby: true });
  await renewLease(owner, { runnerUsable: true });
  assert.equal(lease().ownedAt > 0, true, '만료 글 — 예비도 가져온다(맥 두 대를 본 적 없음)');
  assert.ok(!(lease().peers?.[ACCT]?.at > 0), '표지는 켜지 않는다(약한 표지만)');
  assert.equal(leaseReadInterval(), 8_000, '예비는 늘 엄격 판정');
});

test('14일 경계 — 이미 켜진 표지는 본 시각부터 14일 동안 유지되고, 14일이 지나면 단일 기기로 돌아온다(업데이트로 지우지 않는다)', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const [ago, strict] of [[14 * DAY - 1_000, true], [14 * DAY + 1_000, false]]) {
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `o-14d-${ago}`; fresh({ [ACCT]: { at: Date.now() - ago, normals: [OLD] } }); // 업데이트 전 결함으로 켜진 표지(만료 글을 본 시각)
    f.set(KEY(owner), { deviceId: ME, token: 'mine', ts: Date.now() - LEASE_TTL_MS - 1 });
    await renewLease(owner, { runnerUsable: true });
    assert.equal(lease().ownedAt > 0, true);
    assert.equal(strictNow(), strict, `표지를 본 지 ${Math.round(ago / DAY * 10) / 10}일 → ${strict ? '엄격(8초)' : '단일(15초)'}`);
  }
});

test('가져오며 쓴 직후 다른 기기가 덮어쓴 경우(확인 읽기의 승자) — 막 쓴 살아 있는 글이므로 표지를 켠다', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-race'; fresh();
  f.onCheck(() => f.set(KEY(owner), { deviceId: 'Other-Mac-race0001', token: 'r', ts: Date.now() }));
  await renewLease(owner, { runnerUsable: true }); // 빈 리스 → 내가 씀 → 확인 직전 다른 기기가 씀
  assert.equal(lease().ownedAt > 0, false, '경합에서 졌다');
  assert.ok(lease().peers?.[ACCT]?.at > 0, '살아 있는 다른 기기 — 표지');
});

/* ── P9-b(검수 1, 2026-10-17): 진짜 다른 기기를 만료 글로만 본 기기가, 그 기기가 담당인 동안 세션 실패·첫 읽기 걸림으로 켜져도 함께 담당이 되지 않는다 ──
   배포본은 만료 글로도 표지가 켜져 엄격 판정이라 이 두 경로에서 담당이 아니었다(D 3차 MEDIUM-3). 만료 글은 약한 표지로 남겨 기동·세션 실패 기본값만 배포본처럼 둔다. */
const { _leaseUnreadableForTest } = sync;
const A = 'Mac-One-aaaa0001'; // 진짜 다른 기기 — 이 기기가 처음 켰을 때는 꺼져 있었다
/** 맥 두 대 번갈아 쓰기: 이 기기(B)가 처음 켰을 때 A의 만료 글을 보고 담당이 됐다가 꺼짐 → A가 켜져 담당 → B가 다시 켜진다(새 프로세스, 표지는 파일에서 이어진다). */
async function bootAfterExpiredSighting(f, owner) {
  fresh();
  f.set(KEY(owner), { deviceId: A, token: 'a-old', ts: Date.now() - LEASE_TTL_MS - 10 * 60_000 });
  await renewLease(owner, { runnerUsable: true });
  assert.equal(lease().ownedAt > 0, true, 'B가 만료 글을 가져와 담당이 됐다');
  for (let i = 0; i < 50 && !existsSync(PEER_FILE); i++) await new Promise((r) => setTimeout(r, 10));
  f.set(KEY(owner), { deviceId: A, token: 'a-live', ts: Date.now() - 20_000 }); // 이제 A가 담당(살아 있는 글)
  // B 재시작 — 프로세스 상태는 기동 기본값(leader 기본 true·미확인), 표지(peers)는 파일에서 읽은 그대로
  Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: 0, yieldSince: 0, pending: null, readFailSince: 0, token: null, validUntil: 0, holder: null });
  globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000; // 기동 대기(5초)는 지났다
  awakeNow();
}

test('P9-b (가) 세션 실패로 켜짐 — 만료 글로만 본 다른 기기가 지금 담당이어도 이 기기는 담당이 아니다(배포본과 같음)', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-p9b-session';
  await bootAfterExpiredSighting(f, owner);
  _leaseUnreadableForTest(null); // leaseTick: ensureClient 실패(세션 갱신 실패) → 리스를 볼 수 없다
  assert.equal(isCloudLeader(), false, 'A와 함께 담당이 되면 루틴 이중 실행·이중 답');
  assert.equal(sync.leaseCheck().leader, false, '담당 표시도 내려놓는다 — argo run 안내가 "판정 전"이 아니라 배포본처럼 "아직 아무도/다른 기기"로 읽는다');
});

test('P9-b (나) 첫 리스 읽기가 걸린 채 기동 — 기동 대기 5초가 지나도 담당이 아니다(배포본과 같음)', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-p9b-hang';
  await bootAfterExpiredSighting(f, owner);
  assert.equal(lease().checkedAt, 0, '아직 첫 판정 전(읽기가 걸려 있다)');
  assert.equal(isCloudLeader(), false, '걸린 읽기가 끝나기 전 최대 30초 동안 A와 함께 담당이 되지 않는다');
});

test('P9-b 약한 표지는 읽기 간격·확인 기한에 쓰지 않는다 — 혼자 쓰는 재설치 기기는 담당이 되면 15초, 내 글 만료 전까지 담당(단일 판정)', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-p9b-solo'; fresh();
  f.set(KEY(owner), { deviceId: OLD, token: 'old', ts: Date.now() - LEASE_TTL_MS - 60_000 });
  await renewLease(owner, { runnerUsable: true });
  assert.equal(leaseReadInterval(), LEASE_SOLO_READ_MS);
  assert.equal(isCloudLeader(), true, '확인된 담당 — 단일 판정');
  lease().validUntil = 0; // 엄격 판정이었다면 확인 기한이 지나 담당이 아니다
  assert.equal(isCloudLeader(), true, '약한 표지는 엄격 확인 기한을 쓰지 않는다');
  _leaseUnreadableForTest(null); // 확인된 담당의 세션 실패 — 내 글이 TTL 안이면 유지(종전과 같다)
  assert.equal(isCloudLeader(), true);
});
