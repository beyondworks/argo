// withDirLock의 오래된 잠금 회수 경쟁 — #791 독립 검수 MEDIUM-3(2026-10-01).
// 결함: 두 프로세스가 같은 오래된 잠금을 보고 각자 stat → rm 하면, 늦게 rm한 쪽이 먼저 회수해 새로 잡은 잠금까지 지워 둘이 동시에
// 잠금 안에 들어간다(검수 실측: 2개 60회 중 7회 겹침). withDirLock은 자격 파일·기기 세션·게이트웨이 큐가 같이 쓴다.
// 방법: 매 회차 오래된(크래시가 남긴) 잠금을 깔고 두 자식이 같은 순간 withDirLock에 들어간다. 잠금 안에서 표식 파일을 배타 생성(wx)해
// 이미 있으면 겹침으로 센다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

const MUTEX = new URL('../src/mutex.mjs', import.meta.url).href;
const ROUNDS = 60; const PERIOD = 250;

function racer(dir, idx, t0, signal) {
  const script = `
const { withDirLock } = await import(${JSON.stringify(MUTEX)});
const { mkdir, utimes, writeFile, rm } = await import('node:fs/promises');
const { join } = await import('node:path');
const lock = join(${JSON.stringify(dir)}, 'x.lock');
const mark = join(${JSON.stringify(dir)}, 'inside');
const wait = (at) => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
let overlaps = 0, entered = 0, staged = 0, maxWait = 0; const other = {}, lockErr = {};
for (let i = 0; i < ${ROUNDS}; i++) {
  const at = ${t0} + i * ${PERIOD};
  if (${idx} === 0) { // 회차 시작 전에 크래시가 남긴 오래된 잠금을 깐다 — 내가 새로 만든 폴더일 때만 시각을 돌린다
    // (앞 회차가 늦게 끝나 누가 아직 쥐고 있으면 mkdir이 실패한다. 그때 시각을 돌리면 살아 있는 잠금을 오래된 것으로 만들어
    //  하네스가 겹침을 지어낸다 — Windows CI 실측 "겹침 3회"의 원인 후보, #791 재검수)
    await wait(at - 120);
    const made = await mkdir(lock).then(() => true, () => false);
    if (made) { const old = new Date(Date.now() - 60_000); await utimes(lock, old, old).catch(() => {}); staged++; }
  }
  await wait(at);
  const asked = Date.now();
  await withDirLock(lock, async () => {
    entered++; maxWait = Math.max(maxWait, Date.now() - asked);
    try { await writeFile(mark, String(process.pid), { flag: 'wx' }); } catch (e) {
      // 겹침은 EEXIST(다른 프로세스가 잠금 안에서 만든 표식이 아직 있음)만이다. Windows는 방금 지운 파일이 "삭제 대기"로 남아 EPERM·EBUSY를
      // 낼 수 있다 — 그건 잠금 결함이 아니라 파일 시스템 상태라 따로 센다.
      if (e?.code === 'EEXIST') overlaps++; else other[e?.code ?? 'unknown'] = (other[e?.code ?? 'unknown'] ?? 0) + 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
    await rm(mark, { force: true });
  }, { staleMs: 5_000, retryMs: 5, timeoutMs: 15_000 }).catch((e) => { lockErr[e?.code ?? 'unknown'] = (lockErr[e?.code ?? 'unknown'] ?? 0) + 1; });
}
process.stdout.write('@@' + JSON.stringify({ overlaps, entered, staged, other, maxWait, lockErr }) + '\\n');`;
  return new Promise((resolve, reject) => {
    // signal — 테스트가 끝나거나 시간 초과로 취소되면 자식을 끝낸다. 없으면 회수가 막히는 결함에서 자식이 회차마다 대기 상한을 다 쓰며 남아 CI 잡을 붙잡는다.
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    p.on('error', reject);
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      return line ? resolve(JSON.parse(line.slice(2))) : reject(new Error(err || out));
    });
  });
}

test('오래된 잠금을 두 프로세스가 동시에 회수해도 잠금 안에 둘이 같이 들어가지 않는다(60회차 겹침 0)', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-mutex-race-'));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now() + 1500;
  const [a, b] = await Promise.all([racer(dir, 0, t0, t.signal), racer(dir, 1, t0, t.signal)]);
  assert.equal(a.overlaps + b.overlaps, 0, `겹침 ${a.overlaps + b.overlaps}회 (오래된 잠금 깐 회차 ${a.staged}, 표식 기타 오류 ${JSON.stringify({ ...a.other, ...b.other })})`);
  assert.ok(a.staged >= ROUNDS / 2, `오래된 잠금을 깐 회차가 너무 적다(${a.staged}) — 회수 경로를 충분히 타지 않았다`);
  // 대기 상한(15초)은 회수 복구 시간(staleMs 5초 — 크래시로 남은 2차 잠금도 이만큼 지나야 치운다)보다 길어야 "막힘"과 "느림"이 갈린다.
  // 예전 3초는 그보다 짧아, 느린 Windows CI에서 한 번의 대기가 3초를 넘긴 것만으로 119/120이 났다(2026-10-01 PR #806 실행 36878124419).
  assert.equal(a.entered + b.entered, ROUNDS * 2, `모든 회차에 둘 다 결국 잠금을 얻는다(회수가 막히지 않는다) — 실패 ${JSON.stringify({ ...a.lockErr, ...b.lockErr })}, 최장 대기 ${Math.max(a.maxWait, b.maxWait)}ms`);
});

test('2차 잠금을 늦게 얻은 쪽은 그사이 새로 잡힌 잠금을 지우지 않는다(재 stat) — 순서를 훅으로 고정한 결정적 재현', async () => {
  const { withDirLock } = await import('../src/mutex.mjs');
  const { mkdir, utimes } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'argo-mutex-order-'));
  const lock = join(dir, 'y.lock');
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000); await utimes(lock, old, old); // 크래시가 남긴 오래된 잠금
  let inside = 0, maxInside = 0;
  const enter = async (hold) => { inside++; maxInside = Math.max(maxInside, inside); await hold; inside--; };
  // B: 오래된 잠금을 보고 회수하려다 2차 잠금 직전에 멈춘다
  let resumeB; const bPaused = new Promise((r) => { resumeB = r; });
  let bAtGuard; const bReached = new Promise((r) => { bAtGuard = r; });
  let releaseB; const holdB = new Promise((r) => { releaseB = r; });
  const opts = { staleMs: 5_000, retryMs: 5, timeoutMs: 3_000 };
  let firstB = true;
  const B = withDirLock(lock, () => enter(holdB), { ...opts, _hooks: { beforeGuard: async () => { if (firstB) { firstB = false; bAtGuard(); await bPaused; } } } });
  await bReached;
  // A: 그사이 회수 → 새 잠금 획득 → 잠금 안에서 머문다
  let releaseA; const holdA = new Promise((r) => { releaseA = r; });
  let aIn; const aEntered = new Promise((r) => { aIn = r; });
  const A = withDirLock(lock, async () => { aIn(); await enter(holdA); }, opts);
  await aEntered;
  resumeB(); // B가 2차 잠금을 늦게 얻는다 — 재 stat 없이 지우면 A의 새 잠금이 사라지고 B도 들어온다
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(maxInside, 1, 'A가 잠금 안에 있는 동안 B가 들어왔다 — 늦은 회수가 새 잠금을 지웠다');
  releaseA(); await A;
  releaseB(); await B;
  assert.equal(maxInside, 1);
});
