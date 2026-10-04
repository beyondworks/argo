// 진단 전용 — 부하를 켠 채 race-trace.mjs를 돌리고 부하를 끈다.
// node diag-run.mjs <repo> <runs> <label> <load: none|cpu|disk|suite|cpu+disk> <n> [rounds=60] [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const [repoArg, runs, label, load, n, rounds = '60', outDir = ''] = process.argv.slice(2);
const repo = resolve(repoArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loads = [];
const start = (mode, arg) => loads.push(spawn(process.execPath, [join(here, 'load.mjs'), mode, arg], { stdio: 'inherit' }));
if (load === 'cpu' || load === 'disk') start(load, n);
if (load === 'cpu+disk') { start('cpu', n); start('disk', n); }
if (load === 'suite') start('suite', repo);
if (loads.length) await sleep(load === 'suite' ? 30_000 : 3_000);
const args = [join(here, 'race-trace.mjs'), repo, runs, label, rounds]; if (outDir) args.push(outDir);
const code = await new Promise((r) => spawn(process.execPath, args, { stdio: 'inherit' }).on('exit', r));
for (const l of loads) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(l.pid), '/T', '/F'], { stdio: 'ignore' });
  else l.kill('SIGTERM');
}
process.exit(code ?? 1);
