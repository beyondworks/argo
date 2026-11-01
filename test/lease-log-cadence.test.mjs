// 리스·텔레그램 클레임의 요청 간격(2026-10-13 로그 수집 과금 — 리스 한 번 = edge 로그 + storage 로그 1~3줄).
// 쉬는 동안(바뀐 것 없음) 보유자가 몇 번 읽고 쓰는지를 가짜 시계로 센다. 가짜 저장소로 renewLease 결선을 직접 구동한다(lease-standby.test.mjs와 같은 방식).
// 가짜 시계는 Date만 바꾼다 — 판정 하나를 끝까지 기다린 뒤 시계를 넘긴다(#873 교훈: 넘기기 전에 흐름을 비운다).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-cadence-'));
process.env.ARGO_SYNC = '1';
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-cadence', email: '' } }), { mode: 0o600 });
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER']) delete process.env[k];
const sync = await import('../src/sync.mjs');
const { renewLease, isCloudLeader, _setSyncClientForTest, LEASE_TTL_MS, LEASE_RENEW_MS } = sync;
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();
const ACCT = 'u-cadence';

/** 가짜 저장소 — 객체별로 담고, 읽기·쓰기를 키별로 센다. failReads(...errs) = 다음 읽기들이 차례로 돌려줄 오류. */
const fakeStore = () => {
  const objs = new Map();
  const calls = { upload: 0, download: 0, byKey: new Map() };
  const failNext = [];
  const count = (op, key) => { const k = `${op} ${String(key).split('?')[0]}`; calls.byKey.set(k, (calls.byKey.get(k) || 0) + 1); };
  const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
  const bucket = {
    async download(key) {
      calls.download += 1; count('GET', key);
      const f = failNext.shift();
      if (f?.throw) throw f.throw;
      if (f) return { data: null, error: f };
      const b = objs.get(String(key).split('?')[0]);
      return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } };
    },
    async upload(key, blob) { calls.upload += 1; count('PUT', key); objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
    async remove(keys) { for (const k of keys) { count('DEL', k); objs.delete(k); } return { data: [], error: null }; },
  };
  return {
    client: { storage: { from: () => bucket } }, calls,
    get: (key) => { const b = objs.get(key); return b ? JSON.parse(b.toString()) : null; },
    set: (key, doc) => { objs.set(key, Buffer.from(JSON.stringify(doc))); },
    failReads: (...errs) => { failNext.push(...errs); },
  };
};
const LEASE_KEY = (owner) => `${owner}/_device-lease.json`;
const lease = () => globalThis.__argoSyncLease;
/** 깨어 있음 관찰을 지금 시각으로 맞춘다 — 가짜 시계가 벽시계만 넘기므로, 그대로 두면 판정마다 '잠들었다 깸'으로 읽힌다. */
const awakeNow = (sinceAgo = 10 * 60_000) => {
  const a = (globalThis.__argoSyncAwake ??= {});
  if (a.timer && typeof a.timer !== 'string') clearInterval(a.timer);
  Object.assign(a, { timer: 'test', wall: Date.now(), mono: performance.now(), wokeAt: a.wokeAt ?? 0 });
  if (sinceAgo != null) a.since = Date.now() - sinceAgo;
};
/** 확인된 보유자 — 방금 내 글(token)을 썼고 확인했다. sawPeer = 이 계정이 다른 기기를 본 적 있음(엄격 판정). */
const holder = (f, owner, { sawPeer = false } = {}) => {
  const token = `t-${owner}`;
  f.set(LEASE_KEY(owner), { deviceId: ME, token, ts: Date.now(), assistant: 2 });
  awakeNow(); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000;
  Object.assign(lease() ?? (globalThis.__argoSyncLease = {}), { leader: true, ownedAt: Date.now(), checkedAt: Date.now(), yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false,
    token, validUntil: Date.now() + 10_000, peers: sawPeer ? { [ACCT]: { at: Date.now(), normals: [] } } : {}, peersSavedAt: sawPeer ? { [ACCT]: Date.now() } : {} });
};
afterEach(() => mock.timers.reset());

/** 판정을 간격(stepMs)마다 durMs 동안 돌린다(가짜 시계). 매 판정 뒤 담당 여부를 모은다. */
async function idle(owner, { stepMs, durMs }) {
  const leaderEach = [];
  for (let t = 0; t < durMs; t += stepMs) {
    mock.timers.tick(stepMs); awakeNow(null);
    await renewLease(owner, { runnerUsable: true });
    leaderEach.push(isCloudLeader());
  }
  return leaderEach;
}

/* ── L2: 보유자의 다시 쓰기 60초, 갱신 때 확인 읽기 없음 ── */

for (const sawPeer of [false, true]) {
  test(`쉬는 보유자(${sawPeer ? '엄격 판정 — 다른 기기를 본 적 있음' : '단일 기기'}) — 10분 동안 리스 쓰기는 60초에 한 번, 갱신 때 확인 읽기 없음, 담당은 끊기지 않는다`, async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `owner-idle-${sawPeer ? 'strict' : 'solo'}`;
    holder(f, owner, { sawPeer });
    const each = await idle(owner, { stepMs: 8_000, durMs: 10 * 60_000 });
    const ticks = each.length;
    const puts = f.calls.byKey.get(`PUT ${LEASE_KEY(owner)}`) || 0;
    const gets = f.calls.byKey.get(`GET ${LEASE_KEY(owner)}`) || 0;
    assert.ok(puts >= 8 && puts <= 10, `10분 쓰기 ${puts}번 — 60초에 한 번(예전 30초면 약 19번)`);
    assert.equal(gets, ticks, `읽기 ${gets}번 = 판정 ${ticks}번 — 갱신 뒤 확인 읽기를 하지 않는다`);
    assert.deepEqual(each.filter((x) => !x), [], '담당이 한 번도 끊기지 않는다(엄격 판정의 확인 기한은 읽기가 늘린다)');
    assert.equal(f.get(LEASE_KEY(owner)).token, lease().token, '마지막 글의 토큰 = 메모리 토큰 — 다음 읽기가 확인으로 이어진다');
    assert.ok(Date.now() - f.get(LEASE_KEY(owner)).ts < LEASE_RENEW_MS + 8_000, '글은 60초 + 한 주기보다 오래되지 않는다(TTL 120초 안)');
  });
}

test('갱신 차례에 원격 글이 내 기기 id지만 다른 토큰이면(같은 기기의 다른 프로세스) 확인 읽기를 거친다 — 갱신 지름길은 내 토큰 그대로일 때만', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-other-proc';
  holder(f, owner);
  f.set(LEASE_KEY(owner), { deviceId: ME, token: 't-other-process', ts: Date.now(), assistant: 2 });
  lease().ownedAt = Date.now() - (LEASE_RENEW_MS + 1_000);
  await renewLease(owner, { runnerUsable: true });
  assert.equal(f.calls.byKey.get(`PUT ${LEASE_KEY(owner)}`), 1);
  assert.equal(f.calls.byKey.get(`GET ${LEASE_KEY(owner)}`), 2, '읽기 + 쓰기 뒤 확인 읽기');
  assert.equal(lease().leader, true, '확인 읽기에서 내 토큰이 이겼다');
  assert.equal(lease().token, f.get(LEASE_KEY(owner)).token);
});

test('리스 만료 경계 — 쉬는 보유자의 글은 다른 기기가 보기에 늘 살아 있다(글 나이 < TTL)', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-edge';
  holder(f, owner);
  let oldest = 0;
  for (let t = 0; t < 5 * 60_000; t += 8_000) {
    mock.timers.tick(8_000); awakeNow(null);
    oldest = Math.max(oldest, Date.now() - f.get(LEASE_KEY(owner)).ts);
    await renewLease(owner, { runnerUsable: true });
  }
  assert.ok(oldest < LEASE_TTL_MS - 40_000, `다른 기기가 본 가장 오래된 글 ${oldest / 1000}초 — TTL ${LEASE_TTL_MS / 1000}초까지 여유`);
});

/* ── T1: 텔레그램 클레임 — 보유자는 60초마다만 다시 쓴다(판정·읽기는 30초) ── */

const { setClaimTokens, renewTokenClaims, tokenOwnership, tokenClaimHash, _resetTokenClaimsForTest, CLAIM_REWRITE_MS, TG_CLAIM_TTL_MS } = sync;
const CLAIM_KEY = (owner, tok) => `${owner}/.tg-claims/${tokenClaimHash(tok)}.json`;
const claimReadFailReset = () => globalThis.__argoTgClaimReadFail?.clear();
/** 아래 클레임 시험은 종전 규칙(판정 30초·다시 쓰기 40초·TTL 120초)을 잠근다 — 다른 기기를 본 적 있는 계정(엄격 판정)이라 혼자 모드가 아니다.
    혼자 쓰는 기기의 긴 클레임(2026-10-31)은 test/tg-claims-solo.test.mjs. */
const classicClaims = () => { const l = lease() ?? (globalThis.__argoSyncLease = {}); l.peers = { [ACCT]: { at: Date.now(), normals: [] } }; l.peersSavedAt = { [ACCT]: Date.now() }; };

test('쉬는 클레임 보유자(토큰 5개) — 10분 동안 토큰마다 읽기는 30초, 쓰기는 약 60초에 한 번(다시 쓰기 40초 + 30초 판정), 글 나이는 판정 직전에도 75초 안, 소유는 끊기지 않는다', async () => {
  _resetTokenClaimsForTest(); classicClaims();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-claims'; const toks = ['c1', 'c2', 'c3', 'c4', 'c5'];
  setClaimTokens(toks);
  let now = Date.now();
  await renewTokenClaims(owner, { now }); // 획득(쓰기 + 확인 읽기)
  for (const t of toks) assert.equal(tokenOwnership(t).mine, true);
  const base = Object.fromEntries(toks.map((t) => [t, { put: f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, t)}`) || 0, get: f.calls.byKey.get(`GET ${CLAIM_KEY(owner, t)}`) || 0 }]));
  let ticks = 0; const lost = []; let oldest = 0;
  for (let el = 0; el < 10 * 60_000; el += 30_000) {
    now += 30_000; ticks += 1;
    for (const t of toks) oldest = Math.max(oldest, now - f.get(CLAIM_KEY(owner, t)).ts);
    await renewTokenClaims(owner, { now });
    for (const t of toks) if (!tokenOwnership(t).mine) lost.push(`${t}@${el}`);
  }
  for (const t of toks) {
    const puts = (f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, t)}`) || 0) - base[t].put;
    const gets = (f.calls.byKey.get(`GET ${CLAIM_KEY(owner, t)}`) || 0) - base[t].get;
    assert.ok(puts >= 9 && puts <= 10, `${t}: 10분 쓰기 ${puts}번 — 60초에 한 번(예전 30초면 20번)`);
    assert.equal(gets, ticks, `${t}: 읽기 = 판정 수(${ticks})`);
    assert.ok(now - f.get(CLAIM_KEY(owner, t)).ts < TG_CLAIM_TTL_MS - 30_000, `${t}: 다른 기기가 보기에 늘 살아 있는 클레임`);
  }
  assert.deepEqual(lost, [], '소유가 끊긴 판정 없음');
  assert.equal(CLAIM_REWRITE_MS, 40_000);
  assert.ok(oldest <= 60_000, `판정 직전 가장 오래된 글 ${oldest / 1000}초`);
});

/* ── 검수 1(2026-10-13) — 클레임 소유의 시각 상한, 같은 토큰 두 기기 + 판정 하나가 30초 걸림 ── */

test('클레임 소유 시각 상한 — 내 글 ts + TTL − 4초(116초)까지만 mine, 넘으면 판정 중(pending)으로 물러난다', async () => {
  _resetTokenClaimsForTest(); classicClaims(); claimReadFailReset();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const t0 = Date.now();
  mock.timers.enable({ apis: ['Date'], now: t0 });
  setClaimTokens(['cap1']);
  await renewTokenClaims('owner-cap', { now: t0 });
  assert.equal(tokenOwnership('cap1').mine, true);
  mock.timers.tick(TG_CLAIM_TTL_MS - 4_000 - 1);
  assert.equal(tokenOwnership('cap1').mine, true, '115.999초 — 아직 내 것');
  mock.timers.tick(1);
  assert.deepEqual(tokenOwnership('cap1'), { mine: false, holder: null, pending: true }, '116초 — 다음 판정까지 물러난다');
});

/** 같은 토큰을 가진 두 기기 — A가 보유자, B는 A의 글이 만료(TTL)되는 순간 가져간다(claimDecision). A의 판정 간격 gaps(ms)대로 시계를 넘기며
    1초마다 "A가 폴링(mine) && B가 가져갈 수 있음(A 글 만료)"인 순간을 센다. 판정 하나가 30초 걸리면 그 간격이 30초 늘어난다. */
async function twoDevices(gaps) {
  _resetTokenClaimsForTest(); classicClaims(); claimReadFailReset();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-two'; const tok = 'same-token';
  const t0 = Date.now(); mock.timers.enable({ apis: ['Date'], now: t0 });
  setClaimTokens([tok]);
  await renewTokenClaims(owner, { now: t0 });
  let overlap = 0; let gap = 0; let maxAge = 0;
  for (const g of gaps) {
    for (let s = 0; s < g; s += 1_000) {
      mock.timers.tick(1_000);
      const doc = f.get(CLAIM_KEY(owner, tok)); const age = Date.now() - doc.ts; maxAge = Math.max(maxAge, age);
      const aPolls = tokenOwnership(tok).mine;
      const bTakes = age >= TG_CLAIM_TTL_MS; // B는 만료를 보면 가져간다(claimDecision 'acquire')
      if (aPolls && bTakes) overlap += 1;
      if (!aPolls) gap += 1;
    }
    await renewTokenClaims(owner, { now: Date.now() });
  }
  return { overlap, gap, maxAge };
}

test('같은 토큰 두 기기 — 판정이 30초마다면 글 나이 75초 안·공백 0·겹침 0', async () => {
  const r = await twoDevices(Array(20).fill(30_000));
  assert.equal(r.overlap, 0); assert.equal(r.gap, 0);
  assert.ok(r.maxAge <= 75_000, `글 나이 최대 ${r.maxAge / 1000}초`);
});

test('같은 토큰 두 기기 + 판정 하나가 30초 걸림(sync 클라이언트 시간 초과) — 글 나이 약 105초 안, 겹침 0', async () => {
  const r = await twoDevices([30_000, 30_000, 30_000, 60_000, 30_000, 30_000, 30_000, 30_000]); // 넷째 판정이 30초 늦다
  assert.equal(r.overlap, 0, '같은 토큰을 두 기기가 동시에 폴링하지 않는다');
  assert.ok(r.maxAge <= 105_000, `글 나이 최대 ${r.maxAge / 1000}초 — 시각 상한 116초 안`);
  assert.equal(r.gap, 0, '상한 안이라 공백도 없다');
});

test('같은 토큰 두 기기 + 판정이 두 번 연달아 늦음(나이가 상한을 넘김) — 겹침 대신 잠깐 공백', async () => {
  const r = await twoDevices([30_000, 30_000, 125_000, 30_000, 30_000]); // 둘째 쓰기 뒤 판정이 125초 뒤에야 끝난다(시간 초과가 연달아)
  assert.equal(r.overlap, 0, '겹침 0');
  assert.ok(r.gap > 0, `공백 ${r.gap}초 — 상한(116초)부터 다음 판정까지 물러난다`);
});

/* ── 클레임 읽기 오류 — '없음'으로 읽지 않는다(덮어쓰기 → 같은 토큰 이중 폴링·텔레그램 409) ── */

const READ_ERRORS = [
  { name: 'StorageApiError', message: 'Internal Server Error', status: 500, statusCode: '500' },
  { name: 'StorageUnknownError', message: 'fetch failed' },
  { name: 'StorageApiError', message: 'Bucket not found', status: 400, statusCode: '404' }, // 만료 토큰 GET을 Storage가 익명으로 처리
  { throw: new TypeError('terminated') }, // 응답 본문을 받다 끊김
];

for (const err of READ_ERRORS) {
  test(`클레임 읽기 오류(${err.message ?? err.throw.message}) — 남의 살아 있는 클레임을 덮어쓰지 않고, 미보유로 보류한다`, async () => {
    _resetTokenClaimsForTest(); classicClaims(); claimReadFailReset();
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = 'owner-claim-err'; const now = Date.now();
    f.set(CLAIM_KEY(owner, 'x1'), { deviceId: 'Other-PC-deadbeef', nonce: 'n', ts: now - 10_000 });
    setClaimTokens(['x1']);
    f.failReads(err);
    await renewTokenClaims(owner, { now });
    assert.equal(f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, 'x1')}`) || 0, 0, '쓰기 없음');
    assert.equal(f.get(CLAIM_KEY(owner, 'x1')).deviceId, 'Other-PC-deadbeef', '남의 클레임이 그대로');
    assert.equal(tokenOwnership('x1').mine, false, '이 기기는 폴링하지 않는다');
    assert.equal(tokenOwnership('x1').pending, false);
    await renewTokenClaims(owner, { now: now + 30_000 }); // 읽기가 돌아오면 정상 판정
    assert.deepEqual({ mine: tokenOwnership('x1').mine, holder: tokenOwnership('x1').holder }, { mine: false, holder: 'Other-PC-deadbeef' });
  });
}

test('클레임 읽기 오류 — 확인된 보유자는 내 글이 TTL 안이면 쓰지 않고 소유를 유지한다', async () => {
  _resetTokenClaimsForTest(); classicClaims(); claimReadFailReset();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-claim-keep'; let now = Date.now();
  setClaimTokens(['k1']);
  await renewTokenClaims(owner, { now });
  const puts0 = f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, 'k1')}`);
  f.failReads(READ_ERRORS[0], READ_ERRORS[1]);
  now += 30_000; await renewTokenClaims(owner, { now });
  assert.equal(tokenOwnership('k1').mine, true, '30초 — 유지');
  now += 30_000; await renewTokenClaims(owner, { now });
  assert.equal(tokenOwnership('k1').mine, true, '60초 — 유지(글이 TTL 안)');
  assert.equal(f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, 'k1')}`), puts0, '읽기 오류 판정은 쓰지 않는다');
  f.failReads(READ_ERRORS[0], READ_ERRORS[0]); // 90초·120초 — 읽기 실패가 시작된 지 90초라 아직 자가 복구 전
  for (let i = 0; i < 2; i++) { now += 30_000; await renewTokenClaims(owner, { now }); }
  assert.equal(tokenOwnership('k1').mine, false, '내 글이 TTL(120초)에 닿으면 미보유(다른 기기가 가져갈 수 있는 시점과 같다)');
  assert.equal(f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, 'k1')}`), puts0, '여전히 쓰지 않는다');
});

test('클레임 읽기 오류가 TTL 넘게 이어지면 TTL에 한 번만 써 본다 — 읽을 수 없는 객체가 토큰을 영영 막지 않게', async () => {
  _resetTokenClaimsForTest(); classicClaims(); claimReadFailReset();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-claim-escape'; let now = Date.now();
  setClaimTokens(['e1']);
  const errs = Array.from({ length: 20 }, () => READ_ERRORS[0]);
  f.failReads(...errs); // 확인 읽기까지 실패
  const puts = () => f.calls.byKey.get(`PUT ${CLAIM_KEY(owner, 'e1')}`) || 0;
  for (let el = 0; el <= TG_CLAIM_TTL_MS + 60_000; el += 30_000) { await renewTokenClaims(owner, { now }); now += 30_000; }
  assert.equal(puts(), 1, `TTL + 60초 동안 쓰기 ${puts()}번 — 자가 복구 한 번`);
  assert.equal(tokenOwnership('e1').mine, false, '확인 읽기도 실패 — 보수적으로 미보유');
});

/* ── L1: 단일 기기 보유자의 리스 읽기 간격 — 15초(넘겨받기 대기 22초보다 7초 짧게), 깨면 바로 ── */

const { leaseReadInterval, waitLeaseTick, LEASE_SOLO_READ_MS, HANDOVER_WAIT_MS } = sync;

test('읽기 간격 — 단일 기기의 확인된 보유자만 15초, 엄격 판정·예비·미보유·넘겨받는 중·읽기 실패 중은 8초', () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  assert.equal(LEASE_SOLO_READ_MS, 15_000);
  assert.ok(LEASE_SOLO_READ_MS <= HANDOVER_WAIT_MS - 7_000, '옛 버전의 넘겨받는 기기도 담당을 시작하기 전에 이 보유자가 남의 글을 읽는다');
  holder(f, 'owner-iv'); assert.equal(leaseReadInterval(), 15_000, '단일 기기 보유자');
  holder(f, 'owner-iv', { sawPeer: true }); assert.equal(leaseReadInterval(), 8_000, '다른 기기를 본 계정(엄격 판정 — 확인 기한 18초)');
  holder(f, 'owner-iv'); process.env.ARGO_STANDBY_LEADER = '1';
  try { assert.equal(leaseReadInterval(), 8_000, '예비 기기'); } finally { delete process.env.ARGO_STANDBY_LEADER; }
  holder(f, 'owner-iv'); lease().ownedAt = 0; assert.equal(leaseReadInterval(), 8_000, '확인된 보유가 아님(기동 기본값)');
  holder(f, 'owner-iv'); lease().leader = false; assert.equal(leaseReadInterval(), 8_000, '담당 아님');
  holder(f, 'owner-iv'); lease().pending = { token: 'p', ts: Date.now() }; assert.equal(leaseReadInterval(), 8_000, '넘겨받는 중');
  holder(f, 'owner-iv'); lease().readFailSince = Date.now(); assert.equal(leaseReadInterval(), 8_000, '읽기 실패 중');
});

test('쉬는 단일 기기 보유자 — 10분 동안 리스 읽기 40번(예전 75번)·쓰기 10번 이하, 담당은 끊기지 않는다', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-solo-loop'; holder(f, owner);
  const each = []; let el = 0;
  while (el < 10 * 60_000) { const step = leaseReadInterval(); el += step; mock.timers.tick(step); awakeNow(null); await renewLease(owner, { runnerUsable: true }); each.push(isCloudLeader()); }
  const gets = f.calls.byKey.get(`GET ${LEASE_KEY(owner)}`); const puts = f.calls.byKey.get(`PUT ${LEASE_KEY(owner)}`) || 0;
  assert.equal(gets, 40, `읽기 ${gets}번`);
  assert.ok(puts >= 8 && puts <= 10, `쓰기 ${puts}번`);
  assert.deepEqual(each.filter((x) => !x), []);
});

test('잠들었다 깨면 기다리던 판정을 바로 끝낸다 — 깸 하나에 한 번만(판정이 checkedAt을 남기지 않아도 2초 고리가 되지 않게)', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  holder(f, 'owner-wake');
  let slept = 0; const sleep = async (d) => { slept += d; };
  globalThis.__argoSyncAwake.wokeAt = Date.now() + 1; // 방금 깼다(마지막 확인보다 뒤)
  assert.equal(await waitLeaseTick(15_000, sleep), 'woke', '첫 관찰(2초)에서 끝낸다');
  assert.ok(slept <= 2_000, `기다린 시간 ${slept}ms`);
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  slept = 0;
  assert.equal(await waitLeaseTick(6_000, async (d) => { slept += d; mock.timers.tick(d); }), 'timeout', '같은 깸으로 다시 끝내지 않는다');
  assert.equal(slept, 6_000, '끝까지 기다린다');
});

test('클레임 판정 박자 — 리스 판정이 15초(조금 이른 14.99초)마다 와도 클레임 판정은 30초마다 돈다(30·45초 번갈아 아님)', async () => {
  _resetTokenClaimsForTest(); classicClaims(); claimReadFailReset();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'owner-beat'; const tok = 'beat-token';
  setClaimTokens([tok]);
  let now = Date.now();
  await renewTokenClaims(owner, { now });
  const gets0 = f.calls.byKey.get(`GET ${CLAIM_KEY(owner, tok)}`);
  for (let i = 0; i < 40; i++) { now += 14_990; await renewTokenClaims(owner, { now }); } // 약 10분
  const judged = f.calls.byKey.get(`GET ${CLAIM_KEY(owner, tok)}`) - gets0;
  assert.equal(judged, 20, `10분 판정 ${judged}번 — 30초마다(여유 없이 30초를 재면 45초마다 13번)`);
});
