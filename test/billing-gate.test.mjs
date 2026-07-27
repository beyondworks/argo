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

test('API키 전용 회사: 기존 동작 유지 — 금액 그대로 표시', async () => {
  const ws = 'key-only';
  await seed(ws, [{ costUsd: 1.25 }, { costUsd: 0.75 }]);
  await saveRunnerCred(ws, 'claude', 'apikey', 'sk-ant-test');
  const sum = await billing.readUsageSummary(ws);
  assert.equal(sum.month.hasCost, true);
  assert.equal(sum.month.costUsd, 2.0);
  assert.equal(sum.month.subTurns, 0);
});

// ── 배선 트립와이어 — 부품이 아니라 "누가 집계를 부르는가"를 잠근다.
test('배선: 프로덕션 소비자는 usage.mjs 금액 집계를 직접 import하지 않는다', async () => {
  const MONEY = ['readUsageSummary', 'agentStats', 'monthCostByCrew', 'monthCost'];
  const offenders = [];
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.next|test/.test(e.name)) await scan(p); continue; }
      if (!/\.(mjs|js|jsx)$/.test(e.name)) continue;
      const rel = p.slice(process.cwd().length + 1);
      if (/src\/(usage|billing)\.mjs$/.test(rel)) continue;
      const src = await readFile(p, 'utf8');
      for (const m of src.matchAll(/import\s*{([^}]+)}\s*from\s*['"][^'"]*\/usage\.mjs['"]/g)) {
        const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
        const bad = names.filter((n) => MONEY.includes(n));
        if (bad.length) offenders.push(`${rel}: ${bad.join(',')}`);
      }
      for (const m of src.matchAll(/import\(['"][^'"]*\/usage\.mjs['"]\)/g)) {
        // 동적 import는 구조분해 이름을 못 좇는다 — usage.mjs 동적 import 자체를 금지(금액 함수 포함 모듈)
        if (!/src\/runners\.mjs$/.test(rel)) offenders.push(`${rel}: dynamic import(usage.mjs)`);
      }
    }
  }
  await scan(join(process.cwd(), 'src'));
  await scan(join(process.cwd(), 'app'));
  assert.deepEqual(offenders, [], `금액 집계는 billing.mjs로만: ${offenders.join(' / ')}`);
});

test('배선: runners.mjs(순환 예외)는 monthCostByRunner에 billedMap을 넘긴다', async () => {
  const src = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  assert.match(src, /monthCostByRunner\(wsId,\s*billedMap\)/, '맵 없이 부르면 구독 러너 행이 금액으로 샌다');
});
