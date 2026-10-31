// 혼자 모드 긴 클레임의 두 기기 시나리오(PR #1197 엄격 검수 I-1·I-2) — 시나리오마다 새 프로세스(test/helpers/tg-twodev.mjs, 가짜 저장소·가짜 시계)로 돌려
// 겹침(두 기기가 같은 봇을 함께 폴링한 초)과 공백(아무 기기도 폴링하지 않은 초)의 상한을 잠근다. 고치기 전(1e40e952): stall·netA 775초, preempt 44초,
// sleep 깬 직후 mine, move 공백 900초, 첫 리스 읽기 실패 시 B가 A의 토큰을 가져감. main(종전 규칙): 겹침 0, move 공백 120초.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = (name) => new URL(`./helpers/${name}`, import.meta.url).pathname;
function run(file, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [helper(file)], { env: { ...process.env, ARGO_SYNC_CYCLE_MS: '', NODE_TEST_CONTEXT: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${out.slice(-1500)}`)); }, 120_000);
    p.on('exit', () => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no result\n${out.slice(-1500)}`));
      resolve(JSON.parse(line.slice(2)));
    });
  });
}
const tmp = await mkdtemp(join(tmpdir(), 'argo-tg-twodev-'));
const scen = (s, env = {}) => run('tg-twodev.mjs', { SCEN: s, TMPDIR: tmp, ...env });

test('stall — A의 리스 타이머가 멈추면(B가 리스·클레임을 인수) 겹침 0초', async () => {
  const r = await scen('stall');
  assert.equal(r.overlapStateSec, 0, r.events.join('\n'));
});

test('netA — A만 Supabase가 실패(텔레그램은 됨)해도 겹침 0초', async () => {
  const r = await scen('netA');
  assert.equal(r.overlapStateSec, 0, r.events.join('\n'));
});

test('preempt — 우선 역할 기기가 A의 살아 있는 리스를 가져가면 겹침은 A의 다음 리스 읽기(혼자 보유자 15초)까지만', async () => {
  const r = await scen('preempt');
  console.log(`[tg-twodev] preempt 겹침 ${r.overlapStateSec}초`);
  assert.ok(r.overlapStateSec <= 15, `${r.overlapStateSec}초\n${r.events.join('\n')}`);
});

test('sleep — A가 잠든 사이 B가 인수하면, 깬 직후 첫 판정 전 A는 mine이 아니다(판정 중)', async () => {
  const r = await scen('sleep');
  assert.equal(r.atWake?.mine, false, JSON.stringify(r.atWake));
  assert.equal(r.overlapStateSec, 0, r.events.join('\n'));
});

test('move — 토큰을 다른 기기로 옮길 때 해제 청소가 한 번 실패해도 다시 해서, 공백이 종전(main 120초) 수준', async () => {
  const r = await scen('move');
  console.log(`[tg-twodev] move 공백 ${r.gapSec}초`);
  assert.ok(r.gapSec != null && r.gapSec <= 150, `${r.gapSec}초\n${r.events.join('\n')}`);
  const r0 = await scen('move', { FAILS: '0' });
  console.log(`[tg-twodev] move(청소 실패 없음) 공백 ${r0.gapSec}초`);
  assert.ok(r0.gapSec != null && r0.gapSec <= 90, `${r0.gapSec}초`);
});

test('첫 리스 읽기 실패 — 새 판 B는 살아 있는 혼자 모드 보유자 A의 긴 글을 가져가지 않는다(리스를 모르면 긴 글 존중)', async () => {
  const r = await run('tg-bfirst.mjs', { TMPDIR: tmp });
  assert.equal(r.claimNowBy, 'A'); assert.equal(r.bOwnership.mine, false);
  const c = await run('tg-bfirst.mjs', { TMPDIR: tmp, A_DOC: 'classic' });
  assert.equal(c.claimNowBy, 'A', '종전 글(70초 전)도 그대로 존중');
});
