// 혼자 쓰는 보유자의 인계 하네스 — 기기 A는 실제 코드(renewLease + leaseReadInterval 박자, 리스 타이머 startLeaseLoop와 같은 간격 계산), 넘겨받는 기기 B는 판별 모형이다:
// 살아 있는 A의 글을 읽고 → 자기 글을 쓰고 → 응답 받은 시각 + WAIT_MS(옛 판·새 판 모두 22초, #884 이전 argo run은 0) 뒤 첫 판정에 담당을 시작한다.
// 시계는 가짜(Date만)이고 응답 지연은 저장소 안에서 시계를 넘겨 흉내 낸다(읽기·쓰기는 지연의 가운데에 일어난다). 0.1초 간격으로 'A 담당 && B 담당'인 시간(겹침)을 잰다.
// 사용: MODE=sweep|idle [SRC=<저장소 루트>] [ROLE=normal|preferred] [READ_LAT_MS] [WAIT_MS=22000] [GRID=1] node test/helpers/lease-preempt.mjs — 결과는 '@@' 뒤 JSON 한 줄.
// SRC로 다른 판의 src를 가리키면 같은 상황을 그 판으로 잰다(고치기 전후 비교).
import { mock } from 'node:test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = process.env.SRC || fileURLToPath(new URL('../..', import.meta.url));
const MODE = process.env.MODE || 'sweep';
const READ_LAT = Number(process.env.READ_LAT_MS ?? 300);
const WRITE_LAT = Number(process.env.WRITE_LAT_MS ?? READ_LAT);
const WAIT = Number(process.env.WAIT_MS ?? 22_000);
const GRID = process.env.GRID !== '0'; // 참 = B는 8초 판정 격자에서만 담당을 시작한다(실제 리스 타이머). 거짓 = 대기가 끝나는 즉시(가장 나쁜 하한)
const B_LAT = 300; // B 자신의 읽기·쓰기 지연
const STEP = 100;
const root = mkdtempSync(join(tmpdir(), 'lease-preempt-'));
process.env.ARGO_ROOT = root; process.env.ARGO_SYNC = '1';
for (const k of ['ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_STANDBY_LEADER', 'ARGO_SYNC_CYCLE_MS']) delete process.env[k];
if (process.env.ROLE === 'preferred') process.env.ARGO_PREFER_LEADER = '1';
writeFileSync(join(root, '.device-session.json'), JSON.stringify({ url: 'https://example.invalid', anonKey: 'anon', access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-lp', email: '' } }), { mode: 0o600 });
const sync = await import(pathToFileURL(join(SRC, 'src/sync.mjs')).href);
const { getDeviceId } = await import(pathToFileURL(join(SRC, 'src/workspace.mjs')).href);
const A = await getDeviceId();
const OWNER = 'owner-lp'; const LK = `${OWNER}/_device-lease.json`;

mock.timers.enable({ apis: ['Date'], now: Date.now() });
const lease = () => globalThis.__argoSyncLease;
const awakeNow = () => { const a = (globalThis.__argoSyncAwake ??= {}); if (a.timer && typeof a.timer !== 'string') clearInterval(a.timer); Object.assign(a, { timer: 'test', wall: Date.now(), mono: performance.now(), wokeAt: 0, since: Date.now() - 10 * 60_000 }); };

let objs = new Map(); const n = { get: 0, put: 0 };
let onTime = () => {}; // 시계가 넘어갈 때마다 부른다(B 사건·겹침 표본)
const advance = (ms) => { for (let left = ms; left > 0; left -= STEP) { mock.timers.tick(Math.min(STEP, left)); awakeNow(); onTime(); } };
const NOT_FOUND = { name: 'StorageApiError', message: 'Object not found', status: 400, statusCode: '404' };
const bucket = {
  async download(key) {
    n.get += 1; advance(READ_LAT / 2);
    const b = objs.get(String(key).split('?')[0]);
    advance(READ_LAT / 2);
    return b ? { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }, error: null } : { data: null, error: NOT_FOUND };
  },
  async upload(key, blob) { n.put += 1; const buf = Buffer.from(await blob.arrayBuffer()); advance(WRITE_LAT / 2); objs.set(key, buf); advance(WRITE_LAT / 2); return { data: {}, error: null }; },
};
sync._setSyncClientForTest({ storage: { from: () => bucket } });

/** A = 확인된 혼자 보유자(방금 내 글을 썼다). */
function asHolder() {
  objs = new Map(); const token = 't-a';
  objs.set(LK, Buffer.from(JSON.stringify({ deviceId: A, token, ts: Date.now(), ...(process.env.ROLE === 'preferred' ? { preferred: true } : {}) })));
  globalThis.__argoSyncLeaseBootAt = Date.now() - 60_000; awakeNow();
  Object.assign(lease(), { leader: true, ownedAt: Date.now(), checkedAt: Date.now(), yieldSince: 0, pending: null, readFailSince: 0, escapeAt: 0, escapeBlocked: false, followAt: 0, token, validUntil: 0, peers: {}, peersSavedAt: {} });
}
/** 리스 타이머 한 번 — startLeaseLoop와 같은 간격 계산(판정이 걸린 시간을 뺀다). 다음 판정 시각을 돌려준다. */
async function aTick() {
  const t0 = Date.now();
  await sync.renewLease(OWNER, { runnerUsable: true });
  return Date.now() + Math.max(0, sync.leaseReadInterval() - (Date.now() - t0));
}
async function runFor(ms, next = Date.now()) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (Date.now() >= next) next = await aTick(); else advance(Math.min(next - Date.now(), until - Date.now())); }
  return next;
}

let out;
if (MODE === 'idle') {
  asHolder();
  await runFor(60_000); n.get = 0; n.put = 0; // 처음 1분은 뺀다
  const leaderOff = []; onTime = () => { if (!sync.isCloudLeader()) leaderOff.push(Date.now()); };
  const MIN = 10; await runFor(MIN * 60_000);
  const age = Date.now() - JSON.parse(objs.get(LK).toString()).ts;
  out = { mode: 'idle', role: process.env.ROLE || 'normal', readLatMs: READ_LAT, intervalMs: sync.leaseReadInterval(), getPerMin: n.get / MIN, putPerMin: n.put / MIN, totalPerMin: (n.get + n.put) / MIN, leaderOffSamples: leaderOff.length, lastDocAgeMs: age };
} else {
  const res = { maxOverlapMs: 0, maxStepDownMs: 0, minBStartMs: Infinity, maxBStartMs: 0, runs: 0, lost: 0 };
  const interval = (() => { asHolder(); return sync.leaseReadInterval(); })();
  for (let warm = 0; warm < 75_000; warm += 7_000) { // 다시 쓰기(60초 주기) 위상까지 훑는다
    for (let phase = 0; phase < interval; phase += 500) {
      asHolder();
      let next = Date.now();
      // B: 읽기 → 쓰기(지연의 가운데에 닿는다 — A의 읽기가 걸린 중간일 수도 있다) → 응답 → 800ms 뒤 확인 읽기 → 대기 → 담당 시작
      const t0B = Date.now() + warm + phase; const landAt = t0B + B_LAT + B_LAT / 2; const upDoneAt = t0B + 2 * B_LAT;
      let bStartAt = upDoneAt + WAIT;
      if (GRID) { let k = 1; while (t0B + 8_000 * k + B_LAT < upDoneAt + WAIT) k += 1; bStartAt = t0B + 8_000 * k + B_LAT; }
      let landed = false; let bOn = false; let overlap = 0; let stepDownAt = null; let lost = false;
      onTime = () => {
        const now = Date.now();
        if (!landed && now >= landAt) { landed = true; objs.set(LK, Buffer.from(JSON.stringify({ deviceId: 'B-Server-0badf00d', token: 'tb', ts: now, preferred: true }))); }
        if (landed && !lost && !bOn && JSON.parse(objs.get(LK).toString()).token !== 'tb') lost = true; // A의 다시 쓰기가 B의 글을 덮음 — B는 확인 읽기에서 진다(종전과 같은 경합)
        if (!bOn && now >= bStartAt) bOn = true;
        const aOn = sync.isCloudLeader();
        if (landed && !aOn && stepDownAt == null) stepDownAt = now;
        if (aOn && bOn) overlap += STEP;
      };
      const limit = t0B + 180_000;
      while (Date.now() < limit && !(bOn && stepDownAt != null) && !lost) { if (Date.now() >= next) next = await aTick(); else advance(Math.min(next - Date.now(), 1_000)); }
      res.runs += 1;
      if (lost) { res.lost += 1; continue; }
      res.maxOverlapMs = Math.max(res.maxOverlapMs, overlap);
      res.maxStepDownMs = Math.max(res.maxStepDownMs, (stepDownAt ?? limit) - landAt);
      res.minBStartMs = Math.min(res.minBStartMs, bStartAt - landAt);
      res.maxBStartMs = Math.max(res.maxBStartMs, bStartAt - landAt);
    }
  }
  out = { mode: 'sweep', intervalMs: interval, readLatMs: READ_LAT, waitMs: WAIT, grid: GRID, ...res };
}
mock.timers.reset();
process.stdout.write(`\n@@${JSON.stringify(out)}\n`);
rmSync(root, { recursive: true, force: true });
process.exit(0);
