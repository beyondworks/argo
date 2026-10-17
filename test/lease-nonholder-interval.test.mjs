// 엄격 판정(다른 기기를 본 적 있는 계정·예비 기기)의 담당이 아닌 기기만 리스를 30초마다 읽는다(2026-10-17 로그 비용 — 리스·클레임 요청이 남은 로그의 약 55%,
// 기기 두 대 실측: 담당·비담당 모두 _device-lease.json 분당 7.7회). 담당은 8초 그대로다 — 엄격 판정의 담당은 확인 기한(LEASE_CONFIRM_VALID_MS 18초) 안에
// 자기 글을 다시 읽어야 담당으로 남고, 넘겨받는 쪽의 대기(HANDOVER_WAIT_MS 22초)는 옛 앱에도 박혀 있어 늘릴 수 없다(경우 표 V2).
// 다른 기기는 가짜 저장소에 리스 글을 쓰는 것으로 흉내 낸다. 이 기기는 리스 타이머처럼 leaseReadInterval()만큼 시계를 넘기며 판정한다(lease-log-cadence와 같은 틀).
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-idle-'));
process.env.ARGO_SYNC = '1';
const ACCT = 'u-idle';
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ACCT, email: '' } }));
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_SYNC_CYCLE_MS']) delete process.env[k];
const sync = await import('../src/sync.mjs');
const { renewLease, isCloudLeader, leaseReadInterval, _setSyncClientForTest, LEASE_TTL_MS, LEASE_RENEW_MS, HANDOVER_WAIT_MS, LEASE_CONFIRM_VALID_MS, YIELD_GRACE_MS, LEASE_SOLO_READ_MS } = sync;
const LEASE_IDLE_READ_MS = sync.LEASE_IDLE_READ_MS ?? 8_000; // 이 변경 전 코드에는 상수가 없다 — 전에는 담당 아닌 기기도 8초
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();
const OTHER = 'Other-Mac-0000aaaa';

const fakeStore = () => {
  const objs = new Map();
  const byKey = new Map();
  const count = (op, key) => { const k = `${op} ${String(key).split('?')[0]}`; byKey.set(k, (byKey.get(k) || 0) + 1); };
  const body = (buf) => ({ data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null });
  const bucket = {
    async download(key) { count('GET', key); const b = objs.get(String(key).split('?')[0]); return b ? body(b) : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } }; },
    async upload(key, blob) { count('PUT', key); objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
    async remove(keys) { for (const k of keys) objs.delete(k); return { data: [], error: null }; },
  };
  return {
    client: { storage: { from: () => bucket } },
    n: (op, key) => byKey.get(`${op} ${key}`) || 0,
    get: (key) => { const b = objs.get(key); return b ? JSON.parse(b.toString()) : null; },
    set: (key, doc) => { objs.set(key, Buffer.from(JSON.stringify(doc))); },
  };
};
const KEY = (owner) => `${owner}/_device-lease.json`;
const lease = () => globalThis.__argoSyncLease;
const awakeNow = (sinceAgo = 10 * 60_000) => {
  const a = (globalThis.__argoSyncAwake ??= {});
  if (a.timer && typeof a.timer !== 'string') clearInterval(a.timer);
  Object.assign(a, { timer: 'test', wall: Date.now(), mono: performance.now(), wokeAt: a.wokeAt ?? 0 });
  if (sinceAgo != null) a.since = Date.now() - sinceAgo;
};
const peers = (sawPeer) => (sawPeer ? { peers: { [ACCT]: { at: Date.now(), normals: [OTHER] } }, peersSavedAt: { [ACCT]: Date.now() } } : { peers: {}, peersSavedAt: {} });
/** 이 기기 = 확인된 담당(방금 내 글을 쓰고 확인함). */
const asHolder = (f, owner, { sawPeer = true } = {}) => {
  const token = `t-${owner}`;
  f.set(KEY(owner), { deviceId: ME, token, ts: Date.now() });
  awakeNow(); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000;
  Object.assign(lease() ?? (globalThis.__argoSyncLease = {}), { leader: true, ownedAt: Date.now(), checkedAt: Date.now(), yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false,
    token, validUntil: Date.now() + LEASE_CONFIRM_VALID_MS, holder: null, followAt: 0, ...peers(sawPeer) });
};
/** 이 기기 = 담당 아님, 다른 기기(OTHER)가 방금 쓴 살아 있는 리스. */
const asFollower = (f, owner, { sawPeer = true } = {}) => {
  f.set(KEY(owner), { deviceId: OTHER, token: 't-other', ts: Date.now() });
  awakeNow(); globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000;
  const judged = Date.now();
  Object.assign(lease() ?? (globalThis.__argoSyncLease = {}), { leader: false, ownedAt: 0, checkedAt: judged, followAt: judged, yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false,
    token: null, validUntil: 0, holder: { deviceId: OTHER, ts: Date.now() }, ...peers(sawPeer) }); // 방금 남의 살아 있는 글을 읽고 양보했다(followAt = checkedAt)
};
afterEach(() => { mock.timers.reset(); delete process.env.ARGO_STANDBY_LEADER; });

/** 리스 타이머 흉내 — leaseReadInterval()만큼 시계를 넘기고 판정한다(첫 걸음만 firstStep으로 바꿀 수 있다). onStep()은 판정 전에(다른 기기의 쓰기 등). 판정마다 { t, step, leader, pending } */
async function loop(owner, durMs, { onStep = () => {}, firstStep = null } = {}) {
  const out = []; let t = 0;
  while (t < durMs) {
    const step = out.length === 0 && firstStep != null ? firstStep : leaseReadInterval(); t += step; mock.timers.tick(step); awakeNow(null);
    onStep(t);
    await renewLease(owner, { runnerUsable: true });
    out.push({ t, step, leader: isCloudLeader(), pending: !!lease().pending });
  }
  return out;
}

test('간격 표 — 엄격 판정의 담당 아닌 기기만 30초, 담당·넘겨받는 중·읽기 실패 중·단일 기기는 그대로', () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  assert.equal(LEASE_IDLE_READ_MS, 30_000, '운영 값 30초');
  asHolder(f, 'o-iv'); assert.equal(leaseReadInterval(), 8_000, '엄격 판정의 담당 — 확인 기한 18초 안에 다시 읽어야 한다');
  asFollower(f, 'o-iv'); assert.equal(leaseReadInterval(), 30_000, '엄격 판정의 담당 아님');
  asFollower(f, 'o-iv'); lease().pending = { token: 'p', ts: Date.now() }; assert.equal(leaseReadInterval(), 8_000, '넘겨받는 중 — 대기 22초가 끝나는 대로 확인');
  asFollower(f, 'o-iv'); lease().readFailSince = Date.now(); assert.equal(leaseReadInterval(), 8_000, '읽기 실패 중');
  asFollower(f, 'o-iv'); process.env.ARGO_STANDBY_LEADER = '1'; assert.equal(leaseReadInterval(), 30_000, '예비 기기의 담당 아님');
  asHolder(f, 'o-iv'); assert.equal(leaseReadInterval(), 8_000, '예비 기기의 담당');
  delete process.env.ARGO_STANDBY_LEADER;
  asHolder(f, 'o-iv', { sawPeer: false }); assert.equal(leaseReadInterval(), LEASE_SOLO_READ_MS, '단일 기기 담당 15초(종전)');
  asFollower(f, 'o-iv', { sawPeer: false }); assert.equal(leaseReadInterval(), 8_000, '단일 기기 판정의 담당 아님(종전)');
});

test('불변식 — 담당 아닌 간격은 TTL의 1/4 이하, 러너 양보의 여유(YIELD_GRACE − TTL = 40초)보다 짧다', () => {
  assert.ok(LEASE_IDLE_READ_MS <= LEASE_TTL_MS / 4, `${LEASE_IDLE_READ_MS} ≤ TTL/4`);
  assert.ok(LEASE_IDLE_READ_MS < YIELD_GRACE_MS - LEASE_TTL_MS, '양보 기한이 끝나기 전에 판정이 한 번 남는다');
  assert.ok(LEASE_CONFIRM_VALID_MS < HANDOVER_WAIT_MS, '담당 쪽 상수는 그대로(옛 앱과 같은 값)');
  assert.equal(HANDOVER_WAIT_MS, 22_000); assert.equal(LEASE_CONFIRM_VALID_MS, 18_000);
});

test('담당의 갱신 주기 — 다른 기기가 있는 계정의 담당은 10분 동안 8초마다 읽고 60초마다 쓰며, 담당이 한 번도 끊기지 않는다', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-holder'; asHolder(f, owner);
  const each = await loop(owner, 10 * 60_000);
  assert.deepEqual([...new Set(each.map((x) => x.step))], [8_000], '담당의 판정 간격은 8초뿐');
  assert.deepEqual(each.filter((x) => !x.leader).map((x) => x.t), [], '담당이 끊긴 판정 없음(확인 기한 18초)');
  assert.equal(f.n('GET', KEY(owner)), each.length);
  const puts = f.n('PUT', KEY(owner)); assert.ok(puts >= 8 && puts <= 10, `쓰기 ${puts}번 — 60초에 한 번`);
});

test('담당 아닌 기기 — 다른 기기가 60초마다 갱신하는 10분 동안 리스를 30초마다만 읽고, 쓰지 않고, 담당이 되지 않는다', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-follow'; asFollower(f, owner);
  let lastRenew = Date.now();
  const each = await loop(owner, 10 * 60_000, { onStep: () => {
    if (Date.now() - lastRenew >= LEASE_RENEW_MS) { lastRenew = Date.now(); f.set(KEY(owner), { deviceId: OTHER, token: 't-other', ts: lastRenew }); }
  } });
  const gets = f.n('GET', KEY(owner));
  assert.equal(gets, 20, `10분 읽기 ${gets}번 — 30초마다(종전 8초면 75번)`);
  assert.equal(f.n('PUT', KEY(owner)), 0, '살아 있는 남의 리스는 쓰지 않는다');
  assert.deepEqual(each.filter((x) => x.leader).map((x) => x.t), [], '두 기기가 동시에 담당인 순간 없음');
});

test('넘김 시간 상한 — 담당이 꺼지면(마지막 갱신 뒤 쓰기 없음) 담당 아닌 기기는 TTL 뒤, TTL + 30초 + 확인 안에 담당이 된다. TTL 전에는 절대 아니다', async () => {
  for (const frac of [0.05, 0.5, 0.95]) { // 다른 기기의 마지막 갱신이 이 기기의 판정 박자 어디에 걸리든(간격의 앞·가운데·끝)
    const phase = Math.round(LEASE_IDLE_READ_MS * frac);
    mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fakeStore(); _setSyncClientForTest(f.client);
    const owner = `o-handover-${frac}`; asFollower(f, owner); // 방금 판정했다(t=0)
    mock.timers.tick(phase); const lastWrite = Date.now(); f.set(KEY(owner), { deviceId: OTHER, token: 't-other', ts: lastWrite }); // 다른 기기의 마지막 갱신 — 이 뒤로 꺼졌다
    const each = await loop(owner, LEASE_TTL_MS + 3 * 60_000, { firstStep: LEASE_IDLE_READ_MS - phase }); // 다음 판정은 마지막 판정 + 간격
    const first = each.find((x) => x.leader);
    assert.ok(first, `phase ${phase}: 결국 담당이 된다`);
    const at = first.t; // loop의 t는 마지막 갱신 시각부터 잰다
    assert.ok(at >= LEASE_TTL_MS, `phase ${phase}: ${at / 1000}초 — TTL(120초) 전에 가져가면 앞 담당과 겹친다`);
    assert.ok(at <= LEASE_TTL_MS + 30_000 + 2_000, `phase ${phase}: ${at / 1000}초 ≤ TTL + 30초(+ 확인 읽기 여유) — 넘김 최악을 152초로 묶는다(상수가 바뀌어도 이 상한은 그대로)`);
    assert.deepEqual(each.filter((x) => x.leader && x.t < LEASE_TTL_MS), [], '겹침 0');
    assert.equal(f.get(KEY(owner)).deviceId, ME, '이 기기의 글');
    assert.equal(leaseReadInterval(), 8_000, '담당이 되면 8초로 돌아온다');
  }
});

test('넘겨받는 중(우선 기기가 일반 기기의 살아 있는 리스를 가져옴)은 8초로 확인하고, 쓴 뒤 대기 22초가 지나기 전에는 담당이 아니다', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-preempt'; asFollower(f, owner);
  process.env.ARGO_PREFER_LEADER = '1';
  try {
    const each = await loop(owner, 3 * 60_000);
    const w = each.findIndex((x) => x.pending);
    assert.ok(w >= 0, '살아 있는 리스를 가져와 넘겨받기를 시작한다');
    const s = each.findIndex((x) => x.leader);
    assert.ok(s > w, '그 뒤에 담당이 된다');
    assert.deepEqual([...new Set(each.slice(w + 1, s + 1).map((x) => x.step))], [8_000], '넘겨받는 동안 판정은 8초 간격');
    assert.ok(each[s].t - each[w].t >= HANDOVER_WAIT_MS, `쓴 뒤 ${(each[s].t - each[w].t) / 1000}초 — 대기 22초 전에는 담당이 아니다(앞 담당이 물러날 시간)`);
    assert.ok(each[s].t - each[w].t <= HANDOVER_WAIT_MS + 8_000, '대기가 끝난 뒤 첫 판정(8초 안)');
  } finally { delete process.env.ARGO_PREFER_LEADER; }
});

/* ── 검수 2(2026-10-17): 30초는 방금 남의 살아 있는 글을 읽고 양보한 판정 뒤에만. 그 밖의 '담당 아님'은 8초(배포본) ── */

test('R2 — 담당 기기의 프로세스 재시작으로 옛 실행 락이 살아 있어 첫 판정이 읽기 없이 끝나면(담당 아님·미확인) 다음 판정은 8초다', () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  asHolder(f, 'o-r2'); // 이 기기가 담당이던 계정(다른 기기를 본 적 있음) — 새 프로세스는 기동 상태(followAt 없음)
  Object.assign(lease(), { leader: false, ownedAt: 0, validUntil: 0, checkedAt: Date.now() }); // leaseTick: 실행 리스 미보유 분기(리스 읽기 없음)가 남긴 상태
  assert.equal(leaseReadInterval(), 8_000, '30초면 다른 기기는 이 기기의 살아 있는 글에 양보한 채 계정 전체 담당 공백이 재시작마다 +6~22초');
  asFollower(f, 'o-r2'); assert.equal(leaseReadInterval(), 30_000, '같은 프로세스 — 방금 양보했다');
  lease().checkedAt = lease().followAt + 1; // 그 뒤 실행 리스를 잃어 읽기 없는 판정이 한 번 돌았다(leaseTick 2124 분기 — checkedAt만 새로 찍는다)
  assert.equal(leaseReadInterval(), 8_000, '양보 판정 뒤 다른 판정이 끼면 8초');
});

test('남의 살아 있는 글을 읽고 양보한 판정 바로 뒤에만 30초', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-follow-now'; asHolder(f, owner);
  Object.assign(lease(), { leader: false, ownedAt: 0, validUntil: 0, followAt: 0 });
  f.set(KEY(owner), { deviceId: OTHER, token: 't-other', ts: Date.now() - 5_000 });
  assert.equal(leaseReadInterval(), 8_000, '판정 전 — 8초');
  await renewLease(owner, { runnerUsable: true });
  assert.equal(isCloudLeader(), false);
  assert.equal(leaseReadInterval(), 30_000, '양보 직후 — 30초');
});

test('Y3 — 만료 글 + 러너 없음으로 양보 중인 기기는 8초로 읽는다(러너 있는 다른 기기가 먼저 잡을 여유를 줄이지 않는다)', async () => {
  const f = fakeStore(); _setSyncClientForTest(f.client);
  const owner = 'o-y3'; asFollower(f, owner);
  f.set(KEY(owner), { deviceId: OTHER, token: 't-other', ts: Date.now() - LEASE_TTL_MS - 1_000 }); // 만료 — 원래면 가져갈 차례
  await renewLease(owner, { runnerUsable: false });
  assert.equal(isCloudLeader(), false, '러너가 없어 양보 중');
  assert.ok(lease().yieldSince > 0);
  assert.equal(leaseReadInterval(), 8_000);
});
