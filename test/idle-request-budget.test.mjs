// 기기당 Supabase 요청 수 절대 예산(2026-11-02 — 로그 수집량이 한도 20GB를 넘을 추정, 요청 1건마다 로그). 부분별 주기 시험(lease-log-cadence·lease-nonholder-interval·tg-claims-solo)은
// 있었지만 합계 예산이 없어 발행 때에야 초과를 알았다. 칸마다 실제 동기화 루프를 가상 시계로 돌려(helpers/idle-budget-child.mjs) 유휴 구간의 기기당 분당 요청을 경로별로 세고 상한과 비교한다.
// 상한을 올려야 한다면 어떤 호출이 왜 늘었는지 PR에 적는다 — 이 값이 곧 로그 비용이다. 칸별 계산 근거는 아래 BUDGET의 why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { childEnv } from './helpers/sync-child.mjs';

const CHILD = fileURLToPath(new URL('./helpers/idle-budget-child.mjs', import.meta.url));
const WARM_MIN = 16; // 첫 동기화·획득·첫 15분 클레임 다시 쓰기를 지난 뒤부터 잰다
const WINDOW_MIN = 60; // 10분(플랜)·5분(색인)·30분(앱 관문) 주기가 정수 번 들어가는 길이

const BUDGET = [
  { name: '1대 혼자·회사 3·토큰 0', tokens: 0, peer: 'none', max: 9, leader: true, mine: 0, need: ['리스 GET', '리스 쓰기', '매니페스트 info'] },
  { name: '1대 혼자·회사 3·토큰 20', tokens: 20, peer: 'none', max: 12, leader: true, mine: 20, need: ['리스 GET', '리스 쓰기', '매니페스트 info', '목록', '클레임 쓰기'] },
  { name: '두 대 계정 담당·회사 3·토큰 20', tokens: 20, peer: 'holder', max: 36, leader: true, mine: 20, need: ['리스 GET', '리스 쓰기', '매니페스트 info', '목록', '클레임 쓰기'] },
  // 2026-11-03 F: 다른 기기를 7시간 전에 본 계정(14일 표지만)의 담당 — 엄격 판정이 아니라 리스 GET이 단일 기기 박자(15초). 클레임은 14일 표지라 혼자 모드가 아니다(종전 규칙).
  { name: '7시간 전에 다른 기기를 본 계정 담당·회사 3·토큰 20', tokens: 20, peer: 'stale', max: 31, leader: true, mine: 20, need: ['리스 GET', '리스 쓰기', '매니페스트 info', '목록', '클레임 쓰기'] },
  { name: '두 대 계정 비담당·회사 3·토큰 20', tokens: 20, peer: 'follower', max: 30, leader: false, mine: 0, need: ['리스 GET', '매니페스트 info', '목록', '클레임 GET'] },
];

async function runCell(c) {
  const root = await mkdtemp(join(tmpdir(), 'argo-budget-'));
  const env = childEnv(root, { BUDGET_CELL: JSON.stringify({ tokens: c.tokens, peer: c.peer, warmMin: WARM_MIN, windowMin: WINDOW_MIN }) });
  delete env.NODE_TEST_CONTEXT;
  try {
    return await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [CHILD], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`자식 시간 초과\n${err.slice(-1500)}`)); }, 170_000);
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('exit', (code) => {
        clearTimeout(t);
        const line = out.split('\n').find((l) => l.startsWith('@@'));
        if (!line) return reject(new Error(`자식이 결과를 내지 않음(종료 코드 ${code})\n${out.slice(-1500)}\n${err.slice(-1500)}`));
        resolve(JSON.parse(line.slice(2)));
      });
    });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}); }
}

const table = (r) => Object.entries(r.perMin).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}/분 (${r.counts[k]}건)`).join('\n');

// 인텔 맥 러너(릴리스 빌드에만 있음)에서는 네 칸 모두 자식이 170초 안에 끝나지 않았다(0.1.124 run 41459100863). 요청 수는 CPU와 무관한 값이고 PR CI의 macos-15·windows가 같은 코드를 재므로 여기서는 건너뛴다.
const skip = process.platform === 'darwin' && process.arch === 'x64' ? '인텔 맥 러너는 너무 느림 — macos-15·windows CI가 잰다' : false;

for (const c of BUDGET) {
  test(`유휴 요청 예산 — ${c.name}: 기기당 분당 ${c.max}건 이하`, { timeout: 180_000, skip }, async () => {
    const r = await runCell(c);
    const detail = `\n실측 합계 ${r.total}/분(상한 ${c.max}), ${r.windowMin}분 창, 경로별:\n${table(r)}\n단계 ${r.phase}, 오류 ${JSON.stringify(r.lastError)}, 멈춤 ${r.stalls}`;
    console.log(`[idle-budget] ${c.name}:${detail}`);
    // 재는 장면이 맞는지 먼저 — 루프가 안 돌아 0건이면 예산을 조용히 통과한다
    assert.equal(r.stalls, 0, `시계를 넘기지 못한 일이 있다${detail}`);
    assert.equal(r.lastError, '', `유휴가 아니라 오류 상태다${detail}`);
    assert.equal(r.leader, c.leader, `담당 여부가 칸과 다르다${detail}`);
    assert.equal(r.mine, c.mine, `수신 토큰 수가 칸과 다르다${detail}`);
    for (const k of c.need) assert.ok(r.counts[k] > 0, `'${k}' 호출이 0건 — 이 장면이 돌지 않았다${detail}`);
    for (const k of ['매니페스트 GET', '매니페스트 쓰기', '파일 GET', '파일 POST', '파일 PUT']) assert.equal(r.counts[k] ?? 0, 0, `유휴인데 ${k}${detail}`);
    assert.ok(r.total <= c.max, `기기당 분당 요청 ${r.total} > 예산 ${c.max} — 어떤 호출이 늘었는지 보고 줄인다(올리려면 근거를 PR에).${detail}`);
  });
}
