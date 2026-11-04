// 기기당 Supabase 요청 예산 시험의 자식(test/idle-request-budget.test.mjs) — 실제 동기화 루프(ensureSync: 리스 타이머·회사 사이클·클레임 판정)를
// 실제 supabase-js + 가짜 Supabase(로컬 HTTP)로 돌리고, 가상 시계로 몇십 분을 몇 초에 지나 요청을 경로별로 센다. 요청 1건 = 운영 로그 1줄 이상이라 "HTTP 요청 수"를 센다.
// 시계: Date·setTimeout·setInterval·performance.now를 함께 가상으로 돌린다(performance.now를 빼면 깨어 있음 판정이 잠들었다 깬 것으로 읽어 리스를 더 자주 읽는다).
// 시계는 진행 중인 일(요청·파일 입출력)이 끝난 뒤에만 넘긴다 — 느린 러너에서는 실제 시간이 더 걸릴 뿐 세는 값은 같다(app-gate 시험의 20ms 대기 같은 흔들림이 없다).
// 입력 env BUDGET_CELL = { tokens, peer: 'none'|'holder'|'stale'|'follower', warmMin, windowMin }. 출력 stdout 마지막 '@@{...}' 한 줄.
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cell = JSON.parse(process.env.BUDGET_CELL);
const root = process.env.ARGO_ROOT;
const UID = 'u-budget';
const OTHER = 'Other-Mac-0000aaaa';
const COMPANIES = ['co-budget-a', 'co-budget-b', 'co-budget-c'];
const TOKENS = Array.from({ length: cell.tokens }, (_, i) => `budget-tok-${i}`);

const realImmediate = setImmediate;
const t0 = Date.now();
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: t0 });
Object.defineProperty(performance, 'now', { value: () => Date.now() - t0, configurable: true });

let inflight = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { inflight += 1; try { return await realFetch(...a); } finally { inflight -= 1; } };

const { startFakeSupabase } = await import('./fake-supabase-http.mjs');
const fake = await startFakeSupabase({ plan: 'pro', userId: UID, syncIndex: { companies: COMPANIES, tombstones: [] } });
const md5 = (b) => createHash('md5').update(b).digest('hex');
// 운영 Storage와 같은 모양을 이 시험에 필요한 만큼만 — 객체 메타의 last_modified는 쓸 때만 바뀌고(도우미 기본값은 부를 때마다 달라 유휴 판정이 안 된다),
// .tg-claims 목록은 저장된 객체와 eTag(본문 MD5)를 돌려준다(도우미 기본값은 빈 목록이라 토큰마다 GET으로 샌다).
fake.fault = (req, path, body) => {
  if (req.method === 'GET' && path.startsWith('/storage/v1/object/info/')) {
    const key = decodeURIComponent(path.slice('/storage/v1/object/info/'.length)).replace(/^(authenticated|public)\//, '');
    const b = fake.store.get(key);
    if (!b) return { status: 400, body: { statusCode: '404', error: 'not_found', message: 'Object not found' } };
    return { status: 200, body: { id: key, name: key, version: `v-${md5(b).slice(0, 8)}`, size: b.length, etag: `"${md5(b)}"`, last_modified: '2026-01-01T00:00:00.000Z' } };
  }
  if (req.method === 'POST' && path.startsWith('/storage/v1/object/list/')) {
    const prefix = String(JSON.parse(body.toString() || '{}').prefix ?? '').replace(/\/$/, '');
    const out = [];
    for (const [k, b] of fake.store) {
      if (!k.startsWith(`companies/${prefix}/`)) continue;
      const name = k.slice(`companies/${prefix}/`.length);
      if (!name.includes('/')) out.push({ name, metadata: { eTag: `"${md5(b)}"` } });
    }
    return { status: 200, body: out };
  }
  return null;
};

/* 데이터 폴더 — 격리 ARGO_ROOT에 회사 3개(회사당 파일 몇 개)와 기기 세션(만료 먼 — 가상 시간이 지나도 회전 없음) */
for (const ws of COMPANIES) {
  mkdirSync(join(root, ws, 'notes'), { recursive: true });
  writeFileSync(join(root, ws, 'company.json'), JSON.stringify({ id: ws, name: ws, ownerId: UID }));
  for (let i = 0; i < 3; i++) writeFileSync(join(root, ws, 'notes', `n${i}.md`), `# ${ws} ${i}\n`);
}
writeFileSync(join(root, '.device-session.json'), JSON.stringify({ url: fake.url, anonKey: 'anon-fixture', access_token: 'h.p.s', refresh_token: 'rt-0', expires_at: Math.floor(t0 / 1000) + 30 * 86_400, user: { id: UID, email: '' } }), { mode: 0o600 });
writeFileSync(join(root, '.device-id'), 'budget-mac-0001');
// 다른 기기를 본 적 있는 계정(엄격 판정) — 담당·비담당 칸. 'stale' = 7시간 전에 본 계정(14일 표지만 — 엄격 판정은 6시간, 2026-11-03)
if (cell.peer !== 'none') writeFileSync(join(root, '.lease-peer.json'), JSON.stringify({ v: 2, accounts: { [UID]: { at: cell.peer === 'stale' ? t0 - 7 * 3_600_000 : t0, normals: [OTHER] } } }));

const LEASE_KEY = `companies/${UID}/_device-lease.json`;
const putJson = (k, doc) => fake.store.set(k, Buffer.from(JSON.stringify(doc)));
/** 다른 기기(비담당 칸의 담당) — 저장소에 직접 쓴다. 이 기기의 요청으로 세지 않는다. 운영처럼 리스는 60초, 클레임은 약 60초마다 다시 쓴다. */
let peerAt = -Infinity;
let claimKey = () => '';
function peerBeat() {
  if (cell.peer !== 'follower' || Date.now() - peerAt < 60_000) return;
  peerAt = Date.now();
  putJson(LEASE_KEY, { deviceId: OTHER, token: 't-other', ts: peerAt });
  for (const t of TOKENS) putJson(claimKey(t), { deviceId: OTHER, nonce: `n-${peerAt}`, ts: peerAt });
}

const seedProbe = () => { globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true }; }; // 호스트 CLI 탐지가 판정을 흔들지 않게(sync-child와 같은 자리) — 요청을 만들지 않는다
seedProbe();
const { daemonLease } = await import('../../src/lock.mjs');
const sync = await import('../../src/sync.mjs');
claimKey = (t) => `companies/${UID}/.tg-claims/${sync.tokenClaimHash(t)}.json`;
peerBeat();
daemonLease('gateway'); daemonLease('scheduler');
if (TOKENS.length) sync.setClaimTokens(TOKENS);
sync.ensureSync();

/* 시계 넘기기 — 진행 중인 요청·파일 입출력이 끝난 뒤에만 */
const IDLE = new Set(['TCPSocketWrap', 'TCPServerWrap', 'Timeout', 'Immediate', 'PipeWrap', 'TTYWrap']);
let stalls = 0;
async function settle() {
  const until = process.hrtime.bigint() + 20_000_000_000n; // 실제 20초 — 걸린 일이 있으면 시험을 멈추지 않고 세어 보고한다
  for (let quiet = 0; quiet < 5;) {
    await new Promise((r) => realImmediate(r));
    const busy = inflight > 0 || process.getActiveResourcesInfo().some((r) => !IDLE.has(r));
    quiet = busy ? 0 : quiet + 1;
    if (process.hrtime.bigint() > until) { stalls += 1; return; }
  }
}
async function runFor(ms) {
  for (let t = 0; t < ms; t += 1_000) {
    mock.timers.tick(1_000);
    seedProbe(); peerBeat();
    await settle();
  }
}

await settle();
await runFor(cell.warmMin * 60_000); // 첫 동기화·첫 획득을 지나 유휴에 들어간다
const from = Date.now();
await runFor(cell.windowMin * 60_000);
const to = Date.now();

/** 경로 → 호출 이름. 회사 id·지문을 지워 묶는다. 모르는 경로는 그대로 남긴다(새 호출이 실패 메시지에 보이게). */
function bucket(k) {
  const [m, p] = k.split(' ');
  if (p === `/storage/v1/object/${LEASE_KEY}`) return m === 'GET' ? '리스 GET' : '리스 쓰기';
  if (p.startsWith('/storage/v1/object/info/') && p.endsWith('__manifest__.json')) return '매니페스트 info';
  if (p.endsWith('__manifest__.json')) return m === 'GET' ? '매니페스트 GET' : '매니페스트 쓰기';
  if (p.startsWith('/storage/v1/object/list/')) return '목록';
  if (p.includes('/.tg-claims/')) return m === 'GET' ? '클레임 GET' : '클레임 쓰기';
  if (p.startsWith('/storage/v1/object/')) return `파일 ${m}`;
  return `${m} ${p}`;
}
const counts = {};
for (const h of fake.hits) if (h.t >= from && h.t < to) { const b = bucket(h.k); counts[b] = (counts[b] ?? 0) + 1; }
const mins = (to - from) / 60_000;
const perMin = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / mins) * 100) / 100]));
const total = Object.values(counts).reduce((a, b) => a + b, 0) / mins;
const st = sync.syncStatus();
process.stdout.write(`\n@@${JSON.stringify({ perMin, counts, total: Math.round(total * 100) / 100, windowMin: mins, leader: sync.isCloudLeader(), mine: TOKENS.filter((t) => sync.tokenOwnership(t).mine).length, stalls, lastError: st.lastError, phase: st.phase })}\n`);
process.exit(0);
