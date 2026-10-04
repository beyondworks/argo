// 진단 전용(PR에 넣지 않음) — test/mutex-reclaim-race.test.mjs 첫 테스트와 같은 경쟁을 돌리되,
// withDirLock 안의 fs 호출(대상·결과 코드·걸린 시간·stat이 본 잠금 나이)과 이벤트 루프 지연을 전부 기록한다.
// 제품 코드는 그대로 쓴다: src/mutex.mjs 소스를 읽어 fs만 기록용 래퍼로 바꿔 끼운다(test/mutex-windows.test.mjs와 같은 방식).
// 사용: node race-trace.mjs <repoRoot> <runs> <label> [rounds=60] [outDir]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repo = resolve(process.argv[2] ?? '.');
const RUNS = +(process.argv[3] ?? 1);
const LABEL = process.argv[4] ?? 'local';
const ROUNDS = +(process.argv[5] ?? 60);
const OUT = process.argv[6] ?? null;
const PERIOD = 250;
const OPTS = { staleMs: 5_000, retryMs: 5, timeoutMs: +(process.env.DIAG_TIMEOUT_MS ?? 3_000) }; // 기본은 테스트와 같은 3초 — 환경 변수는 출력 경로 자체 점검용
const MUTEX_PATH = join(repo, 'src', 'mutex.mjs');
if (OUT) mkdirSync(OUT, { recursive: true });

const childScript = (dir, idx, t0) => `
const real = await import('node:fs/promises');
const { join } = await import('node:path');
const src = (await real.readFile(${JSON.stringify(MUTEX_PATH)}, 'utf8')).replace("await import('node:fs/promises')", 'fs').replaceAll('export ', '');
const T0 = ${t0};
const lock = join(${JSON.stringify(dir)}, 'x.lock');
const mark = join(${JSON.stringify(dir)}, 'inside');
const tag = (p) => p.endsWith('.reclaim') ? 'guard' : p.endsWith('x.lock') ? 'lock' : p.endsWith('inside') ? 'mark' : 'parent';
let cur = null; const slow = []; const all = [];
const wrap = (name) => async (p, ...args) => {
  const s = Date.now(); const h = performance.now(); let code = 'ok', age;
  try { const r = await real[name](p, ...args); if (name === 'stat') age = Math.round(s - r.mtimeMs); return r; }
  catch (e) { code = e?.code ?? String(e); throw e; }
  finally {
    const ev = [s - T0, name, tag(String(p)), code, Math.round(performance.now() - h)];
    if (age !== undefined) ev.push(age);
    if (cur) cur.push(ev);
    if (ev[4] >= 300) slow.push(ev);
  }
};
const fs = { mkdir: wrap('mkdir'), rm: wrap('rm'), stat: wrap('stat'), utimes: wrap('utimes'), writeFile: wrap('writeFile') };
const withDirLock = new Function('fs', 'process', src + '; return withDirLock;')(fs, process);
// 이벤트 루프 지연 — 50ms 타이머가 300ms 이상 늦으면 기록(프로세스가 멈췄는지, fs 호출만 느렸는지 가른다)
const lags = []; let expect = Date.now() + 50;
const lagTimer = setInterval(() => { const now = Date.now(); const lag = now - expect; if (lag >= 300) lags.push([now - T0, lag]); expect = now + 50; }, 50);
const wait = (at) => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
let overlaps = 0, entered = 0, staged = 0; const other = {}, lockErr = {}; const rounds = [];
for (let i = 0; i < ${ROUNDS}; i++) {
  const at = T0 + i * ${PERIOD};
  if (${idx} === 0) {
    await wait(at - 120);
    cur = []; const made = await fs.mkdir(lock).then(() => true, () => false);
    if (made) { const old = new Date(Date.now() - 60_000); await fs.utimes(lock, old, old).catch(() => {}); staged++; }
    all.push({ i, stage: made, ops: cur }); cur = null;
  }
  await wait(at);
  cur = []; const asked = Date.now(); let enteredAt = null, code = null, released = null;
  try {
    await withDirLock(lock, async () => {
      enteredAt = Date.now(); entered++;
      try { await fs.writeFile(mark, String(process.pid), { flag: 'wx' }); } catch (e) {
        if (e?.code === 'EEXIST') overlaps++; else other[e?.code ?? 'unknown'] = (other[e?.code ?? 'unknown'] ?? 0) + 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 15));
      await fs.rm(mark, { force: true });
    }, ${JSON.stringify(OPTS)});
  } catch (e) { code = e?.code ?? 'unknown'; if (!enteredAt) lockErr[code] = (lockErr[code] ?? 0) + 1; }
  released = Date.now();
  rounds.push([i, asked - T0, enteredAt ? enteredAt - asked : null, released - asked, code]);
  all.push({ i, asked: asked - T0, enter: enteredAt ? enteredAt - T0 : null, done: released - T0, code, ops: cur });
  cur = null;
}
clearInterval(lagTimer);
process.stdout.write('@@' + JSON.stringify({ idx: ${idx}, pid: process.pid, overlaps, entered, staged, other, lockErr, rounds, slow, lags, all }) + '\\n');`;

function racer(dir, idx, t0) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', childScript(dir, idx, t0)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', () => { const line = out.split('\n').find((l) => l.startsWith('@@')); line ? res(JSON.parse(line.slice(2))) : rej(new Error(err || out)); });
  });
}

const fmt = (who, ev) => `  P${who} t=${String(ev[0]).padStart(6)} ${ev[1].padEnd(9)} ${ev[2].padEnd(6)} ${String(ev[3]).padEnd(7)} ${String(ev[4]).padStart(5)}ms${ev[5] !== undefined ? ` age=${ev[5]}` : ''}`;
// 대기 루프처럼 같은 묶음(1~4줄)이 3번 이상 이어지면 한 번만 보이고 반복 횟수로 줄인다
function compress(lines) {
  const out = []; let i = 0;
  while (i < lines.length) {
    let best = null;
    for (let k = 1; k <= 4; k++) {
      let reps = 1;
      while (i + (reps + 1) * k <= lines.length && lines.slice(i + reps * k, i + (reps + 1) * k).every((l, j) => l.key === lines[i + j].key)) reps++;
      if (reps >= 3 && (!best || reps * k > best.reps * best.k)) best = { k, reps };
    }
    if (best) {
      for (let j = 0; j < best.k; j++) out.push(lines[i + j].text);
      out.push(`     ... (위 ${best.k}줄 묶음이 ${best.reps - 1}회 더 반복, 마지막 줄:${lines[i + best.reps * best.k - 1].text.slice(1)})`);
      i += best.reps * best.k;
    } else { out.push(lines[i].text); i++; }
  }
  return out;
}
function summary(ops) {
  const counts = {}; for (const ev of ops) { const k = `${ev[1]}:${ev[2]}:${ev[3]}`; counts[k] = (counts[k] ?? 0) + 1; }
  let maxGap = 0, gapAt = null;
  for (let j = 1; j < ops.length; j++) { const g = ops[j][0] - (ops[j - 1][0] + ops[j - 1][4]); if (g > maxGap) { maxGap = g; gapAt = ops[j - 1][0]; } }
  const maxDur = ops.length ? Math.max(...ops.map((e) => e[4])) : 0;
  const ages = ops.filter((e) => e[1] === 'stat' && e[5] !== undefined).map((e) => e[5]);
  return `ops ${ops.length} ${JSON.stringify(counts)} maxGap ${maxGap}ms@t=${gapAt} maxOpDur ${maxDur}ms statAge ${ages.length ? `${Math.min(...ages)}..${Math.max(...ages)}` : '-'}`;
}
const tally = { runs: 0, lost: 0, overlaps: 0, failures: [] };
for (let r = 0; r < RUNS; r++) {
  const dir = mkdtempSync(join(tmpdir(), 'argo-mutex-diag-'));
  const t0 = Date.now() + 1500; const started = Date.now();
  const res = await Promise.all([racer(dir, 0, t0), racer(dir, 1, t0)]);
  const dur = Date.now() - started;
  const lost = ROUNDS * 2 - res[0].entered - res[1].entered;
  const ov = res[0].overlaps + res[1].overlaps;
  const enterDelays = res.flatMap((x) => x.rounds.map((q) => q[2]).filter((v) => v !== null));
  const maxDelay = Math.max(...enterDelays);
  const slowN = res[0].slow.length + res[1].slow.length;
  const maxLag = Math.max(0, ...res.flatMap((x) => x.lags.map((l) => l[1])));
  tally.runs++; tally.lost += lost; tally.overlaps += ov;
  console.log(`[${LABEL}] run ${r + 1}/${RUNS}: ${dur}ms entered ${res[0].entered}+${res[1].entered}/${ROUNDS * 2} lost ${lost} overlaps ${ov} staged ${res[0].staged} lockErr ${JSON.stringify([res[0].lockErr, res[1].lockErr])} markOther ${JSON.stringify([res[0].other, res[1].other])} maxEnterDelay ${maxDelay}ms slowOps(>=300ms) ${slowN} maxLoopLag ${maxLag}ms`);
  for (const x of res) for (const ev of x.slow) console.log(`   slow: P${x.idx} t=${ev[0]} ${ev[1]} ${ev[2]} ${ev[3]} ${ev[4]}ms`);
  for (const x of res) for (const l of x.lags) console.log(`   lag:  P${x.idx} t=${l[0]} +${l[1]}ms`);
  // 실패(또는 1초 넘게 기다린) 호출마다 두 프로세스의 기록을 시간순으로 합쳐 보인다
  for (const x of res) for (const c of x.all) {
    if (c.asked === undefined) continue;
    const waited = (c.enter ?? c.done) - c.asked;
    if (!c.code && waited < 1000) continue;
    const lo = c.asked - 300, hi = (c.enter ?? c.done) + 50;
    console.log(` >> P${x.idx} round ${c.i}: code=${c.code} asked=${c.asked} enter=${c.enter} done=${c.done} waited=${waited}ms`);
    console.log(`    summary: ${summary(c.ops)}`);
    const evs = [];
    for (const y of res) for (const d of y.all) for (const ev of d.ops) if (ev[0] >= lo && ev[0] <= hi) evs.push([y.idx, ev, d.i, d.stage !== undefined]);
    evs.sort((p, q) => p[1][0] - q[1][0]);
    const lines = evs.map(([who, ev, i, isStage]) => ({ key: `${who}|${ev[1]}|${ev[2]}|${ev[3]}|${i}`, text: fmt(who, ev) + `  [r${i}${isStage ? ' stage' : ''}]` }));
    for (const l of compress(lines)) console.log(l);
    tally.failures.push({ run: r + 1, proc: x.idx, round: c.i, code: c.code, waited });
  }
  if (OUT) writeFileSync(join(OUT, `${LABEL}-run${r + 1}.json`), JSON.stringify({ dur, res }));
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`[${LABEL}] TOTAL runs ${tally.runs} lost ${tally.lost} overlaps ${tally.overlaps} failures ${JSON.stringify(tally.failures)}`);
