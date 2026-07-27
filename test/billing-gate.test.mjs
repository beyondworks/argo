// 금액 표면 단일 판정 가드 — 실사용 신고 재발(2026-07-27): v0.1.29가 구독 턴에 billed:false를
// 심었지만 "표지 없는 옛 행 = 청구"로 남겨, 구독 전용 회사 상단에 잔존 금액이 계속 표시됐다.
// 새 판정: 행이 청구다 ⇔ (billed !== false) && (그 행 러너의 **현재 자격이 apikey**).
// 이 파일이 잠그는 것: ① 판정 자체 ② 구독 전용 회사의 잔존 행 억제 ③ 혼합 회사 러너별 정확성
// ④ 배선(프로덕션 소비자는 billing.mjs를 통해서만 — 직접 import 트립와이어).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-billing-gate-'));
const { paths } = await import('../src/workspace.mjs');
const { rowBilled, rowRunner } = await import('../src/usage.mjs');
const { saveRunnerCred } = await import('../src/runners.mjs');
const billing = await import('../src/billing.mjs');

const now = new Date().toISOString();
async function seed(ws, rows) {
  const p = paths(ws);
  await mkdir(p.root, { recursive: true });
  await writeFile(p.usage, rows.map((r) => JSON.stringify({
    ts: now, kind: 'chat', slug: 'a', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, ms: 10, ...r,
  })).join('\n') + '\n');
}

test('rowBilled: 판정 = (billed!==false) && (현재 자격 apikey)', () => {
  const map = { claude: true, codex: false };
  assert.equal(rowBilled({ runner: 'claude', costUsd: 1 }, map), true);          // 표지 없는 행 + apikey → 청구
  assert.equal(rowBilled({ runner: 'codex', costUsd: 1 }, map), false);          // 표지 없는 행 + 구독 → 비청구
  assert.equal(rowBilled({ runner: 'claude', billed: false }, map), false);      // 명시 구독 표지는 자격 무관 비청구
  assert.equal(rowBilled({ runner: 'gemini', costUsd: 1 }, map), false);         // 미연결(맵에 없음) → 비청구
  assert.equal(rowBilled({ costUsd: 1 }, map), true);                            // 러너 미기록 구행 → claude로 도출
  assert.equal(rowRunner({ model: 'codex:gpt-5.5' }), 'codex');                  // 구행 모델명 폴백 유지
});

test('구독 전용 회사: 표지 없는 잔존 행이 있어도 금액이 전면 억제된다 (신고 재발 방지)', async () => {
  const ws = 'sub-only';
  // v0.1.29 이전에 쌓인 형태 — billed 표지 없음 + costUsd 정가 상당액
  await seed(ws, [
    { costUsd: 1.25 }, { costUsd: 0.75, model: 'claude-sonnet-5' }, { billed: false, costUsd: 2.0 },
  ]);
  await saveRunnerCred(ws, 'claude', 'oauth', 'sk-ant-oat-test');
  const sum = await billing.readUsageSummary(ws);
  assert.equal(sum.month.hasCost, false, '상단·데크 어디에도 금액이 나가면 안 된다');
  assert.equal(sum.month.costUsd, 0);
  assert.equal(sum.month.subTurns, 3, '전부 구독 턴으로 센다');
  const mc = await billing.monthCost(ws);
  assert.equal(mc.costUsd, 0, '예산 게이트도 같은 판정 — 구독 턴이 예산을 갉으면 안 된다');
  assert.equal(mc.subTurns, 3);
  const payroll = await billing.monthCostByCrew(ws);
  assert.ok(payroll.every((p) => !p.hasCost), '급여 대장에도 금액 없음');
});

test('혼합 회사: 러너별로 정확 — codex(키)만 청구, claude(구독) 잔존 행은 비청구', async () => {
  const ws = 'mixed';
  await seed(ws, [
    { costUsd: 1.0 },                                  // 구행(claude 도출) — claude는 구독 → 비청구
    { runner: 'codex', model: 'codex:gpt-5.5', costUsd: 0.5 }, // codex는 apikey → 청구
  ]);
  await saveRunnerCred(ws, 'claude', 'oauth', 'sk-ant-oat-test');
  await saveRunnerCred(ws, 'codex', 'apikey', 'sk-test-openai');
  const sum = await billing.readUsageSummary(ws);
  assert.equal(sum.month.hasCost, true);
  assert.equal(sum.month.costUsd, 0.5, 'codex 몫만');
  assert.equal(sum.month.subTurns, 1);
});

test('HIGH-3: billed:true 각인 행은 달 중간 구독 전환에도 금액이 불변 — 실지출 증발·예산 리셋 차단', async () => {
  const ws = 'switch-mid';
  // v0.1.30+ 형태: 청구 턴에 billed:true 각인. 이후 oauth로 전환해도 이미 나간 돈은 사실이다.
  await seed(ws, [{ costUsd: 49, billed: true }, { costUsd: 3 } /* 레거시 무표지 */]);
  await saveRunnerCred(ws, 'claude', 'oauth', 'sk-ant-oat-test'); // 달 중간 구독 전환
  const mc = await billing.monthCost(ws);
  assert.equal(mc.costUsd, 49, '각인된 실지출 $49는 전환 후에도 표시·예산에 남아야 한다');
  assert.equal(mc.subTurns, 1, '레거시 무표지 행만 현재 자격(구독) 판정을 받는다');
});

test('appendUsage: 청구 턴에 billed:true를 각인한다 (HIGH-3의 전제)', async () => {
  const ws = 'stamp';
  await mkdir(paths(ws).root, { recursive: true });
  const { appendUsage } = await import('../src/usage.mjs');
  await appendUsage(ws, { kind: 'chat', slug: 'a', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.1, billed: true });
  await appendUsage(ws, { kind: 'chat', slug: 'a', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.1, billed: false });
  const lines = (await readFile(paths(ws).usage, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].billed, true);
  assert.equal(lines[1].billed, false);
});

test('API키 전용 회사: 기존 동작 유지 — 금액 그대로 표시', async () => {
  const ws = 'key-only';
  await seed(ws, [{ costUsd: 1.25 }, { costUsd: 0.75 }]);
  await saveRunnerCred(ws, 'claude', 'apikey', 'sk-ant-test');
  const sum = await billing.readUsageSummary(ws);
  assert.equal(sum.month.hasCost, true);
  assert.equal(sum.month.costUsd, 2.0);
  assert.equal(sum.month.subTurns, 0);
});

test('2R HIGH-1: 자격 파일 손상 시 화면을 죽이지 않고 금액만 억제한다 (throw가 새면 회사 전체가 404)', async () => {
  const ws = 'corrupt-secrets';
  await seed(ws, [{ costUsd: 5 }]);
  // env 격리(3R MEDIUM-A) — 손상 → 자가치유(빈 자격) 후엔 env 폴백이 판정을 좌우하므로
  // 개발자 셸의 실키가 이 테스트를 red로 만든다. save/restore.
  const saved = {};
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GLM_API_KEY', 'KIMI_API_KEY']) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const { writeFile: wf } = await import('node:fs/promises');
    const corrupt = () => wf(join(paths(ws).root, '.secrets.json'), '{손상된 JSON'); // readJson이 .corrupt 백업 후 throw하는 형태
    await corrupt();
    const sum = await billing.readUsageSummary(ws); // throw하면 이 테스트가 red — 라우트 404 회귀 재현
    assert.equal(sum.month.hasCost, false, '손상 시 금액은 억제(과대 표시보다 안전)');
    await corrupt(); // 첫 호출이 손상을 소비(.corrupt 백업·자가치유)하므로 게이트 단언 전 재손상(3R MEDIUM-A)
    assert.equal((await billing.monthCost(ws)).costUsd, 0, '예산 게이트도 같은 강등');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ── 배선 트립와이어 — 부품이 아니라 "누가 집계를 부르는가"를 잠근다.
test('배선: 프로덕션 소비자는 usage.mjs 금액 집계를 직접 import하지 않는다 (우회 4종 포함)', async () => {
  const MONEY = ['readUsageSummary', 'agentStats', 'monthCostByCrew', 'monthCost', 'monthCostByRunner'];
  const offenders = [];
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.next|test/.test(e.name)) await scan(p); continue; }
      if (!/\.(mjs|js|jsx)$/.test(e.name)) continue;
      const rel = p.slice(process.cwd().length + 1).replace(/\\/g, '/'); // win 구분자 정규화 — 아래 판정은 '/' 기준
      if (/src\/(usage|billing)\.mjs$/.test(rel)) continue;
      const isRunners = /src\/runners\.mjs$/.test(rel); // 순환 예외 — 아래 별도 테스트가 map 전달을 잠근다
      const src = await readFile(p, 'utf8');
      for (const m of src.matchAll(/import\s*{([^}]+)}\s*from\s*['"][^'"]*\/usage\.mjs['"]/g)) {
        const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
        const bad = names.filter((n) => MONEY.includes(n) && !(isRunners && n === 'monthCostByRunner'));
        if (bad.length) offenders.push(`${rel}: ${bad.join(',')}`);
      }
      // 우회 차단(검수 2R HIGH-2 변이 실측): 네임스페이스·re-export·export * ·동적 import
      if (!isRunners) {
        if (/import\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*\/usage\.mjs['"]/.test(src)) offenders.push(`${rel}: namespace import(usage.mjs)`);
        if (/export\s*(?:{[^}]*}|\*)\s*from\s*['"][^'"]*\/usage\.mjs['"]/.test(src)) offenders.push(`${rel}: re-export(usage.mjs)`);
        if (/import\(['"][^'"]*\/usage\.mjs['"]\)/.test(src)) offenders.push(`${rel}: dynamic import(usage.mjs)`);
      }
    }
  }
  await scan(join(process.cwd(), 'src'));
  await scan(join(process.cwd(), 'app'));
  assert.deepEqual(offenders, [], `금액 집계는 billing.mjs로만: ${offenders.join(' / ')}`);
});

test('배선: runners.mjs(순환 예외)는 공용 billedRunnerMap으로 monthCostByRunner를 부른다', async () => {
  const src = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  assert.match(src, /monthCostByRunner\(wsId,\s*await billedRunnerMap\(wsId\)\)/, '맵 없이 부르면 구독 러너 행이 금액으로 샌다');
  assert.match(src, /export async function billedRunnerMap/, '맵 구현은 한 곳(중복 금지 — 검수 LOW-9)');
});
