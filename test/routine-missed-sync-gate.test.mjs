// 놓친 루틴 회차 판정의 동기화 관문(fix/routine-failure-visible 검수 MEDIUM).
// 동기화가 켜진 기기는 기동·잠자기 복귀 직후 routines.json이 낡아 있을 수 있다(다른 기기가 그동안 실행한 lastRun을 아직 못 받음).
// 그 사본으로 놓친 회차를 판정하면 ① 다른 기기가 실제로 실행한 회차를 '기기가 꺼져 있어 건너뛰었습니다'로 알리고 ② routines.json에 missed를 써
// 로컬 수정 시각이 최신이 되어, 동기화의 json 충돌 처리(최근 수정 시각이 이김)가 낡은 사본으로 원격(다른 기기의 lastRun·편집·새 루틴)을 덮는다.
// 잠그는 행동: 동기화가 켜져 있으면 이 프로세스가 깨어난 뒤 그 회사의 동기화 사이클을 한 번 끝내기 전까지 판정하지 않는다(쓰기 0·알림 0).
// 동기화가 꺼져 있으면 이 기기가 정본이라 종전대로 판정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-rtn-syncgate-'));
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[key];
// 동기화 on을 강제 — 가짜 기기 세션(전부 가짜 값, 네트워크 호출 없음). tg-token-claims.test.mjs와 같은 방법.
await writeFile(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://fake.supabase.co', anonKey: 'fake-anon', refresh_token: 'fake-r', access_token: 'fake-a', user: { id: 'fake-uid' } }));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { addRoutine, loadRoutines } = await import('../src/routines.mjs');
const { readEvents } = await import('../src/events.mjs');
const { onNotify } = await import('../src/notify.mjs');
const { runDueRoutines, noteSchedulerTick, RESUME_GAP_MS } = await import('../src/scheduler.mjs');
const { syncOn, companySyncedSince } = await import('../src/sync.mjs');
const { writeJsonAtomic } = await import('../src/jsonstore.mjs');

const status = globalThis.__argoSyncStatus; // 동기화 사이클이 회사마다 남기는 결과(sync.mjs) — 사이클을 돌리는 대신 결과를 심는다
const kst = (d, hm) => new Date(`${d}T${hm}:00+09:00`);
const NOW = kst('2026-10-08', '15:00'); // 오늘 09:00 슬롯은 catch-up 창(4h) 밖 — 실행 판정(claimRoutine)이 끼지 않는다
const WOKE = NOW.getTime() - 5 * 60_000; // 이 프로세스가 깨어난(기동·잠자기 복귀) 시각

let seq = 0;
async function staleCompany() {
  const ws = `syncgate-${++seq}`;
  await createCompany(ws, '동기화 관문', 'owner', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: 알파\nrole: 검증\n---\n검증용.\n');
  // 이 기기 사본: lastRun이 일주일 전에 멈춰 있다(다른 기기가 그 뒤로 매일 실행했지만 아직 못 받은 상태)
  const r = await addRoutine(ws, { agentSlug: 'alpha', title: '아침 보고', prompt: '보고하라', schedule: { type: 'daily', times: ['09:00'], tz: 'Asia/Seoul' } });
  const raw = await loadRoutines(ws);
  Object.assign(raw.find((x) => x.id === r.id), { lastRun: kst('2026-10-01', '09:00').toISOString(), created: '2026-09-01T00:00:00.000Z', editedAt: '2026-09-01T00:00:00.000Z' });
  await writeJsonAtomic(paths(ws).routines, raw);
  return ws;
}
async function tick(ws, opts = {}) {
  const before = await readFile(paths(ws).routines, 'utf8');
  const got = [];
  const off = onNotify((e) => { if (e.wsId === ws && e.type === 'routine') got.push(e); });
  await runDueRoutines(ws, NOW, { runFn: async () => { throw new Error('실행되면 안 된다'); }, awakeSince: WOKE, ...opts });
  await new Promise((r) => setTimeout(r, 20)); off();
  return {
    wrote: before !== await readFile(paths(ws).routines, 'utf8'),
    skipped: (await readEvents(ws)).filter((e) => e.type === 'routine-skipped').length,
    notices: got.length,
  };
}

test('전제 — 이 테스트 프로세스는 동기화 on(가짜 기기 세션)', () => {
  assert.equal(syncOn(), true);
});

test('B14: 깨어난 뒤 그 회사 동기화가 아직 없으면(낡은 routines.json) 놓친 회차를 판정하지 않는다 — 쓰기 0·활동 0·알림 0', async () => {
  const ws = await staleCompany();
  delete status.companies[ws];
  assert.deepEqual(await tick(ws), { wrote: false, skipped: 0, notices: 0 },
    '다른 기기가 실행한 회차를 "꺼져 있어 건너뛰었다"로 알리거나, 낡은 사본에 missed를 써 원격을 덮을 수 있는 쓰기를 만들면 안 된다');
});

test('B15: 잠자기 복귀 — 깨기 전에 끝난 동기화 결과만 있으면 아직 판정하지 않는다', async () => {
  const ws = await staleCompany();
  status.companies[ws] = { ts: WOKE - 60_000, pulled: 0, pushed: 0, failed: 0 };
  assert.deepEqual(await tick(ws), { wrote: false, skipped: 0, notices: 0 });
});

test('B17: 깨어난 뒤 사이클이 오류·재시도 대기·업로드 거절 대기면 다음 사이클까지 미룬다', async () => {
  for (const entry of [{ error: 'syncgate: 파일 1건 실패' }, { skipped: 'retry-backoff' }, { skipped: 'upload-denied' }]) {
    const ws = await staleCompany();
    status.companies[ws] = { ts: WOKE + 1_000, ...entry };
    assert.deepEqual(await tick(ws), { wrote: false, skipped: 0, notices: 0 }, JSON.stringify(entry));
  }
});

test('B16: 깨어난 뒤 그 회사 사이클이 끝났으면(정상·유휴 확인·free-plan·foreign-owner) 종전대로 남긴다', async () => {
  for (const entry of [{ pulled: 1, pushed: 0, failed: 0 }, { skipped: 'idle-probe', failed: 0 }, { skipped: 'free-plan' }, { skipped: 'foreign-owner' }]) {
    const ws = await staleCompany();
    status.companies[ws] = { ts: WOKE + 1_000, ...entry };
    const got = await tick(ws);
    assert.equal(got.wrote, true, JSON.stringify(entry));
    assert.equal(got.skipped, 1, JSON.stringify(entry));
    assert.equal(got.notices, 1, JSON.stringify(entry));
  }
});

test('B18: 동기화가 꺼져 있으면 이 기기가 정본 — 동기화 결과 없이도 종전대로 남긴다', async () => {
  const ws = await staleCompany();
  delete status.companies[ws];
  process.env.ARGO_SYNC = '0';
  try {
    assert.equal(syncOn(), false);
    const got = await tick(ws);
    assert.equal(got.skipped, 1); assert.equal(got.notices, 1);
  } finally { delete process.env.ARGO_SYNC; }
});

test('companySyncedSince — 판정 표(순수 부분)', () => {
  const ws = 'syncgate-table';
  delete status.companies[ws];
  assert.equal(companySyncedSince(ws, WOKE), false, '결과 없음');
  status.companies[ws] = { ts: WOKE };
  assert.equal(companySyncedSince(ws, WOKE), true, '깨어난 시각과 같은 시각에 끝난 사이클');
  status.companies[ws] = { ts: WOKE - 1 };
  assert.equal(companySyncedSince(ws, WOKE), false);
  delete status.companies[ws];
});

test('B19: 깨어남 판정 — 틱 사이 벽시계 간격이 RESUME_GAP_MS를 넘으면 그 틱이 새 깨어난 시각이 된다', () => {
  const s = { since: 1_000, lastTick: 0 };
  assert.equal(noteSchedulerTick(s, 61_000), 1_000, '첫 틱 — 기동 시각 그대로');
  assert.equal(noteSchedulerTick(s, 121_000), 1_000, '평소 60초 간격');
  const woke = 121_000 + RESUME_GAP_MS + 1;
  assert.equal(noteSchedulerTick(s, woke), woke, '잠자기에서 돌아온 틱');
  assert.equal(noteSchedulerTick(s, woke + 60_000), woke, '그 뒤 평소 틱은 깨어난 시각을 유지');
  assert.ok(RESUME_GAP_MS > 60_000 && RESUME_GAP_MS <= 10 * 60_000, '60초 틱보다 넉넉하고, 잠자기는 놓치지 않을 만큼 짧다');
});

/* ─── 3차 검수 LOW(1) — 관문이 영영 닫혀 있던 두 경우를 실제 동기화 루프(ensureSync, 자식 프로세스 + 가짜 Supabase)로 잠근다 ───
   ① 주인 없는 회사(게스트로 쓰다 로그인 뒤 귀속하지 않음)는 동기화 대상이 아니라(collectLocalTargets가 건너뜀) 사이클 결과가 남지 않아
      놓친 회차 판정이 영원히 미뤄졌다 → 사이클이 'no-owner'로 표시하고 관문은 참(이 기기가 정본). 화면용 상태(syncStatus·syncStatusFor)에는
      싣지 않는다 — 클라우드 사본이 없는 회사에 '클라우드 사본 삭제 예정' 같은 안내가 붙지 않게(설정 화면 mine 근사).
   ② 같은 데이터 루트의 다른 살아 있는 프로세스가 동기화 잠금을 쥐면 이 프로세스(스케줄러)에는 사이클 결과가 쌓이지 않는다 → 판정을 미루고,
      미룬다는 사실을 프로세스당 한 번 로그로 남긴다(무증상 보류가 아니게). */
const { spawn } = await import('node:child_process');
const { startFakeSupabase } = await import('./helpers/fake-supabase-http.mjs');
const { seedRoot, childEnv, srcUrl } = await import('./helpers/sync-child.mjs');

/** 자식: 회사 둘(주인 있는 co-own, 주인 없는 guest-ws)에 일주일 낡은 daily 09:00 루틴을 깔고 동기화 루프를 켠 뒤, 사이클을 기다려
    놓친 회차 판정(runDueRoutines)을 직접 돌린다. 반환: 회사별 관문·건너뜀 기록 수·보류 로그 줄 수·화면용 상태. */
async function runGateChild(root, { holdLockPid = null } = {}) {
  if (holdLockPid) await writeFile(join(root, '.sync-process.lock'), JSON.stringify({ pid: holdLockPid, ts: Date.now() }));
  const S = (rel) => JSON.stringify(srcUrl(rel));
  const script = `
const lines = [];
for (const k of ['log', 'warn']) { const orig = console[k]; console[k] = (...a) => { lines.push(a.join(' ')); orig(...a); }; }
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const T0 = Date.now();
const { mkdir, writeFile } = await import('node:fs/promises');
const { join } = await import('node:path');
const { createCompany, paths } = await import(${S('workspace.mjs')});
const { addRoutine, loadRoutines } = await import(${S('routines.mjs')});
const { writeJsonAtomic } = await import(${S('jsonstore.mjs')});
const { readEvents } = await import(${S('events.mjs')});
await createCompany('guest-ws', '게스트 회사', 'owner', null, 'ko');
for (const ws of ['co-own', 'guest-ws']) {
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\\nname: 알파\\nrole: 검증\\n---\\n검증용.\\n');
  const r = await addRoutine(ws, { agentSlug: 'alpha', title: '아침 보고', prompt: '보고하라', schedule: { type: 'daily', times: ['09:00'], tz: 'Asia/Seoul' } });
  const raw = await loadRoutines(ws);
  Object.assign(raw.find((x) => x.id === r.id), { lastRun: '2026-10-01T00:00:00.000Z', created: '2026-09-01T00:00:00.000Z', editedAt: '2026-09-01T00:00:00.000Z' });
  await writeJsonAtomic(paths(ws).routines, raw);
}
const sync = await import(${S('sync.mjs')});
const { runDueRoutines } = await import(${S('scheduler.mjs')});
sync.ensureSync();
const ready = () => ${holdLockPid ? `/다른 프로세스/.test(sync.syncStatus().lastError)` : `Number(globalThis.__argoSyncStatus.companies['co-own']?.ts) >= T0`};
for (const t0 = Date.now(); !ready() && Date.now() - t0 < 30000;) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 1200)); // 사이클(300ms 주기)이 몇 번 더 돌게 — 잠금을 못 얻은 사이클의 회사 수집까지 끝나도록
const NOW = new Date('2026-10-08T15:00:00+09:00');
const tick = (ws) => runDueRoutines(ws, NOW, { runFn: async () => { throw new Error('실행되면 안 된다'); }, awakeSince: T0 });
const out = { ready: ready(), lastError: sync.syncStatus().lastError, gate: {}, skipped: {}, entry: {} };
for (const ws of ['co-own', 'guest-ws']) out.gate[ws] = sync.companySyncedSince(ws, T0);
for (const ws of ['co-own', 'guest-ws']) { await tick(ws); await tick(ws); await tick(ws); }
for (const ws of ['co-own', 'guest-ws']) {
  out.skipped[ws] = (await readEvents(ws)).filter((e) => e.type === 'routine-skipped').length;
  out.entry[ws] = globalThis.__argoSyncStatus.companies[ws] ?? null;
}
out.deferLogs = lines.filter((l) => /판정 보류/.test(l)).length;
out.screenKeys = Object.keys(sync.syncStatus().companies);
out.guestScreen = sync.syncStatusFor('guest-ws').companies;
process.stdout.write('\\n@@' + JSON.stringify(out) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, { ARGO_SYNC_CYCLE_MS: '300' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (c) => { o += c; }); p.stderr.on('data', (c) => { e += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${e.slice(-1500)}`)); }, 60_000);
    p.on('exit', () => { clearTimeout(t); const line = o.split('\n').find((l) => l.startsWith('@@')); line ? resolve(JSON.parse(line.slice(2))) : reject(new Error(`no result\n${o.slice(-1500)}\n${e.slice(-1500)}`)); });
  });
}

test('B24: 주인 없는 회사는 동기화 대상이 아니다 — 사이클이 no-owner로 표시해 관문이 열리고 놓친 회차를 남긴다. 화면용 상태에는 싣지 않는다', { timeout: 90_000 }, async (t) => {
  const fake = await startFakeSupabase({ plan: 'pro' }); t.after(() => fake.close());
  const root = await mkdtemp(join(tmpdir(), 'argo-rtn-gate-noowner-'));
  seedRoot(root, { url: fake.url, wsId: 'co-own' });
  const out = await runGateChild(root);
  assert.equal(out.ready, true, `전제: co-own 사이클이 끝났다 ${JSON.stringify(out)}`);
  assert.equal(out.entry['co-own']?.error ?? null, null, `전제: co-own 사이클은 오류 없이 끝났다 ${JSON.stringify(out.entry['co-own'])}`);
  assert.equal(out.gate['guest-ws'], true, `주인 없는 회사의 관문이 열린다(이 기기가 정본): ${JSON.stringify(out.entry['guest-ws'])}`);
  assert.equal(out.entry['guest-ws']?.skipped, 'no-owner');
  assert.equal(out.skipped['guest-ws'], 1, '놓친 회차를 활동 기록에 한 번 남긴다(세 번 틱해도 한 번)');
  assert.equal(out.gate['co-own'], true, '주인 있는 회사는 그 회사 사이클이 끝났으니 열린다(B16의 실제 사이클판)');
  assert.equal(out.skipped['co-own'], 1);
  assert.equal(out.deferLogs, 0, '이 프로세스가 동기화를 돌리면 보류 로그는 없다');
  assert.ok(!out.screenKeys.includes('guest-ws'), `화면용 상태에 주인 없는 회사를 싣지 않는다: ${out.screenKeys}`);
  assert.deepEqual(out.guestScreen, {}, '주인 없는 회사 화면에는 동기화 기록이 없다(종전과 같다)');
});

test('B25: 같은 데이터 루트의 다른 프로세스가 동기화 잠금을 쥐면 주인 있는 회사의 판정은 미루고, 미룬다는 로그를 프로세스당 한 번 남긴다 — 주인 없는 회사는 판정한다', { timeout: 90_000 }, async (t) => {
  const fake = await startFakeSupabase({ plan: 'pro' }); t.after(() => fake.close());
  const root = await mkdtemp(join(tmpdir(), 'argo-rtn-gate-lock-'));
  seedRoot(root, { url: fake.url, wsId: 'co-own' });
  const out = await runGateChild(root, { holdLockPid: process.pid }); // 이 테스트 프로세스가 살아 있는 잠금 주인
  assert.equal(out.ready, true, `전제: 잠금을 못 얻은 사이클이 돌았다 ${out.lastError}`);
  assert.equal(out.gate['co-own'], false, '이 프로세스는 co-own 사본이 최신인지 모른다');
  assert.equal(out.skipped['co-own'], 0, '낡았을 수 있는 사본으로 놓친 회차를 남기지 않는다');
  assert.equal(out.deferLogs, 1, `판정 보류 로그는 프로세스당 한 번(틱 세 번): ${out.deferLogs}`);
  assert.equal(out.gate['guest-ws'], true, '주인 없는 회사는 어느 프로세스가 동기화하든 이 기기가 정본');
  assert.equal(out.skipped['guest-ws'], 1);
});
