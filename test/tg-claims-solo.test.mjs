// 혼자 쓰는 기기의 긴 텔레그램 클레임(2026-10-31 로그 수집 126% — 토큰 20개 계정 하나가 파일마다 약 1.8분에 한 번 다시 써 2시간에 약 1,320회, 한 기기·한 프로세스).
// 다른 기기를 본 적 없는 확인된 리스 보유자는 리스에 묶인 긴 글({ lease: true, ttl: 20분 })을 15분마다 다시 쓰고, 판정(목록 1회)은 60초마다 한다.
// 새 판 읽는 쪽은 글 주인이 지금 살아 있는 리스 보유자일 때만 긴 ttl을 인정한다(claimTtlFor). 경우 표: PR 본문 S1~S11.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tgsolo-'));
process.env.ARGO_SYNC = '1';
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-solo', email: '' } }), { mode: 0o600 });
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER']) delete process.env[k];
const sync = await import('../src/sync.mjs');
const { setClaimTokens, renewTokenClaims, tokenOwnership, tokenClaimHash, claimTtlFor, _setSyncClientForTest, _resetTokenClaimsForTest,
  TG_CLAIM_TTL_MS, LEASE_TTL_MS, CLAIM_SOLO_TTL_MS, CLAIM_SOLO_REWRITE_MS, CLAIM_SOLO_RENEW_MS } = sync;
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();
const ACCT = 'u-solo';
const OWNER = 'owner-solo';
const KEY = (tok) => `${OWNER}/.tg-claims/${tokenClaimHash(tok)}.json`;
afterEach(() => mock.timers.reset());

/** 가짜 저장소 — 목록(eTag = 본문 MD5, S3와 같음)까지 흉내 내고 요청을 종류별로 센다. */
function fakeStore() {
  const objs = new Map(); const n = { put: 0, get: 0, list: 0, del: 0 };
  const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
  const bucket = {
    async download(key) { n.get += 1; const b = objs.get(String(key).split('?')[0]); return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } }; },
    async upload(key, blob) { n.put += 1; objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
    async remove(keys) { for (const k of keys) { n.del += 1; objs.delete(k); } return { data: [], error: null }; },
    async list(prefix) {
      n.list += 1;
      const out = [];
      for (const [k, b] of objs) if (k.startsWith(`${prefix}/`)) out.push({ name: k.slice(prefix.length + 1), metadata: { eTag: `"${createHash('md5').update(b).digest('hex')}"` } });
      return { data: out, error: null };
    },
  };
  return { client: { storage: { from: () => bucket } }, n, get: (k) => { const b = objs.get(k); return b ? JSON.parse(b.toString()) : null; }, set: (k, doc) => objs.set(k, Buffer.from(JSON.stringify(doc))) };
}
const lease = () => (globalThis.__argoSyncLease ??= {});
/** 이 기기가 리스를 보유 중(리스 판정이 60초마다 다시 써 ownedAt이 새것) — sawPeer면 다른 기기를 본 적 있는 계정(엄격 판정, 혼자 모드 아님). */
function holdLease({ sawPeer = false } = {}) {
  Object.assign(lease(), { leader: true, ownedAt: Date.now(), checkedAt: Date.now(), validUntil: Date.now() + 10_000, holder: { deviceId: ME, ts: Date.now() },
    peers: sawPeer ? { [ACCT]: { at: Date.now(), normals: [] } } : {}, peersSavedAt: {} });
}
const TOKENS = Array.from({ length: 20 }, (_, i) => `tok-${i}`);

/** 기기 1대·토큰 20개를 durMs 동안 돌린다 — 동기화 사이클(8초)마다 갱신을 부르고(레이트리밋이 실제 판정 간격을 정한다), 리스는 늘 새로 보유. */
async function runDevice({ sawPeer, durMs = 30 * 60_000 }) {
  _resetTokenClaimsForTest(); globalThis.__argoTgClaimReadFail?.clear(); globalThis.__argoTgClaimList?.clear();
  globalThis.__argoTgClaimListState && (globalThis.__argoTgClaimListState.offUntil = -Infinity);
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const t0 = Date.now(); mock.timers.enable({ apis: ['Date'], now: t0 });
  holdLease({ sawPeer }); setClaimTokens(TOKENS);
  await renewTokenClaims(OWNER, { now: Date.now() }); // 첫 획득
  const start = { ...f.n }; let lost = 0;
  for (let el = 0; el < durMs; el += 8_000) {
    mock.timers.tick(8_000); holdLease({ sawPeer });
    await renewTokenClaims(OWNER, { now: Date.now() });
    for (const t of TOKENS) if (!tokenOwnership(t).mine) lost += 1;
  }
  mock.timers.reset();
  const mins = durMs / 60_000;
  const per = Object.fromEntries(Object.keys(f.n).map((k) => [k, (f.n[k] - start[k]) / mins]));
  return { per, total: Object.values(per).reduce((a, b) => a + b, 0), lost, f };
}

test('S1·S9 — 혼자 쓰는 기기, 토큰 20개, 30분: 클레임 Storage 요청이 종전 규칙의 1/5 이하, 수신은 끊기지 않는다', async () => {
  const before = await runDevice({ sawPeer: true }); // 종전 규칙(판정 30초·다시 쓰기 40초) = 고치기 전과 같은 요청
  const after = await runDevice({ sawPeer: false });
  const fmt = (r) => `put ${r.per.put.toFixed(2)} get ${r.per.get.toFixed(2)} list ${r.per.list.toFixed(2)} = ${r.total.toFixed(2)}/분`;
  console.log(`[tg-solo] 토큰 20개·기기 1대 분당 클레임 요청 — 종전 ${fmt(before)} / 혼자 모드 ${fmt(after)}`);
  assert.equal(before.lost, 0); assert.equal(after.lost, 0, '혼자 모드에서도 소유가 끊긴 판정 없음');
  assert.ok(after.total * 5 <= before.total, `1/5 이하: ${after.total.toFixed(2)} × 5 ≤ ${before.total.toFixed(2)}`);
  const doc = after.f.get(KEY('tok-0'));
  assert.equal(doc.lease, true); assert.equal(doc.ttl, CLAIM_SOLO_TTL_MS); assert.equal(doc.deviceId, ME);
  assert.equal(before.f.get(KEY('tok-0')).lease, undefined, '종전 규칙의 글에는 리스 표시가 없다(옛 판과 같은 모양)');
});

test('S7·S8 — claimTtlFor: 글 주인이 지금 살아 있는 리스 보유자일 때만 긴 ttl(상한 20분), 그 밖은 종전 TTL', () => {
  const now = 1_800_000_000_000;
  const doc = { deviceId: 'A', ts: now - 10 * 60_000, lease: true, ttl: CLAIM_SOLO_TTL_MS };
  assert.equal(claimTtlFor(doc, { deviceId: 'A', ts: now - 30_000 }, now), CLAIM_SOLO_TTL_MS, '살아 있는 리스 보유자');
  assert.equal(claimTtlFor(doc, { deviceId: 'A', ts: now - LEASE_TTL_MS }, now), TG_CLAIM_TTL_MS, '리스 만료(주인이 꺼짐) → 종전 TTL');
  assert.equal(claimTtlFor(doc, { deviceId: 'B', ts: now }, now), TG_CLAIM_TTL_MS, '리스 보유자가 다른 기기');
  assert.equal(claimTtlFor(doc, null, now), TG_CLAIM_TTL_MS, 'S7 리스를 못 읽음');
  assert.equal(claimTtlFor({ ...doc, lease: undefined }, { deviceId: 'A', ts: now }, now), TG_CLAIM_TTL_MS, '종전 글');
  assert.equal(claimTtlFor({ ...doc, ttl: 10 * 86_400_000 }, { deviceId: 'A', ts: now }, now), CLAIM_SOLO_TTL_MS, 'S8 ttl 상한');
});

/** 다른 기기 A의 긴 글이 있는 토큰을 이 기기(B, 새 판)가 판정한다. */
async function judgeOthersSoloDoc({ leaseHolderAgeMs }) {
  _resetTokenClaimsForTest(); globalThis.__argoTgClaimList?.clear();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const t0 = Date.now(); mock.timers.enable({ apis: ['Date'], now: t0 });
  f.set(KEY('shared'), { deviceId: 'A-PC-deadbeef', nonce: 'a', ts: t0 - 10 * 60_000, lease: true, ttl: CLAIM_SOLO_TTL_MS }); // 10분 전에 쓴 긴 글
  Object.assign(lease(), { leader: false, ownedAt: 0, holder: { deviceId: 'A-PC-deadbeef', ts: t0 - leaseHolderAgeMs }, peers: { [ACCT]: { at: t0, normals: [] } } });
  setClaimTokens(['shared']);
  await renewTokenClaims(OWNER, { now: t0 });
  return { f, own: tokenOwnership('shared') };
}

test('S3 — 새 판 B는 A의 리스가 살아 있으면 A의 긴 글(10분 전)을 존중한다: 쓰기 0, 겹침 0', async () => {
  const { f, own } = await judgeOthersSoloDoc({ leaseHolderAgeMs: 30_000 });
  assert.equal(f.n.put, 0, '남의 글을 덮지 않는다');
  assert.deepEqual({ mine: own.mine, holder: own.holder }, { mine: false, holder: 'A-PC-deadbeef' });
});

test('S4 — A가 꺼져 리스가 만료(120초)되면 B는 A의 긴 글을 종전 TTL로 보고 넘겨받는다', async () => {
  const { f, own } = await judgeOthersSoloDoc({ leaseHolderAgeMs: LEASE_TTL_MS + 1_000 });
  assert.equal(f.n.put, 1, '넘겨받기 쓰기');
  assert.equal(own.mine, true);
  assert.equal(f.get(KEY('shared')).deviceId, ME);
});

test('S5 — 옛 판 기기가 같은 토큰을 가져가면(긴 글을 120초 만료로 봄) 혼자 모드 보유자는 다음 판정(≤60초)에 물러난다', async () => {
  _resetTokenClaimsForTest(); globalThis.__argoTgClaimList?.clear();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const t0 = Date.now(); mock.timers.enable({ apis: ['Date'], now: t0 });
  holdLease(); setClaimTokens(['shared']);
  await renewTokenClaims(OWNER, { now: Date.now() });
  assert.equal(tokenOwnership('shared').mine, true);
  mock.timers.tick(5 * 60_000); holdLease(); await renewTokenClaims(OWNER, { now: Date.now() }); // 판정 시각을 맞춘다
  // 옛 판 B: 글 나이(5분)가 120초를 넘어 만료로 보고 자기 글을 쓴다(lease·ttl 없음)
  const tOld = Date.now() + 1_000;
  let overlap = 0; let yielded = null;
  for (let s = 1; s <= 120; s++) {
    mock.timers.tick(1_000); holdLease();
    if (Date.now() === tOld) f.set(KEY('shared'), { deviceId: 'Old-PC-00000000', nonce: 'o', ts: tOld });
    if (s % 8 === 0) await renewTokenClaims(OWNER, { now: Date.now() }); // 동기화 사이클 8초
    if (Date.now() >= tOld) { if (tokenOwnership('shared').mine) overlap += 1; else yielded ??= Date.now() - tOld; }
  }
  console.log(`[tg-solo] 옛 판 기기가 가져간 뒤 혼자 모드 보유자가 물러날 때까지 ${overlap}초`);
  assert.ok(yielded != null, '물러났다');
  assert.ok(overlap <= CLAIM_SOLO_RENEW_MS / 1000 + 8, `겹침 ${overlap}초 ≤ 판정 60초 + 사이클 8초`);
  assert.equal(tokenOwnership('shared').holder, 'Old-PC-00000000');
});

test('S6·S10 — 혼자 모드에서 다른 기기를 보게 되면 종전 규칙(판정 30초·다시 쓰기 40초)으로 돌아가 종전 글로 바꿔 쓰고, 다시 혼자가 되면 첫 판정에 긴 글로 한 번 바꿔 쓴다', async () => {
  _resetTokenClaimsForTest(); globalThis.__argoTgClaimList?.clear();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const t0 = Date.now(); mock.timers.enable({ apis: ['Date'], now: t0 });
  holdLease(); setClaimTokens(['x']);
  await renewTokenClaims(OWNER, { now: Date.now() });
  assert.equal(f.get(KEY('x')).lease, true, '혼자 모드 — 긴 글');
  mock.timers.tick(31_000); holdLease({ sawPeer: true });
  await renewTokenClaims(OWNER, { now: Date.now() });
  assert.equal(f.get(KEY('x')).lease, true, '종전 규칙 — 글 나이 40초 안이면 다시 쓰지 않는다');
  mock.timers.tick(30_000); holdLease({ sawPeer: true });
  await renewTokenClaims(OWNER, { now: Date.now() });
  assert.equal(f.get(KEY('x')).lease, undefined, 'S6 다른 기기를 봄 — 종전 다시 쓰기 시점(40초)에 종전 글로 바꿔 씀');
  assert.equal(tokenOwnership('x').mine, true);
  const puts = f.n.put;
  mock.timers.tick(61_000); holdLease();
  await renewTokenClaims(OWNER, { now: Date.now() });
  assert.equal(f.n.put, puts + 1, 'S10 혼자 모드 전환 첫 판정 — 한 번 다시 씀');
  assert.equal(f.get(KEY('x')).lease, true);
  mock.timers.tick(CLAIM_SOLO_REWRITE_MS - 120_000); holdLease();
  await renewTokenClaims(OWNER, { now: Date.now() });
  assert.equal(f.n.put, puts + 1, '15분 안에는 다시 쓰지 않는다');
});

test('S9 — 혼자 모드 보유자의 소유 시각 상한은 내 글 ts + 20분 − 4초(판정이 멈춰도 무기한 mine이 아니다)', async () => {
  _resetTokenClaimsForTest(); globalThis.__argoTgClaimList?.clear();
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const t0 = Date.now(); mock.timers.enable({ apis: ['Date'], now: t0 });
  holdLease(); setClaimTokens(['cap']);
  await renewTokenClaims(OWNER, { now: t0 });
  mock.timers.tick(CLAIM_SOLO_TTL_MS - 4_000 - 1);
  assert.equal(tokenOwnership('cap').mine, true);
  mock.timers.tick(1);
  assert.deepEqual(tokenOwnership('cap'), { mine: false, holder: null, pending: true });
});
