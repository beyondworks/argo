// 진단 전용 — 테스트 파일 하나를 n번 돌리고 회차마다 성패·걸린 시간·실패 메시지를 남긴다.
// node loop-test.mjs <testFile> <runs> <label>
import { spawnSync } from 'node:child_process';

const [file, runs, label] = process.argv.slice(2);
let fails = 0;
for (let i = 1; i <= +runs; i++) {
  const t = Date.now();
  const r = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', maxBuffer: 64e6 });
  const out = `${r.stdout}\n${r.stderr}`;
  const ok = r.status === 0;
  if (!ok) fails++;
  const first = (out.match(/duration_ms: ([\d.]+)/) || [])[1];
  console.log(`[${label}] iter ${i}/${runs}: ${ok ? 'ok' : 'FAIL'} exit ${r.status} ${Date.now() - t}ms firstTest ${first}ms`);
  if (!ok) for (const l of out.split('\n').filter((x) => /not ok|error:|!==|겹침|잠금 실패|모든 회차|timed out|깐 회차/.test(x))) console.log(`   ${l.trim()}`);
}
console.log(`[${label}] TOTAL runs ${runs} fails ${fails}`);
