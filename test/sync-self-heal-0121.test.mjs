// 0.1.121 핫픽스 — 고객 C(2026-10-30) 메인 PC가 0.1.120 뒤에도 동기화 사이클 첫 단계에서 5시간 멈춘 것을 앱이 스스로 풀게 한다.
// #1189(남은 페어링 자격·미래 시각 잠금·진단 꼬리표)에 더해: ① 잠금 회수(옛 판 사이드카·멈춘 ts) ② 사이클 감시(끝나지 않는 await면 루프 다시 시작)
// ④ 진단 꼬리표에 회수 이유·감시 재시작·귀속 실패 ⑤ 안전한 로그인 경로가 남긴 귀속 대기만 다시 시도(교차 사이트 confirm은 아님).
// 자식 프로세스 + 가짜 Supabase로 실제 루프(ensureSync)를 돌린다 — 루프는 끝나지 않는 타이머라 시험 프로세스 안에서 돌리지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { childEnv, srcUrl, seedRoot } from './helpers/sync-child.mjs';
import {
  lockTakeoverReason, olderLockHolder, LOCK_FROZEN_MS, LOCK_FUTURE_SLACK_MS, LOCK_TAKEOVER_WAIT_MS,
  syncLoopStalled, SYNC_WATCHDOG_MS, syncDiagTag, watchdogTick,
} from '../src/sync.mjs';

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
if (globalThis.__probe) process.stdout.write('\\n@@probe' + JSON.stringify(globalThis.__probe) + '\\n');
process.stdout.write('\\n@@' + JSON.stringify({ held: s.held, lastError: s.lastError, watchdogRestarts: globalThis.__argoSyncStatus?.watchdogRestarts ?? 0, busy: globalThis.__argoSyncCompanyBusy?.size ?? 0, pid: process.pid }) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], { env: childEnv(root, { ARGO_AGENT_LINK: '0', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`child timeout\n${err.slice(-2000)}`)); }, waitMs + 40_000);
    p.on('exit', () => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('@@{'));
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
  assert.equal(lockTakeoverReason({ pid: 4242, ts: now + LOCK_FUTURE_SLACK_MS + 5_000, ver: me }, { now, myVer: me, alive }), 'future', 'L5 미래 ts(시계 되돌림) + 살아 있는 pid(재사용 포함)');
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

test('사이클이 회사 밖의 끝나지 않는 await에 멈추면 감시가 루프를 다시 띄워 동기화가 이어진다(경우 표 W1)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  let hung = 0;
  // 회사 목록 단계(색인 RPC)의 첫 요청 하나만 영영 답하지 않는다(클라이언트 30초 시간 초과보다 먼저 감시가 잡는다). 회사 안의 멈춤은 아래 '옛 사이클이 잡은 회사' 시험 —
  // 그 회사는 옛 사이클이 놓을 때까지 새 루프가 건너뛴다(같은 회사 syncCompany가 겹치지 않는 쪽이 우선, #1190 검수 I1)
  fake.fault = (req, path) => (path.endsWith('/rpc/argo_sync_index') && hung++ === 0 ? 'hang' : null);
  const root = await mkdtemp(join(tmpdir(), 'argo-0121-watchdog-'));
  seedRoot(root, { url: fake.url, wsId: 'co-dog' });
  const r = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '300', ARGO_SYNC_WATCHDOG_MS: '1500' }, waitMs: 8_000 });
  assert.equal(hung >= 1, true, '시험이 실제로 멈춤을 만들었다');
  assert.match(r.out, /\[argo\] sync watchdog restart — \d+분 동안 사이클 진척 없음/);
  assert.ok(r.status.watchdogRestarts >= 1, `감시 재시작 수 ${r.status.watchdogRestarts}`);
  assert.ok(uploads(fake).length > 0, '새 루프가 회사를 올렸다(멈춘 옛 요청의 30초 시간 초과를 기다리지 않음)');
});

/* ─── ② 검수 I1(#1190) — 잠자기를 멈춤으로 보지 않고, 같은 회사 syncCompany는 한 프로세스에서 겹치지 않는다 ─── */
// 자식 안에서 manifest 요청(info·내려받기)의 동시 진행 수를 센다. jumpMs > 0이면 첫 manifest 요청 도중 벽시계만 건너뛴다(잠자기 흉내 — 타이머는 단조 시계라 제때 돈다).
const manifestProbe = (jumpMs) => `
const realNow = Date.now; let off = 0; Date.now = () => realNow() + off;
const realFetch = globalThis.fetch; let inflight = 0, jumped = false;
globalThis.__probe = { maxInflight: 0, manifestReqs: 0 };
globalThis.fetch = async (input, init) => {
  const m = String(input?.url ?? input).includes('__manifest__');
  if (m) {
    inflight++; globalThis.__probe.manifestReqs++; globalThis.__probe.maxInflight = Math.max(globalThis.__probe.maxInflight, inflight);
    if (${Number(jumpMs)} > 0 && !jumped) { jumped = true; setTimeout(() => { off += ${Number(jumpMs)}; }, 100); }
  }
  try { return await realFetch(input, init); } finally { if (m) inflight--; }
};
sync.ensureSync();`;
const probeOf = (out) => JSON.parse(out.match(/@@probe(\{.*\})/)?.[1] ?? 'null');

test('감시 박자 판정 — 박자가 예정의 2배 넘게 늦으면 잠자기(재시작 아님), 아니면 종전 멈춤 판정', () => {
  const now = 1_800_000_000_000;
  const st = { loopStartAt: now - 60 * 60_000, beatAt: now - 11 * 60_000, cycling: true };
  assert.equal(watchdogTick(st, { now, lastTickAt: now - 15 * 60_000, intervalMs: 60_000 }), 'sleep', '15분 잠들었다 깸 — 흔적이 오래돼도 멈춤으로 보지 않는다');
  assert.equal(watchdogTick(st, { now, lastTickAt: now - 60_000, intervalMs: 60_000 }), 'stalled', '박자는 제때 — 진짜 멈춤');
  assert.equal(watchdogTick({ ...st, beatAt: now - 1_000 }, { now, lastTickAt: now - 60_000, intervalMs: 60_000 }), 'ok');
  assert.equal(watchdogTick(st, { now, lastTickAt: now - 119_000, intervalMs: 60_000 }), 'stalled', '2배 이하의 늦음은 잠자기로 보지 않는다');
});

test('잠자기 흉내(manifest 요청 도중 벽시계 2.5초 건너뜀)에도 감시가 루프를 다시 띄우지 않고, 같은 회사 요청이 겹치지 않는다(검수 I1 재현)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  let delayed = 0;
  fake.fault = (req, path) => (path.includes('__manifest__') && delayed++ === 0 ? 1_000 : null); // 첫 manifest 요청만 1초 늦게 — 감시(1.5초)보다 짧아 잠자기가 없으면 멈춤이 아니다
  const root = await mkdtemp(join(tmpdir(), 'argo-0121-sleep-'));
  seedRoot(root, { url: fake.url, wsId: 'co-sleep' });
  const r = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '300', ARGO_SYNC_WATCHDOG_MS: '1500' }, waitMs: 4_000, script: manifestProbe(2_500) });
  const probe = probeOf(r.out);
  assert.ok(probe && probe.manifestReqs > 0, '시험이 실제로 manifest 요청 중 잠자기를 흉내 냈다');
  assert.equal(r.status.watchdogRestarts, 0, '잠자기는 재시작 사유가 아니다(진단 꼬리 w도 오르지 않는다)');
  assert.doesNotMatch(r.out, /sync watchdog restart/);
  assert.equal(probe.maxInflight, 1, `같은 회사 manifest 요청이 동시에 ${probe.maxInflight}개 — 두 사이클이 겹쳤다`);
  assert.ok(uploads(fake).length > 0, '동기화는 이어진다');
});

test('진짜 멈춤 뒤 옛 사이클이 늦게 돌아와도 새 루프는 옛 사이클이 잡은 회사를 건너뛴다 — 같은 회사 syncCompany가 겹치지 않는다', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  let delayed = 0;
  fake.fault = (req, path) => (path.includes('__manifest__') && delayed++ === 0 ? 4_000 : null); // 첫 manifest 요청이 4초 — 감시(1.5초)가 새 루프를 띄운 뒤 옛 사이클이 돌아온다
  const root = await mkdtemp(join(tmpdir(), 'argo-0121-busy-'));
  seedRoot(root, { url: fake.url, wsId: 'co-busy' });
  const r = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '300', ARGO_SYNC_WATCHDOG_MS: '1500' }, waitMs: 7_000, script: manifestProbe(0) });
  const probe = probeOf(r.out);
  assert.ok(r.status.watchdogRestarts >= 1, '멈춤으로 보고 새 루프를 띄웠다(시험 전제)');
  assert.match(r.out, /앞 사이클이 아직 이 회사를 처리 중 — 이번 사이클은 건너뜀/);
  assert.equal(probe.maxInflight, 1, `같은 회사 manifest 요청이 동시에 ${probe.maxInflight}개 — 두 사이클이 겹쳤다`);
  assert.ok(uploads(fake).length > 0, '옛 사이클이 끝난 뒤 동기화가 이어진다');
  assert.equal(r.status.busy, 0, '옛 사이클이 회사를 놓았다 — 남으면 새 루프가 그 회사를 영영 건너뛴다');
});

/* ─── ④ 진단 꼬리표 확장(#1189 형식 뒤에 값이 있을 때만) ─── */
test('진단 꼬리표 — 잠금 회수 이유·감시 재시작·귀속 실패를 값이 있을 때만 덧붙이고, #1189 형식은 그대로다', () => {
  const held = { phase: 'lock-wait', errorCode: 'other-process', lockWait: true, lockVer: '0.1.119', noOwner: 1, foreignOwner: 0 };
  assert.equal(syncDiagTag(held), 'sync/lock-wait.other-process.L0.1.119.o1f0.c0', '추가 값이 없으면 종전 그대로');
  assert.equal(syncDiagTag(held, { takeover: 'older', watchdog: 2, claimError: true }), 'sync/lock-wait.other-process.L0.1.119.o1f0.c0.tolder.w2.k1');
  assert.equal(syncDiagTag(held, { takeover: 'a b/<x>' }).endsWith('.tabx'), true, '헤더를 깨는 글자는 지운다');
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
  const S = (rel) => JSON.stringify(srcUrl(rel));
  // 귀속 실패 주입 — OS와 무관하게(chmod는 Windows에서 쓰기를 막지 못해 귀속이 성공했다, #1190 Windows CI). 로더 훅이 workspace.mjs의
  // updateCompany 첫머리에 '주입 플래그가 켜져 있으면 던진다' 한 줄을 끼운다(제품 코드는 그대로). 훅은 accountclaim을 부르기 전에 등록한다.
  const MARK = 'export async function updateCompany(wsId, patch) {';
  const hook = `export async function load(url, context, next) {
  const r = await next(url, context);
  if (!url.endsWith('/src/workspace.mjs')) return r;
  const src = String(r.source);
  if (!src.includes(${JSON.stringify(MARK)})) throw new Error('주입 지점 없음: updateCompany 머리가 바뀌었다');
  return { ...r, source: src.replace(${JSON.stringify(MARK)}, ${JSON.stringify(MARK)} + " if (globalThis.__failUpdateCompany) throw new Error('주입 실패: updateCompany');") };
}`;
  const res = await runScript(root, `
const { register } = await import('node:module');
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hook)}));
const ac = await import(${S('accountclaim.mjs')});
const fs = await import('node:fs');
globalThis.__failUpdateCompany = true;
const first = await ac.claimOrDefer('u1');
const pending = JSON.parse(fs.readFileSync(process.env.ARGO_ROOT + '/.claim-pending.json', 'utf8'));
globalThis.__failUpdateCompany = false;
const early = await ac.retryPendingClaim('u1');
const other = await ac.retryPendingClaim('u-other', { now: Date.now() + 11 * 60_000 });
const otherOwner = JSON.parse(fs.readFileSync(process.env.ARGO_ROOT + '/guest-co/company.json', 'utf8')).ownerId ?? null;
const later = await ac.retryPendingClaim('u1', { now: Date.now() + 11 * 60_000 });
const owner = JSON.parse(fs.readFileSync(process.env.ARGO_ROOT + '/guest-co/company.json', 'utf8')).ownerId ?? null;
process.stdout.write('\\n@@' + JSON.stringify({ first, pending: { uid: pending.uid, hasErr: !!pending.error, keys: Object.keys(pending).sort() }, early, other, otherOwner, later, owner,
  pendingLeft: fs.existsSync(process.env.ARGO_ROOT + '/.claim-pending.json'), guestLeft: fs.existsSync(process.env.ARGO_ROOT + '/.guest-mode.json') }) + '\\n');`);
  const { r, out } = res;
  assert.match(String(r.first.error), /주입 실패: updateCompany/, '로그인 라우트에는 { error }(종전 계약) — 주입한 실패가 실제로 났다');
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
