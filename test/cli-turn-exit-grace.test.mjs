// K12(D2) — CLI 루트가 끝났는데 백그라운드 손자가 stdout/stderr를 물고 있으면, 결과는 execFile의 close 콜백에서만
// 나오므로 상한(30분)까지 기다렸다가 성공 결과를 버리고 "시간 초과"가 됐다. 루트 exit 뒤 유예(3초) 안에 close가
// 없으면 소유 트리를 최선 종료하고 stdio를 끊어 루트가 이미 낸 출력으로 해결해야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execTurnFile } from '../src/runners/process-tree.mjs';

const posix = { skip: process.platform === 'win32' };
const reap = (stdout) => { // 손자가 남았으면 테스트 호스트에 두지 않는다
  const pid = Number(String(stdout).match(/BG=(\d+)/)?.[1]);
  if (pid > 0) try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 종료 */ }
};

test('루트는 성공 종료, 손자가 stdio를 잡고 있음 — 유예 뒤 루트 출력으로 해결(상한까지 기다리지 않음)', posix, async () => {
  const t0 = Date.now();
  let out = '';
  try {
    const r = await execTurnFile('sh', ['-c', 'echo ROOT-OUT; sleep 30 & echo "BG=$!"; exit 0'], { timeout: 12_000 });
    out = r.stdout;
    assert.match(r.stdout, /^ROOT-OUT\n/);
    assert.ok(Date.now() - t0 < 8_000, `유예 안에 해결(${Date.now() - t0}ms)`);
  } catch (e) { out = e.stdout ?? ''; throw e; } finally { reap(out); }
});

test('루트가 실패 코드로 끝나고 손자가 stdio를 잡고 있음 — 유예 뒤 루트의 종료 코드와 출력이 그대로 실패로 나온다', posix, async () => {
  let out = '';
  await assert.rejects(
    execTurnFile('sh', ['-c', 'echo ROOT-FAIL; sleep 30 & echo "BG=$!"; exit 3'], { timeout: 12_000 }),
    (e) => { out = e.stdout; return e.code === 3 && /ROOT-FAIL/.test(e.stdout) && !e.timedOut; },
  ).finally(() => reap(out));
});

test('인접 핀 — 손자 없는 정상 종료는 유예 없이 바로 해결', async () => {
  const t0 = Date.now();
  const r = await execTurnFile(process.execPath, ['-e', 'process.stdout.write("fast")'], { timeout: 12_000 });
  assert.equal(r.stdout, 'fast');
  assert.ok(Date.now() - t0 < 2_500, `유예 대기 없음(${Date.now() - t0}ms)`);
});

test('인접 핀 — 유예 중 사용자 중단은 중단으로 끝난다(먼저 온 쪽이 이긴다)', posix, async () => {
  const ac = new AbortController();
  let out = '';
  const run = execTurnFile('sh', ['-c', 'echo X; sleep 30 & echo "BG=$!"; exit 0'], { signal: ac.signal, timeout: 12_000 });
  run.child.stdout.on('data', (d) => { out += d; });
  setTimeout(() => ac.abort(), 700);
  await assert.rejects(run, (e) => e.aborted === true).finally(() => reap(out));
});
