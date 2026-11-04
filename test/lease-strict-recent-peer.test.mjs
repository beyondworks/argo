// 리스 Storage 호출 줄이기 F·B(2026-11-03 운영 로그 — 리스 하루 약 12.5만 줄, 설계: 워커 노트 2026-11-03-argo-device-lease-storage-design).
// F: 엄격 판정(확인 기한 18초·8초 읽기)은 살아 있는 다른 기기를 최근 6시간(PEER_STRICT_MS) 안에 본 계정만. 14일 표지는 기동·세션 실패 기본값(담당 아님)과 텔레그램 혼자 모드 판정에만.
// B: 확인된 보유자의 다시 쓰기 60초 → 80초(TTL 120초·넘겨받기 22초·확인 기한 18초는 그대로).
// 앞 절(핀)은 고치기 전과 후에 같아야 하는 이웃 행동, 뒤 절은 바뀐 행동과 설계 노트의 위험(시계 차이·GET 실패 + 우선 기기 복귀)을 잰다.
// 가짜 저장소로 renewLease 결선을 직접 돌리고 가짜 시계는 Date만 넘긴다(lease-log-cadence와 같은 틀).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-recent-'));
process.env.ARGO_SYNC = '1';
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-recent', email: '' } }), { mode: 0o600 });
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER']) delete process.env[k];
const sync = await import('../src/sync.mjs');
const { renewLease, isCloudLeader, leaseReadInterval, _setSyncClientForTest, _leaseUnreadableForTest, setClaimTokens, renewTokenClaims, tokenClaimHash, _resetTokenClaimsForTest,
  LEASE_TTL_MS, LEASE_RENEW_MS, LEASE_SOLO_READ_MS, LEASE_IDLE_READ_MS, LEASE_CONFIRM_VALID_MS, HANDOVER_WAIT_MS } = sync;
const PEER_STRICT_MS = sync.PEER_STRICT_MS ?? 14 * 86_400_000; // 고치기 전에는 없다(14일이 곧 엄격 판정) — 핀을 고치기 전 코드에서도 돌리려고
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();
const ACCT = 'u-recent';
const OTHER = 'Other-Mac-recent01';
const MARGIN = 4_000; // LEASE_CONFIRM_MARGIN_MS(내보내지 않음) — 내 글 만료 전 여유
const H = 3_600_000;
const PEER_FILE = join(process.env.ARGO_ROOT, '.lease-peer.json');
afterEach(() => { mock.timers.reset(); delete process.env.ARGO_PREFER_LEADER; });

/** 가짜 저장소 — 키별로 읽기·쓰기를 센다. failReads(n) = 다음 읽기 n번 오류(5xx). list는 클레임 판정용(eTag = 본문 MD5). */
function fakeStore() {
  const objs = new Map(); const n = { get: 0, put: 0, list: 0 }; const failNext = [];
  const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
  const bucket = {
    async download(key) {
      n.get += 1;
      if (failNext.length) return { data: null, error: failNext.shift() };
      const b = objs.get(String(key).split('?')[0]);
      return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } };
    },
    async upload(key, blob) { n.put += 1; objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
    async remove(keys) { for (const k of keys) objs.delete(k); return { data: [], error: null }; },
    async list(prefix) {
      n.list += 1; const out = [];
      for (const [k, b] of objs) if (k.startsWith(`${prefix}/`)) out.push({ name: k.slice(prefix.length + 1), metadata: { eTag: `"${createHash('md5').update(b).digest('hex')}"` } });
      return { data: out, error: null };
    },
  };
  return {
    client: { storage: { from: () => bucket } }, n,
    get: (k) => { const b = objs.get(k); return b ? JSON.parse(b.toString()) : null; },
    set: (k, doc) => objs.set(k, Buffer.from(JSON.stringify(doc))),
    failReads: (count) => { for (let i = 0; i < count; i++) failNext.push({ name: 'StorageUnknownError', message: 'upstream 503', status: 503 }); },
  };
}
const KEY = (owner) => `${owner}/_device-lease.json`;
const lease = () => (globalThis.__argoSyncLease ??= {});
const awakeNow = (sinceAgo = 10 * 60_000) => {
  const a = (globalThis.__argoSyncAwake ??= {});
  if (a.timer && typeof a.timer !== 'string') clearInterval(a.timer);
  Object.assign(a, { timer: 'test', wall: Date.now(), mono: performance.now(), wokeAt: a.wokeAt ?? 0 });
  if (sinceAgo != null) a.since = Date.now() - sinceAgo;
};
/** 이 계정의 다른 기기 표지 — ago = 마지막으로 살아 있는 다른 기기를 본 지 몇 ms(null = 본 적 없음). */
const peersFor = (ago) => (ago == null ? { peers: {}, peersSavedAt: {} } : { peers: { [ACCT]: { at: Date.now() - ago, normals: [OTHER] } }, peersSavedAt: { [ACCT]: Date.now() } });
/** 확인된 보유자 — 방금 내 글(token)을 썼고 그 글을 확인했다(확인 기한 = 지금 + 18초). */
function holder(f, owner, { peerAgo = null } = {}) {
  const token = `t-${owner}`;
  f.set(KEY(owner), { deviceId: ME, token, ts: Date.now() });
  awakeNow(); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000;
  Object.assign(lease(), { leader: true, ownedAt: Date.now(), checkedAt: Date.now(), yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false, followAt: 0,
    token, validUntil: Date.now() + LEASE_CONFIRM_VALID_MS, holder: null, ...peersFor(peerAgo) });
}
/** 확인 전 기동 기본값(leader: true, ownedAt: 0) — 첫 판정은 끝났다(checkedAt), 기동 대기는 지났다. */
function bootDefault({ peerAgo = null } = {}) {
  awakeNow(); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000;
  Object.assign(lease(), { leader: true, ownedAt: 0, checkedAt: Date.now(), yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false, followAt: 0,
    token: null, validUntil: 0, holder: null, ...peersFor(peerAgo) });
}
/** 리스 타이머 흉내 — leaseReadInterval()만큼 시계를 넘기며 durMs 동안 판정한다. 판정마다 담당 여부를 모은다. */
async function loop(owner, durMs) {
  const each = []; let el = 0;
  while (el < durMs) { const step = leaseReadInterval(); el += step; mock.timers.tick(step); awakeNow(null); await renewLease(owner, { runnerUsable: true }); each.push(isCloudLeader()); }
  return each;
}

/* ───────────── 핀 — 고치기 전과 후에 같은 이웃 행동 ───────────── */

test('핀: 하루 전에 다른 기기를 본 계정(14일 표지) — 확인 전 기동 기본값은 담당이 아니다', () => {
  bootDefault({ peerAgo: 24 * H });
  assert.equal(isCloudLeader(), false, '세션이 끊긴 채 기동한 맥이 기본값으로 VPS와 함께 담당이 되면 안 된다(D 3차 검수 MEDIUM-3)');
  bootDefault({ peerAgo: null });
  assert.equal(isCloudLeader(), true, '본 적 없는 단일 기기는 배포본처럼 담당');
});

test('핀: 하루 전에 다른 기기를 본 계정 — 세션 실패(동기화 자격 없음)에도 확인되지 않은 기본값은 담당을 내려놓는다', () => {
  bootDefault({ peerAgo: 24 * H });
  _leaseUnreadableForTest(); // 줄 없음 = 세션 실패
  assert.equal(lease().leader, false);
  bootDefault({ peerAgo: null });
  _leaseUnreadableForTest();
  assert.equal(lease().leader, true, '본 적 없는 단일 기기의 세션 실패는 배포본처럼 둔다');
});

test('핀: 방금 다른 기기를 본 보유자 — 8초로 읽고, 확인 기한(18초)이 지나면 담당이 아니다', () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  holder(f, 'o-pin-strict', { peerAgo: 0 });
  assert.equal(leaseReadInterval(), 8_000);
  assert.equal(isCloudLeader(), true);
  assert.equal(isCloudLeader(lease().validUntil + 1), false, '엄격 판정 — 확인 기한 뒤에는 담당 아님');
});

test('핀: 다른 기기를 본 적 없는 보유자 — 단일 기기 간격(LEASE_SOLO_READ_MS)', () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  holder(f, 'o-pin-solo');
  assert.equal(leaseReadInterval(), LEASE_SOLO_READ_MS);
  assert.equal(isCloudLeader(lease().validUntil + 1), true, '단일 기기 — 내 글 만료 전까지 담당');
});

test('핀: 6시간 넘게 혼자였어도 다른 기기의 살아 있는 글을 보는 판정에서 양보하고, 표지가 새로 켜져 바로 엄격 판정(담당 아닌 기기 30초)이다', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-pin-return';
  holder(f, owner, { peerAgo: 7 * H });
  f.set(KEY(owner), { deviceId: OTHER, token: 'o', ts: Date.now() }); // 같은 역할의 다른 기기가 만료 뒤 가져간 글(이 기기는 그것을 처음 읽는다)
  await renewLease(owner, { runnerUsable: true });
  assert.equal(lease().leader, false, '살아 있는 같은 역할의 글 — 양보');
  assert.ok(Date.now() - lease().peers[ACCT].at < 30_000, `표지 시각이 지금으로(${Date.now() - lease().peers[ACCT].at}ms 전 — 7시간 전이던 것)`);
  assert.equal(leaseReadInterval(), LEASE_IDLE_READ_MS, '엄격 판정의 담당 아님(30초)');
});

test('핀: 텔레그램 혼자 모드는 14일 표지로 본다 — 하루 전에 다른 기기를 본 계정은 긴 클레임을 쓰지 않고, 본 적 없는 계정은 쓴다', async () => {
  for (const [peerAgo, solo] of [[24 * H, false], [null, true]]) {
    _resetTokenClaimsForTest(); globalThis.__argoTgClaimReadFail?.clear(); globalThis.__argoTgClaimList?.clear();
    if (globalThis.__argoTgClaimListState) globalThis.__argoTgClaimListState.offUntil = -Infinity;
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `o-pin-claim-${solo}`;
    holder(f, owner, { peerAgo });
    lease().holder = { deviceId: ME, ts: Date.now() };
    setClaimTokens(['tok-pin']);
    await renewTokenClaims(owner, { now: Date.now(), force: true });
    const doc = f.get(`${owner}/.tg-claims/${tokenClaimHash('tok-pin')}.json`);
    assert.ok(doc, '클레임을 썼다');
    assert.equal(doc.lease === true, solo, `표지 ${peerAgo == null ? '없음' : '하루 전'} → 혼자 모드 ${solo}`);
  }
  setClaimTokens([]);
});

/* ───────────── F — 엄격 판정은 최근 6시간 ───────────── */

test('F: 7시간 전에 다른 기기를 본(14일 표지만 남은) 확인된 보유자 — 단일 기기 간격으로 읽고, 확인 기한이 지나도 내 글 만료 전까지 담당', () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  holder(f, 'o-f-7h', { peerAgo: 7 * H });
  assert.equal(leaseReadInterval(), LEASE_SOLO_READ_MS, '고치기 전: 14일 표지라 8초');
  assert.equal(isCloudLeader(lease().validUntil + 1), true, '단일 기기 규칙');
  assert.equal(isCloudLeader(lease().ownedAt + LEASE_TTL_MS - MARGIN), false, '내 글 만료(ts + TTL − 4초)부터는 아니다');
});

test('F: 경계 — 5시간 59분 전 표지는 엄격 판정(8초), 6시간 1초 전 표지는 단일 기기', () => {
  assert.equal(PEER_STRICT_MS, 6 * H);
  const f = fakeStore(); _setSyncClientForTest(f.client);
  holder(f, 'o-f-edge', { peerAgo: 6 * H - 60_000 });
  assert.equal(leaseReadInterval(), 8_000);
  holder(f, 'o-f-edge', { peerAgo: 6 * H + 1_000 });
  assert.equal(leaseReadInterval(), LEASE_SOLO_READ_MS);
});

test('F: 7시간 전 표지 계정의 쉬는 보유자 1시간 — 리스 읽기 240번(고치기 전 8초면 450번), 쓰기 시간당 40번, 담당은 끊기지 않는다', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-f-hour';
  holder(f, owner, { peerAgo: 7 * H });
  const each = await loop(owner, H);
  assert.equal(f.n.get, each.length, '판정마다 읽기 1번(갱신 뒤 확인 읽기 없음)');
  assert.equal(f.n.get, H / LEASE_SOLO_READ_MS, `1시간 리스 읽기 ${f.n.get}번`);
  assert.ok(f.n.put >= 39 && f.n.put <= 41, `1시간 쓰기 ${f.n.put}번 — 80초 + 15초 박자 = 90초마다`);
  assert.deepEqual(each.filter((x) => !x), [], '담당이 끊기지 않는다');
});

test('F 위험(설계 노트 경우 3) — 6시간 넘게 혼자이던 보유자의 GET이 계속 실패하는 동안 우선 기기가 돌아와 가져가면 함께 담당이 최대 약 94초(ts + TTL − 4초 − 22초). 6시간 안에 봤으면 0초', async () => {
  const run = async (peerAgo) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `o-f-risk-${peerAgo}`;
    holder(f, owner, { peerAgo }); // 방금 다시 썼다(최악 — 내 글이 가장 오래 산다)
    const t0 = Date.now();
    f.set(KEY(owner), { deviceId: OTHER, token: 'p', ts: t0, preferred: true }); // 우선 기기(argo run)가 곧바로 가져갔다
    const otherOn = t0 + HANDOVER_WAIT_MS; // 그 기기는 넘겨받기 대기(22초) 뒤 담당을 시작한다(옛 판도 같다)
    f.failReads(1_000); // 이 보유자의 리스 GET은 계속 실패한다
    let next = t0 + leaseReadInterval(); let overlap = 0; let lastOn = 0;
    for (let t = 1_000; t <= 200_000; t += 1_000) {
      mock.timers.tick(1_000); awakeNow(null);
      if (Date.now() >= next) { await renewLease(owner, { runnerUsable: true }); next = Date.now() + leaseReadInterval(); }
      if (isCloudLeader()) { lastOn = Date.now() - t0; if (Date.now() >= otherOn) overlap += 1_000; }
    }
    mock.timers.reset();
    return { overlap, lastOn };
  };
  const strict = await run(1 * H);
  assert.equal(strict.overlap, 0, `6시간 안 표지(엄격 판정) — 확인 기한 18초에 물러난다(마지막 담당 ${strict.lastOn / 1000}초)`);
  const stale = await run(7 * H);
  const bound = LEASE_TTL_MS - MARGIN - HANDOVER_WAIT_MS;
  assert.ok(stale.overlap > 0, '받아들인 위험의 재현 — 단일 기기 규칙은 내 글 만료까지 담당');
  assert.ok(stale.overlap <= bound, `함께 담당 ${stale.overlap / 1000}초 ≤ ${bound / 1000}초`);
  assert.ok(stale.lastOn < LEASE_TTL_MS - MARGIN, `내 글 만료(116초) 뒤에는 담당 아님 — 마지막 담당 ${stale.lastOn / 1000}초`);
});

test('F: 표지 시각은 한 시간에 한 번 파일에 다시 쓴다 — 다시 켜진 뒤에도 6시간 판정이 맞게(고치기 전 하루에 한 번)', async () => {
  rmSync(PEER_FILE, { force: true });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-f-save';
  bootDefault({ peerAgo: null }); lease().leader = false;
  f.set(KEY(owner), { deviceId: OTHER, token: 'o', ts: Date.now() });
  await renewLease(owner, { runnerUsable: true });
  const read = () => { try { return JSON.parse(readFileSync(PEER_FILE, 'utf8')); } catch { return null; } };
  const waitFile = async (ok) => { for (let i = 0; i < 500; i++) { const d = read(); if (d && ok(d)) return d; await new Promise((r) => setTimeout(r, 10)); } return read(); };
  const first = (await waitFile((d) => d.accounts?.[ACCT]?.at > 0)).accounts[ACCT].at;
  await new Promise((r) => setTimeout(r, 20));
  f.set(KEY(owner), { deviceId: OTHER, token: 'o', ts: Date.now() });
  await renewLease(owner, { runnerUsable: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(read().accounts[ACCT].at, first, '한 시간 안에 다시 본 것은 쓰지 않는다');
  lease().peersSavedAt[ACCT] -= 61 * 60_000; // 마지막으로 쓴 지 61분
  await renewLease(owner, { runnerUsable: true });
  assert.ok((await waitFile((d) => d.accounts[ACCT].at > first)).accounts[ACCT].at > first, '한 시간이 지나면 고쳐 쓴다');
});

/* ───────────── B — 확인된 보유자의 다시 쓰기 80초 ───────────── */

test('B: 상수 — 다시 쓰기 80초(TTL 120초의 2/3), TTL·넘겨받기 대기·확인 기한은 그대로(옛 판과 섞여 쓰므로)', () => {
  assert.equal(LEASE_RENEW_MS, 80_000);
  assert.equal(LEASE_TTL_MS, 120_000);
  assert.equal(HANDOVER_WAIT_MS, 22_000);
  assert.equal(LEASE_CONFIRM_VALID_MS, 18_000);
  assert.ok(LEASE_RENEW_MS + LEASE_SOLO_READ_MS + LEASE_SOLO_READ_MS < LEASE_TTL_MS - MARGIN, '다시 쓰기 한 번 실패해도 다음 판정에 내 글 만료 전 다시 쓴다');
});

for (const [name, peerAgo, step, expectPuts] of [['단일 기기(15초 박자)', null, LEASE_SOLO_READ_MS, 40], ['엄격 판정(8초 박자)', 0, 8_000, 45]]) {
  test(`B: 쉬는 보유자 1시간 — ${name} 쓰기 시간당 ${expectPuts}번(60초면 ${name.startsWith('단일') ? 60 : 56}번), 갱신 뒤 확인 읽기 없음, 담당 끊김 0`, async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `o-b-${step}`;
    holder(f, owner, { peerAgo });
    assert.equal(leaseReadInterval(), step);
    const each = await loop(owner, H);
    assert.ok(Math.abs(f.n.put - expectPuts) <= 1, `1시간 쓰기 ${f.n.put}번`);
    assert.equal(f.n.get, each.length);
    assert.deepEqual(each.filter((x) => !x), []);
  });
}

/** 다른 기기가 매초 본 이 보유자의 글 나이 최댓값(이 보유자 시계) — 시계 차이 여유 = TTL − 이 값. */
async function maxDocAge(owner, peerAgo, durMs = H) {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  holder(f, owner, { peerAgo });
  let next = Date.now() + leaseReadInterval(); let oldest = 0;
  for (let t = 0; t < durMs; t += 1_000) {
    mock.timers.tick(1_000); awakeNow(null);
    oldest = Math.max(oldest, Date.now() - f.get(KEY(owner)).ts);
    if (Date.now() >= next) { await renewLease(owner, { runnerUsable: true }); next = Date.now() + leaseReadInterval(); }
  }
  mock.timers.reset();
  return oldest;
}

test('B 위험(시계 차이) — 다른 기기가 보는 글 나이 상한은 80초 + 판정 간격(15초 박자 90초, 8초 박자 80초) → 시계 차이 여유 25초 이상', async () => {
  for (const [peerAgo, step] of [[null, LEASE_SOLO_READ_MS], [0, 8_000]]) {
    const oldest = await maxDocAge(`o-b-age-${step}`, peerAgo);
    assert.ok(oldest <= LEASE_RENEW_MS + step, `${step / 1000}초 박자: 글 나이 상한 ${oldest / 1000}초`);
    assert.ok(LEASE_TTL_MS - oldest >= 25_000, `${step / 1000}초 박자: 시계 차이 여유 ${(LEASE_TTL_MS - oldest) / 1000}초 — 설계 노트의 25초 아래로 줄면 안 된다(90초 갱신이면 15초)`);
  }
});

test('B 위험(시계 차이) — 같은 역할의 다른 기기 시계가 20초 앞서면 1시간 동안 가져가지 않고, 35초 앞서 가져가면 이 보유자는 다음 읽기(≤ 15초)에 물러난다', async () => {
  const run = async (skew) => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `o-b-skew-${skew}`;
    holder(f, owner);
    let next = Date.now() + leaseReadInterval(); let tookAt = 0; let overlap = 0;
    for (let t = 0; t < H; t += 1_000) {
      mock.timers.tick(1_000); awakeNow(null);
      const cur = f.get(KEY(owner));
      // 다른 기기(새 판·옛 판 같은 규칙): 제 시계(= 이 보유자 + skew)로 글이 만료됐으면 가져가 바로 담당(만료 글은 넘겨받기 대기 없음)
      if (!tookAt && cur.deviceId === ME && Date.now() + skew - cur.ts >= LEASE_TTL_MS) { tookAt = Date.now(); f.set(KEY(owner), { deviceId: OTHER, token: 'o', ts: Date.now() + skew }); }
      if (Date.now() >= next) { await renewLease(owner, { runnerUsable: true }); next = Date.now() + leaseReadInterval(); }
      if (tookAt && isCloudLeader()) overlap += 1_000;
      if (tookAt && !lease().leader) break;
    }
    mock.timers.reset();
    return { tookAt, overlap };
  };
  assert.equal((await run(20_000)).tookAt, 0, '시계 차이 20초 — 가져가지 않는다(이중 담당 0)');
  const r = await run(35_000);
  assert.ok(r.tookAt > 0, '시계 차이 35초 — 만료로 보고 가져간다(받아들인 위험의 재현)');
  assert.ok(r.overlap <= LEASE_SOLO_READ_MS, `함께 담당 ${r.overlap / 1000}초 ≤ 다음 읽기 ${LEASE_SOLO_READ_MS / 1000}초`);
});
