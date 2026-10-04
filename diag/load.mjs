// 진단 전용 — 부하 발생기. 종료 신호를 받을 때까지 돈다.
// node load.mjs cpu <n>   : 바쁜 루프 n개
// node load.mjs disk <n>  : 임시 폴더(os.tmpdir)에서 작은 파일 만들기·읽기·지우기 n개(테스트 스위트의 임시 폴더 사용을 흉내)
// node load.mjs suite <repo> : node --test test/*.test.mjs 를 끝나면 다시 돌린다(실제 CI 부하)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [mode, arg] = process.argv.slice(2);
if (mode === 'worker-cpu') { for (;;) { /* busy */ } }
if (mode === 'worker-disk') {
  const buf = Buffer.alloc(1024, 7);
  for (;;) {
    const d = mkdtempSync(join(tmpdir(), 'argo-diag-load-'));
    for (let i = 0; i < 200; i++) writeFileSync(join(d, `f${i}`), buf, i % 10 === 0 ? { flush: true } : undefined);
    for (let i = 0; i < 200; i++) readFileSync(join(d, `f${i}`));
    try { rmSync(d, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 다음 회차 */ }
  }
}
const kids = [];
const stop = () => { for (const k of kids) { try { k.kill(); } catch { /* 이미 끝남 */ } } process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
if (mode === 'cpu' || mode === 'disk') {
  for (let i = 0; i < +arg; i++) kids.push(spawn(process.execPath, [process.argv[1], `worker-${mode}`], { stdio: 'ignore' }));
} else if (mode === 'suite') {
  let n = 0;
  const once = () => {
    n++;
    const k = spawn(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: arg, stdio: ['ignore', 'ignore', 'ignore'] });
    kids.push(k);
    k.on('exit', (code) => { console.log(`[load] suite pass ${n} exit ${code}`); once(); });
  };
  once();
}
setInterval(() => {}, 1 << 30);
