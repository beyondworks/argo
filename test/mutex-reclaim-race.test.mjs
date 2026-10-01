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

function racer(dir, idx, t0) {
  const script = `
const { withDirLock } = await import(${JSON.stringify(MUTEX)});
const { mkdir, utimes, writeFile, rm } = await import('node:fs/promises');
const { join } = await import('node:path');
const lock = join(${JSON.stringify(dir)}, 'x.lock');
const mark = join(${JSON.stringify(dir)}, 'inside');
const wait = (at) => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
let overlaps = 0, entered = 0;
for (let i = 0; i < ${ROUNDS}; i++) {
  const at = ${t0} + i * ${PERIOD};
  if (${idx} === 0) { // 회차 시작 전에 크래시가 남긴 오래된 잠금을 깐다
    await wait(at - 120);
    await mkdir(lock).catch(() => {});
    const old = new Date(Date.now() - 60_000); await utimes(lock, old, old).catch(() => {});
  }
  await wait(at);
  await withDirLock(lock, async () => {
    entered++;
    try { await writeFile(mark, String(process.pid), { flag: 'wx' }); } catch { overlaps++; return; }
    await new Promise((r) => setTimeout(r, 15));
    await rm(mark, { force: true });
  }, { staleMs: 5_000, retryMs: 5, timeoutMs: 3_000 }).catch(() => {});
}
process.stdout.write('@@' + JSON.stringify({ overlaps, entered }) + '\\n');`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      return line ? resolve(JSON.parse(line.slice(2))) : reject(new Error(err || out));
    });
  });
}

test('오래된 잠금을 두 프로세스가 동시에 회수해도 잠금 안에 둘이 같이 들어가지 않는다(60회차 겹침 0)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-mutex-race-'));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now() + 1500;
  const [a, b] = await Promise.all([racer(dir, 0, t0), racer(dir, 1, t0)]);
  assert.equal(a.overlaps + b.overlaps, 0, `겹침 ${a.overlaps + b.overlaps}회`);
  assert.equal(a.entered + b.entered, ROUNDS * 2, '모든 회차에 둘 다 결국 잠금을 얻는다(회수가 막히지 않는다)');
});
