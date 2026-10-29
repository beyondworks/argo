// 0.1.121 핫픽스 — 고객 C(2026-10-30) 메인 PC가 0.1.120 뒤에도 동기화 사이클 첫 단계에서 5시간 멈춘 것을 앱이 스스로 풀게 한다.
// ① 동기화 잠금 회수(옛 판 사이드카·미래 ts·멈춘 ts) ② 사이클 감시(멈추면 루프 다시 시작) ③ 호스티드 빌드의 서비스 모드 금지(빌드 값)
// ④ 30분 최소 버전 확인 요청에 동기화 진단 꼬리(요청 수 그대로) ⑤ 안전한 로그인 경로가 남긴 귀속 대기만 다시 시도(교차 사이트 confirm은 아님).
// 자식 프로세스 + 가짜 Supabase로 실제 루프(ensureSync)를 돌린다 — 루프는 끝나지 않는 타이머라 시험 프로세스 안에서 돌리지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { childEnv, srcUrl, seedRoot } from './helpers/sync-child.mjs';
import {
  lockTakeoverReason, olderLockHolder, LOCK_FROZEN_MS, LOCK_FUTURE_SKEW_MS, LOCK_TAKEOVER_WAIT_MS,
  syncLoopStalled, SYNC_WATCHDOG_MS, serviceCredsAllowed,
} from '../src/sync.mjs';
import { syncDiagTag, withSyncDiag } from '../src/sync-diag.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });
const uploads = (fake) => fake.hits.filter((h) => (h.k.startsWith('POST /storage/v1/object/') || h.k.startsWith('PUT /storage/v1/object/')) && !h.k.includes('/object/list/'));

function runChild({ root, env = {}, script = 'sync.ensureSync();', waitMs }) {
  const body = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
${script}
await sleep(${Number(waitMs)});
const s = sync.syncStatus();
process.stdout.write('\\n@@' + JSON.stringify({ held: s.held, lastError: s.lastError, watchdogRestarts: globalThis.__argoSyncStatus?.watchdogRestarts ?? 0, pid: process.pid }) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], { env: childEnv(root, { ARGO_AGENT_LINK: '0', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`child timeout\n${err.slice(-2000)}`)); }, waitMs + 40_000);
    p.on('exit', () => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no status\n${out.slice(-2000)}\n${err.slice(-2000)}`));
      resolve({ status: JSON.parse(line.slice(2)), out: out + err, pid: p.pid });
    });
  });
}

/* ─── ① 잠금 회수 판정(순수) — 경우 표 L1·L3~L7·L9·P2 ─── */
test('잠금 회수 판정 — 같은 판·살아 있는 주인은 기다리고, 옛 판·미래 ts·멈춘 ts는 가져온다(pid 생존은 보조)', () => {
  const now = 1_800_000_000_000;
  const alive = () => true, dead = () => false;
  const me = '0.1.121';
  const fresh = (extra) => ({ pid: 4242, ts: now - 1_000, ...extra });
  assert.equal(lockTakeoverReason(fresh({ ver: '0.1.121' }), { now, myVer: me, alive }), null, 'L1 같은 판 + 살아 있음 + 신선한 ts = 기다림(종전과 같음)');
  assert.equal(lockTakeoverReason(fresh({}), { now, myVer: me, alive }), 'older', 'L2 ver 없음 = 0.1.120 이전 옛 판(0.1.116~0.1.119 사이드카)');
  assert.equal(lockTakeoverReason(fresh({ ver: '0.1.120' }), { now, myVer: me, alive }), 'older', 'L3 낮은 판');
  assert.equal(lockTakeoverReason(fresh({ ver: '0.1.122' }), { now, myVer: me, alive }), null, 'L4 높은 판은 뺏지 않는다');
  assert.equal(lockTakeoverReason({ pid: 4242, ts: now + LOCK_FUTURE_SKEW_MS + 5_000, ver: me }, { now, myVer: me, alive }), 'future', 'L5 미래 ts(시계 되돌림) + 살아 있는 pid(재사용 포함)');
  assert.equal(lockTakeoverReason({ pid: 4242, ts: now + 30_000, ver: me }, { now, myVer: me, alive }), null, '작은 시계 차이는 회수 사유가 아니다');
  assert.equal(lockTakeoverReason(fresh({ ver: me }), { now, myVer: me, alive, frozenMs: LOCK_FROZEN_MS + 1 }), 'frozen', 'L6 같은 (pid, ts)를 120초 넘게 봄');
  assert.equal(lockTakeoverReason(fresh({ ver: me }), { now, myVer: me, alive, frozenMs: LOCK_FROZEN_MS - 1 }), null);
  assert.equal(lockTakeoverReason({ pid: 4242, ts: now - 200_000, ver: me }, { now, myVer: me, alive }), 'stale', 'L7 낡은 ts(종전)');
  assert.equal(lockTakeoverReason(fresh({ ver: me }), { now, myVer: me, alive: dead }), 'dead', 'L7 죽은 pid(종전)');
  assert.equal(lockTakeoverReason({ pid: 4242 }, { now, myVer: me, alive }), 'stale', 'ts 없음/손상 = 종전처럼 획득');
  // L9 내 판을 모르면 판 규칙으로 뺏지 않는다
  assert.equal(lockTakeoverReason(fresh({}), { now, myVer: null, alive }), null);
  assert.equal(lockTakeoverReason(fresh({ ver: '0.1.100' }), { now, myVer: '0.0.0', alive }), null);
  assert.equal(olderLockHolder('0.0.0', me), false, '주인 판을 못 읽은 번들(0.0.0)은 낮은 판으로 보지 않는다');
  assert.equal(olderLockHolder(undefined, '0.1.119'), false, 'ver 쓰기 이전 판끼리는 판 규칙이 없다');
  assert.ok(LOCK_TAKEOVER_WAIT_MS >= 20_000, '넘겨받기 대기 — 옛 주인이 하던 사이클을 끝낼 시간');
});

/* ─── ① 잠금 회수(행동) — 경우 표 L2·L8: 옛 판 사이드카가 살아서 ts를 갱신해도 새 판이 가져오고, 옛 판은 물러난다(핑퐁 없음) ─── */
test('옛 판 사이드카(ver 없는 잠금, 살아 있는 pid, ts 갱신)가 있어도 새 판이 잠금을 가져와 넘겨받기 대기 뒤 동기화한다', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-0121-lock-'));
  seedRoot(root, { url: fake.url, wsId: 'co-lock' });
  const lockFile = join(root, '.sync-process.lock');
  // 옛 판(0.1.116~0.1.120) holdSyncLock을 그대로 흉내 낸다 — 남이 살아 있고 ts가 120초 안이면 기다리고, 아니면 ver 없이 자기 잠금을 쓴다.
  const old = { writes: 0, writesAfterYield: 0, yielded: false };
  const oldTick = () => {
    let cur = null;
    try { cur = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { /* 없음 */ }
    if (cur && cur.pid !== process.pid && Date.now() - cur.ts < 120_000) {
      try { process.kill(cur.pid, 0); old.yielded = true; return; } catch { /* 죽음 → 탈취 */ }
    }
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    old.writes++; if (old.yielded) old.writesAfterYield++;
  };
  oldTick();
  const iv = setInterval(oldTick, 300);
  const t0 = Date.now();
  let r;
  try {
    r = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '300' }, waitMs: LOCK_TAKEOVER_WAIT_MS + 6_000 });
  } finally { clearInterval(iv); }
  assert.match(r.out, /\[argo\] sync lock takeover reason=older pid=\d+ ver=-/, '회수 사유를 로그 한 줄로 남긴다');
  assert.equal(old.yielded, true, '옛 판은 새 판의 잠금(살아 있는 pid·신선한 ts)을 보고 물러났다');
  assert.equal(old.writesAfterYield, 0, '물러난 뒤 옛 판이 잠금을 다시 쓰지 않았다(핑퐁 없음)');
  const up = uploads(fake);
  assert.ok(up.length > 0, `넘겨받기 대기 뒤 동기화했다: ${r.status.held?.phase}/${r.status.lastError}`);
  assert.ok(up[0].t - t0 >= LOCK_TAKEOVER_WAIT_MS - 1_000, `넘겨받기 대기(${LOCK_TAKEOVER_WAIT_MS}ms) 전에는 올리지 않는다 — 첫 업로드 ${up[0].t - t0}ms`);
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, r.status.pid, '잠금 주인 = 새 판 프로세스');
});

/* ─── ② 사이클 감시 ─── */
test('사이클 감시 판정 — 흔적(시작·걷기·받기·올리기·사이클 끝)에서 10분 넘게 지나야 멈춤', () => {
  const now = 1_800_000_000_000;
  assert.equal(SYNC_WATCHDOG_MS, 10 * 60_000);
  assert.equal(syncLoopStalled({}, now), false, '흔적이 없으면(루프 전) 멈춤 아님');
  assert.equal(syncLoopStalled({ loopStartAt: now - 11 * 60_000 }, now), true, '루프를 띄우고 사이클이 한 번도 진척 없음(버킷 준비·첫 사이클 멈춤)');
  assert.equal(syncLoopStalled({ loopStartAt: now - 60 * 60_000, beatAt: now - 30_000, cycling: true }, now), false, 'W2 긴 사이클이라도 파일 작업이 진행 중이면 아님');
  assert.equal(syncLoopStalled({ loopStartAt: now - 60 * 60_000, cycleEndAt: now - 8_000 }, now), false, 'W3 잠금 대기·자격 없음 사이클은 끝나므로 아님');
  assert.equal(syncLoopStalled({ loopStartAt: now - 60 * 60_000, beatAt: now - 11 * 60_000, cycleEndAt: now - 12 * 60_000, cycling: true }, now), true, 'W1 사이클 안에서 await가 끝나지 않음');
});

test('사이클이 끝나지 않는 await에 멈추면 감시가 루프를 다시 띄워 동기화가 이어진다(경우 표 W1)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  let hung = 0;
  fake.fault = (req, path) => (req.method === 'GET' && path.startsWith('/storage/v1/object/') && hung++ === 0 ? 'hang' : null); // 첫 저장소 읽기 하나만 영영 답하지 않는다(클라이언트 30초 시간 초과보다 먼저 감시가 잡는다)
  const root = await mkdtemp(join(tmpdir(), 'argo-0121-watchdog-'));
  seedRoot(root, { url: fake.url, wsId: 'co-dog' });
  const r = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '300', ARGO_SYNC_WATCHDOG_MS: '1500' }, waitMs: 8_000 });
  assert.equal(hung >= 1, true, '시험이 실제로 멈춤을 만들었다');
  assert.match(r.out, /\[argo\] sync watchdog restart — \d+분 동안 사이클 진척 없음/);
  assert.ok(r.status.watchdogRestarts >= 1, `감시 재시작 수 ${r.status.watchdogRestarts}`);
  assert.ok(uploads(fake).length > 0, '새 루프가 회사를 올렸다(멈춘 옛 요청의 30초 시간 초과를 기다리지 않음)');
});

/* ─── ③ 호스티드 빌드의 서비스 모드 금지(경우 표 S1~S3) ─── */
test('서비스 모드 판정 — 빌드가 공개키로 만들어졌으면 런타임 env가 비어도 금지, 셀프호스트·워커는 종전대로 허용', () => {
  assert.equal(serviceCredsAllowed({ ARGO_PARENT_PID: '123' }, { built: true }), false, 'S1 데스크톱 사이드카: 런타임 env에 공개키 없음 + 빌드 공개키 = 호스티드');
  assert.equal(serviceCredsAllowed({ ARGO_TENANT_OWNER: 'u-worker' }, { built: true }), true, 'S3 워커는 허용');
  assert.equal(serviceCredsAllowed({}, { built: false }), true, 'S2 셀프호스트(공개키 미빌드)는 허용');
  assert.equal(serviceCredsAllowed({}), true, '명시 env(기본 env 아님)는 빌드 값을 섞지 않는다 — 종전 시험 의미 그대로');
});

test('호스티드 빌드에 남은 서비스 자격은 쓰지 않고 진단에 남긴다 — 기기 세션으로 동기화(경우 표 S1)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-0121-svc-'));
  seedRoot(root, { url: fake.url, wsId: 'co-svc' });
  writeFileSync(join(root, '.sync-credentials.json'), JSON.stringify({ url: fake.url, key: 'svc-fixture-not-a-real-key', owner: 'u1' }), { mode: 0o600 }); // 옛 페어링 흔적
  // 자식 기본 env에는 공개키를 넣는다 — 기본 env(process.env)를 쓰는 경로에서 빌드 값과 같은 판정이 되는지(번들은 이 리터럴에 빌드 값을 박는다)
  const r = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '300', NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture' }, waitMs: 3_000 });
  assert.match(r.out, /\[argo\] sync service-creds-ignored/);
  assert.equal(fake.hits.some((h) => h.auth === 'Bearer svc-fixture-not-a-real-key'), false, '서비스 자격으로 나간 요청 0');
  assert.ok(uploads(fake).length > 0 && uploads(fake).every((h) => h.auth === 'Bearer h.p.s'), '기기 세션(JWT)으로 동기화');
});

/* ─── ④ 원격 진단 꼬리(경우 표 D1~D3) ─── */
test('진단 꼬리 — 단계·오류 종류·잠금 주인 판·회수 이유·개수만, 계정·회사 id 없음', () => {
  const g = {
    __argoSync: true,
    __argoSyncStatus: { phase: 'lock-wait', errorCode: 'other-process', scanAt: 10, watchdogRestarts: 2, svcIgnored: true, claimError: 'claim',
      companies: { 'co-secret-1': { ts: 11, skipped: 'no-owner' }, 'co-old': { ts: 5, skipped: 'no-owner' }, 'co-x': { ts: 12, skipped: 'foreign-owner' } } },
    __argoSyncLockState: { elsewhere: true, holder: { pid: 99, ver: '0.1.116' }, takeover: { reason: 'older' } },
  };
  const tag = syncDiagTag(g);
  assert.equal(tag, 'argo-sync/lock-wait/other-process/l0.1.116/tolder/n1/f1/w2/s1/c1');
  assert.match(tag, /^[A-Za-z0-9._/-]+$/);
  assert.equal(/co-secret|u1|99/.test(tag), false, '회사 id·pid·계정 없음');
  assert.equal(syncDiagTag({}), 'argo-sync/none');
  assert.equal(syncDiagTag({ __argoSyncCredWatch: {} }), 'argo-sync/not-started');
  assert.equal(syncDiagTag({ __argoSync: true, __argoSyncStatus: { phase: 'id le;"x' } }).split('/')[1], 'idlex', '이상한 글자는 지운다');
});

test('30분 최소 버전 확인 요청 한 건에 꼬리가 argo/<버전> 뒤에 붙고, 서버의 버전 추출·꼬리 판정은 그대로다(요청 수 그대로)', async () => {
  const seen = [];
  const srv = createServer((req, res) => { seen.push({ path: req.url, xci: req.headers['x-client-info'] }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('"0.1.100"'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const { appGateClient, refreshAppGate, _resetAppGateForTest } = await import('../src/app-gate.mjs');
    const { APP_VERSION } = await import('../src/app-version.mjs');
    _resetAppGateForTest();
    const root = await mkdtemp(join(tmpdir(), 'argo-0121-diag-'));
    const prev = { s: globalThis.__argoSync, st: globalThis.__argoSyncStatus, l: globalThis.__argoSyncLockState };
    Object.assign(globalThis, { __argoSync: true, __argoSyncStatus: { phase: 'lock-wait', errorCode: 'other-process', companies: {} }, __argoSyncLockState: { elsewhere: true, holder: { ver: '0.1.119' } } });
    try { await refreshAppGate(root, { url, anonKey: 'anon-fixture', access_token: 'h.p.s' }, appGateClient); }
    finally { Object.assign(globalThis, { __argoSync: prev.s, __argoSyncStatus: prev.st, __argoSyncLockState: prev.l }); }
    assert.equal(seen.length, 1, '요청은 한 건(꼬리는 기존 요청에 싣는다)');
    assert.equal(seen[0].path, '/rest/v1/rpc/argo_min_app_version');
    const xci = seen[0].xci;
    assert.ok(xci.endsWith(` argo/${APP_VERSION} argo-sync/lock-wait/other-process/l0.1.119/t-/n0/f0/w0/s0/c0`), xci);
    // 서버(20261019135000 argo_xci_version): substring(xci from ' argo/([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})') — 꼬리가 버전 추출을 바꾸지 않는다
    assert.equal(/ argo\/([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})/.exec(xci)?.[1], APP_VERSION);
    assert.equal(xci.split(' argo/').length - 1, 1, "꼬리는 ' argo/'를 하나 더 만들지 않는다");
  } finally { await new Promise((r) => srv.close(r)); }
});

test('withSyncDiag — 이미 꼬리가 있으면 다시 붙이지 않는다', async () => {
  let got = null;
  const f = withSyncDiag(async (_u, init) => { got = new Headers(init.headers).get('x-client-info'); }, () => 'argo-sync/idle/-/l-/t-/n0/f0/w0/s0/c0');
  await f('http://x', { headers: { 'X-Client-Info': 'supabase-js/2 argo/0.1.121 argo-sync/old' } });
  assert.equal(got, 'supabase-js/2 argo/0.1.121 argo-sync/old');
});

/* ─── ⑤ 귀속 대기 다시 시도(경우 표 C1~C5) ─── */
function runScript(root, body, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], { env: childEnv(root, { ARGO_SYNC: '0', ARGO_AGENT_LINK: '0', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no result\n${out.slice(-1500)}\n${err.slice(-1500)}`));
      resolve({ r: JSON.parse(line.slice(2)), out: out + err });
    });
  });
}
const guestCo = (root, id = 'guest-co') => {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, 'company.json'), JSON.stringify({ id, name: '게스트 회사', owner: 'captain', created: new Date().toISOString() }));
  writeFileSync(join(root, '.guest-mode.json'), JSON.stringify({ enabled: true }));
};

test('로그인 경로의 귀속이 실패하면 오류를 버리지 않고 귀속 대기 표지를 남기며, 같은 계정일 때만 10분 뒤 다시 시도한다(C1·C4)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-0121-claimdefer-'));
  guestCo(root);
  chmodSync(join(root, 'guest-co'), 0o555); // company.json 원자적 쓰기가 실패하게(귀속 실패 재현)
  const S = (rel) => JSON.stringify(srcUrl(rel));
  let res;
  try {
    res = await runScript(root, `
const ac = await import(${S('accountclaim.mjs')});
const fs = await import('node:fs');
const first = await ac.claimOrDefer('u1');
const pending = JSON.parse(fs.readFileSync(process.env.ARGO_ROOT + '/.claim-pending.json', 'utf8'));
fs.chmodSync(process.env.ARGO_ROOT + '/guest-co', 0o755);
const early = await ac.retryPendingClaim('u1');
const other = await ac.retryPendingClaim('u-other', { now: Date.now() + 11 * 60_000 });
const otherOwner = JSON.parse(fs.readFileSync(process.env.ARGO_ROOT + '/guest-co/company.json', 'utf8')).ownerId ?? null;
const later = await ac.retryPendingClaim('u1', { now: Date.now() + 11 * 60_000 });
const owner = JSON.parse(fs.readFileSync(process.env.ARGO_ROOT + '/guest-co/company.json', 'utf8')).ownerId ?? null;
process.stdout.write('\\n@@' + JSON.stringify({ first, pending: { uid: pending.uid, hasErr: !!pending.error, keys: Object.keys(pending).sort() }, early, other, otherOwner, later, owner,
  pendingLeft: fs.existsSync(process.env.ARGO_ROOT + '/.claim-pending.json'), guestLeft: fs.existsSync(process.env.ARGO_ROOT + '/.guest-mode.json') }) + '\\n');`);
  } finally { try { chmodSync(join(root, 'guest-co'), 0o755); } catch { /* 이미 */ } }
  const { r, out } = res;
  assert.ok(r.first.error, '로그인 라우트에는 { error }(종전 계약)');
  assert.match(out, /\[argo\] 게스트 회사 귀속 실패\(로그인은 성공/, '오류를 로그로 남긴다(auth/callback의 조용한 삼킴 제거)');
  assert.deepEqual(r.pending, { uid: 'u1', hasErr: true, keys: ['at', 'error', 'nextAt', 'uid'] }, '표지 = uid·시각·오류·다음 시도(토큰 없음)');
  assert.equal(r.early.skipped, 'wait', '10분 안에는 다시 하지 않는다');
  assert.equal(r.other.skipped, 'other-account', 'C4 다른 계정이 로그인했으면 그 계정으로 넘기지 않는다');
  assert.equal(r.otherOwner, null);
  assert.equal(r.later.claimed, 1, '같은 계정·때가 됨 → 같은 claimLocalToAccount로 귀속');
  assert.equal(r.owner, 'u1');
  assert.equal(r.pendingLeft, false, '성공하면 표지를 지운다');
  assert.equal(r.guestLeft, false, '게스트 표시도 지운다(종전 귀속과 같음)');
});

test('동기화 사이클 — 귀속 대기 표지(같은 계정)가 있으면 게스트 회사를 귀속해 올리고, 표지가 없으면(교차 사이트 confirm 세션) 귀속하지 않는다(C2·C3)', async () => {
  const run = async (pending) => {
    const fake = await startFakeSupabase({ plan: 'pro', userId: 'u1' }); fakes.push(fake);
    const root = await mkdtemp(join(tmpdir(), 'argo-0121-claimcycle-'));
    seedRoot(root, { url: fake.url, wsId: 'co-own' });
    guestCo(root);
    if (pending) writeFileSync(join(root, '.claim-pending.json'), JSON.stringify({ uid: pending, at: Date.now() - 60_000, error: 'fixture', nextAt: 0 }));
    const r = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '300' }, waitMs: 3_500 });
    const meta = JSON.parse(readFileSync(join(root, 'guest-co', 'company.json'), 'utf8'));
    return { r, meta, guestUploads: uploads(fake).filter((h) => h.k.includes('guest-co')).length, pendingLeft: existsSync(join(root, '.claim-pending.json')), guestLeft: existsSync(join(root, '.guest-mode.json')) };
  };
  const yes = await run('u1');
  assert.equal(yes.meta.ownerId, 'u1', 'C2 표지가 있으면 사이클이 귀속한다');
  assert.ok(yes.guestUploads > 0, '귀속한 회사를 바로 올린다(nudge)');
  assert.equal(yes.pendingLeft, false);
  assert.match(yes.r.out, /게스트 회사 귀속 다시 시도 성공 — 1개/);
  const no = await run(null);
  assert.equal(no.meta.ownerId, undefined, 'C3 표지 없음(교차 사이트 /auth/confirm으로 저장된 세션과 같은 상태) — 자동 귀속 없음(PR #1183 검수 유지)');
  assert.equal(no.guestUploads, 0);
  assert.equal(no.guestLeft, true, '게스트 표시도 그대로 — 남은 회사는 CSRF 검사를 거치는 [이 계정에 연결]이 받는다');
  const other = await run('u-attacker');
  assert.equal(other.meta.ownerId, undefined, 'C4 표지 uid ≠ 지금 세션');
});

test('로그인 라우트 세 곳(기기 로그인·앱 링크·OAuth 콜백)은 claimOrDefer를 쓰고, 콜백은 귀속 오류를 삼키지 않는다', () => {
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const cb = src('app/auth/callback/route.js');
  assert.match(cb, /if \(guestModeOn\(\)\) await claimOrDefer\(data\.session\.user\.id\);/);
  assert.equal(/claimLocalToAccount\([^)]*\)\.catch\(\(\) => \{\}\)/.test(cb), false, '조용한 삼킴(.catch(() => {}))이 돌아왔다');
  assert.match(src('app/api/device/login/route.js'), /if \(guestModeOn\(\)\) claimed = await claimOrDefer\(data\.session\.user\.id\);/);
  assert.match(src('app/api/device/link/route.js'), /if \(guestModeOn\(\)\) claimed = await claimOrDefer\(user\.id\);/);
  assert.equal(/claimOrDefer|claim-pending/.test(src('app/auth/confirm/route.js')), false, '교차 사이트 GET(confirm)은 귀속 대기 표지를 쓰지 않는다');
});
