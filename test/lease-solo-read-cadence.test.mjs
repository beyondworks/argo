// 혼자 쓰는 보유자의 리스 읽기 간격(2026-11-02 운영 edge 로그 24시간 56.1만 건 중 _device-lease.json 18.1만 건, 32%).
// 읽기 간격의 상한은 넘겨받는 기기의 대기(HANDOVER_WAIT_MS 22초)다 — 그 값은 0.1.118 이후 옛 판에 박혀 있어 새 판에서 넘겨받는 쪽을 늘려도 옛 판 argo run에는 듣지 않는다.
// 그래서 인계 하네스(test/helpers/lease-preempt.mjs: A는 실제 코드, B는 옛 판 넘겨받기 모형)로 겹침·인계 시간을 잠그고, 가져갈 기기가 없는 최고 역할만 더 늘린다.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'argo-lease-solo-'));
const harness = (env) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [fileURLToPath(new URL('./helpers/lease-preempt.mjs', import.meta.url))], { env: { ...process.env, ARGO_SYNC_CYCLE_MS: '', NODE_TEST_CONTEXT: '', TMPDIR: tmp, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
  const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${out.slice(-1500)}`)); }, 300_000);
  p.on('exit', () => { clearTimeout(t); const l = out.split('\n').find((x) => x.startsWith('@@')); if (!l) return reject(new Error(`no result\n${out.slice(-1500)}`)); resolve(JSON.parse(l.slice(2))); });
});

/* ── 인접 행동 핀(읽기 간격을 바꾸기 전에 main에서도 통과) ── */

for (const lat of ['300', '3000']) {
  test(`핀: 옛 판 넘겨받기(대기 22초, 가장 나쁜 하한)가 살아 있는 일반 보유자의 리스를 어느 위상에 가져가도 겹침 0 — 읽기 지연 ${lat}ms`, async () => {
    const r = await harness({ READ_LAT_MS: lat, WRITE_LAT_MS: '300', GRID: '0' });
    assert.equal(r.maxOverlapMs, 0, JSON.stringify(r));
    assert.ok(r.runs - r.lost > 300, JSON.stringify(r));
    assert.ok(r.maxStepDownMs < r.minBStartMs, `앞 담당이 먼저 물러난다: ${JSON.stringify(r)}`);
  });
}

test('핀: 인계 시간은 읽기 간격과 무관하다 — 쓴 글이 닿은 뒤 새 담당이 시작하기까지 약 22~24초', async () => {
  for (const [grid, lo, hi] of [['0', 22_000, 22_500], ['1', 23_000, 24_000]]) {
    const r = await harness({ READ_LAT_MS: '300', WRITE_LAT_MS: '300', GRID: grid });
    assert.ok(r.minBStartMs >= lo && r.maxBStartMs <= hi, JSON.stringify(r));
  }
});

test('핀: 쉬는 일반 보유자 — 담당이 끊기지 않고 내 글은 내 만료(116초) 전에 다시 쓴다(응답 지연 300ms)', async () => {
  const r = await harness({ MODE: 'idle', READ_LAT_MS: '300' });
  assert.equal(r.leaderOffSamples, 0, JSON.stringify(r));
  assert.ok(r.lastDocAgeMs < 90_000, JSON.stringify(r));
});

/* ── 바꾼 값 ── */

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-solo-root-'));
process.env.ARGO_SYNC = '1';
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_SYNC_CYCLE_MS']) delete process.env[k];
writeFileSync(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-solo', email: '' } }), { mode: 0o600 });
const sync = await import('../src/sync.mjs');
const { renewLease, leaseReadInterval, renewTokenClaims, setClaimTokens, _setSyncClientForTest, _resetTokenClaimsForTest, LEASE_RENEW_MS, HANDOVER_WAIT_MS } = sync;
const { getDeviceId } = await import('../src/workspace.mjs');
const ME = await getDeviceId();
const lease = () => globalThis.__argoSyncLease;
const OWNER = 'o-solo'; const LK = `${OWNER}/_device-lease.json`;
afterEach(() => { mock.timers.reset(); delete process.env.ARGO_PREFER_LEADER; });

const store = () => {
  const objs = new Map(); const n = { list: 0, put: 0 }; let failPut = false;
  const bucket = {
    async download(key) { const b = objs.get(String(key).split('?')[0]); return b ? { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null } : { data: null, error: { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' } }; },
    async upload(key, blob) { n.put += 1; if (failPut) return { data: null, error: { name: 'StorageApiError', message: 'upstream 503', status: 503, statusCode: '503' } }; objs.set(key, Buffer.from(await blob.arrayBuffer())); return { data: {}, error: null }; },
    async remove(keys) { for (const k of keys) objs.delete(k); return { data: [], error: null }; },
    async list() { n.list += 1; return { data: [], error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, objs, n, setFailPut: (v) => { failPut = v; } };
};
function holder(f) {
  const a = (globalThis.__argoSyncAwake ??= {}); if (a.timer && typeof a.timer !== 'string') clearInterval(a.timer);
  Object.assign(a, { timer: 'test', wall: Date.now(), mono: performance.now(), wokeAt: 0, since: Date.now() - 600_000 });
  f.objs.set(LK, Buffer.from(JSON.stringify({ deviceId: ME, token: 't', ts: Date.now() })));
  Object.assign(lease(), { leader: true, ownedAt: Date.now(), checkedAt: Date.now(), yieldSince: 0, pending: null, readFailSince: 0, writeFailed: false, followAt: 0, token: 't', validUntil: 0, peers: {}, peersSavedAt: {} });
}

test('읽기 간격 — 일반 보유자 18초(대기 22초 − 4초), 가져갈 기기가 없는 우선 역할 25초, 다른 기기를 본 계정은 그대로 8초', () => {
  const f = store(); _setSyncClientForTest(f.client); holder(f);
  assert.equal(leaseReadInterval(), 18_000);
  assert.equal(HANDOVER_WAIT_MS, 22_000, '넘겨받기 대기는 옛 판에도 박혀 있어 바꾸지 않는다');
  process.env.ARGO_PREFER_LEADER = '1';
  assert.equal(leaseReadInterval(), 25_000);
  lease().peers = { 'u-solo': { at: Date.now(), normals: [] } };
  assert.equal(leaseReadInterval(), 8_000, '엄격 판정의 담당은 역할과 상관없이 확인 기한 때문에 8초');
});

test('우선 보유자의 살아 있는 글을 일반 기기가 가져가지 않는다(25초의 전제) — 일반 기기는 양보한다', async () => {
  const f = store(); _setSyncClientForTest(f.client); holder(f);
  f.objs.set(LK, Buffer.from(JSON.stringify({ deviceId: 'B-Server-0badf00d', token: 'tb', ts: Date.now(), preferred: true })));
  await renewLease(OWNER, { runnerUsable: true });
  assert.equal(lease().leader, false);
  assert.equal(f.n.put, 0);
  assert.equal(JSON.parse(f.objs.get(LK).toString()).token, 'tb');
});

test('다시 쓰기가 실패하면 다음 읽기를 8초 뒤로 당긴다 — 간격이 늘어도 내 글 만료 전 재시도 횟수가 줄지 않게, 성공하면 돌아온다', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = store(); _setSyncClientForTest(f.client); holder(f);
  process.env.ARGO_PREFER_LEADER = '1';
  mock.timers.tick(LEASE_RENEW_MS + 1_000); globalThis.__argoSyncAwake.wall = Date.now(); globalThis.__argoSyncAwake.mono = performance.now();
  f.setFailPut(true);
  await renewLease(OWNER, { runnerUsable: true });
  assert.equal(lease().leader, true, '보유 리스 TTL 안 — 담당 유지');
  assert.equal(leaseReadInterval(), 8_000);
  f.setFailPut(false);
  await renewLease(OWNER, { runnerUsable: true });
  assert.equal(leaseReadInterval(), 25_000);
});

test('혼자 모드 클레임 판정 — 18초 박자 54초·25초 박자 50초마다: 옛 판이 긴 글을 가져갔을 때 물러나는 시간(≤60초)이 늘지 않는다', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const [step, every] of [[18_000, 54_000], [25_000, 50_000]]) {
    const f = store(); _setSyncClientForTest(f.client); _resetTokenClaimsForTest(); holder(f);
    setClaimTokens(['tok-solo']);
    let now = Date.now(); const at = [];
    for (let i = 0; i < 40; i++) {
      lease().ownedAt = now; // 혼자 모드 유지(판정 박자만 본다)
      const before = f.n.list; await renewTokenClaims(OWNER, { now }); if (f.n.list > before) at.push(now);
      now += step; mock.timers.setTime(now);
    }
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    assert.ok(gaps.length > 5 && gaps.every((g) => g === every), `${step}ms 박자 판정 간격 ${gaps}`);
  }
});
