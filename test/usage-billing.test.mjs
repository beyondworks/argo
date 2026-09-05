// 구독(OAuth) 턴이 청구액으로 표시되던 회귀 가드 — 실사용 신고 2026-07-26:
// "어스(OAuth) 방식으로 연결했는데 비용이 나가는 것처럼 보이니까, 진짜 내 구독료 안에서 쓰는 건지
//  추가로 청구가 되는 건지 헷갈리네요."
// SDK는 구독 턴에도 total_cost_usd에 정가 상당액을 리포트한다 — 그걸 그대로 더하면 청구서로 읽힌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 실 홈 미접촉 — sdkEnvFor가 호환 러너 경로에서 ~/.argo/claude-config-*를 만든다(검수 LOW-1 스위프)
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-billinghome-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-billing-'));
const { paths } = await import('../src/workspace.mjs');
const { readUsageSummary, monthCost } = await import('../src/usage.mjs');
const { saveRunnerCred, isBilledRunner } = await import('../src/runners.mjs');

const now = new Date().toISOString();
async function seed(ws, rows) {
  const p = paths(ws);
  await mkdir(p.root, { recursive: true });
  await writeFile(p.usage, rows.map((r) => JSON.stringify({ ts: now, kind: 'chat', slug: 'a', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, ms: 10, ...r })).join('\n') + '\n');
}

test('구독 턴의 금액은 이번 달 사용액에 더해지지 않는다', async () => {
  const ws = 'bill-sub';
  await seed(ws, [{ costUsd: 2.5, billed: false }, { costUsd: 1.25, billed: false }]);
  const sum = await readUsageSummary(ws);
  assert.equal(sum.month.costUsd, 0, '구독 턴 금액이 더해졌다 — 사용자가 청구서로 오해한다');
  assert.equal(sum.month.hasCost, false, 'hasCost가 참이면 상단바가 금액을 띄운다');
  assert.equal(sum.month.subTurns, 2, '구독 턴 수는 세어야 사용량을 보여줄 수 있다');
  assert.equal((await monthCost(ws)).costUsd, 0, '예산 게이트도 구독 턴을 청구로 세면 안 된다');
});

test('API 키 턴은 그대로 청구액으로 잡힌다 (회귀 아님)', async () => {
  const ws = 'bill-api';
  await seed(ws, [{ costUsd: 2 }, { costUsd: 3 }]);
  const sum = await readUsageSummary(ws);
  assert.equal(sum.month.costUsd, 5);
  assert.equal(sum.month.hasCost, true);
  assert.equal(sum.month.subTurns, 0);
  assert.equal((await monthCost(ws)).costUsd, 5);
});

test('섞여 있으면 청구 턴만 금액에, 구독 턴은 개수로', async () => {
  const ws = 'bill-mix';
  await seed(ws, [{ costUsd: 4 }, { costUsd: 9.9, billed: false }]);
  const sum = await readUsageSummary(ws);
  assert.equal(sum.month.costUsd, 4, '구독 턴 금액이 섞이면 안 된다');
  assert.equal(sum.month.subTurns, 1);
});

test('맵 없는 직접 호출(레거시 폴백)만 표지 없는 행을 청구로 본다 — 프로덕션은 billing 게이트 경유', async () => {
  // ⚠ 이 동작은 usage.mjs 단독 호출의 하위호환 폴백일 뿐이다. 프로덕션 소비자는 전부
  // billing.mjs(현재 자격 기준 판정)를 타며 트립와이어가 강제한다 — test/billing-gate.test.mjs.
  const ws = 'bill-legacy';
  await seed(ws, [{ costUsd: 7 }]);
  assert.equal((await readUsageSummary(ws)).month.costUsd, 7);
});

test('isBilledRunner: apikey(회사 자격·env 폴백)만 청구, oauth·host·미연결은 구독', async () => {
  const ws = 'bill-cred';
  await mkdir(paths(ws).root, { recursive: true });
  // env 폴백 판정이 이 기기 환경에 오염되지 않게 고정 + 종료 시 복원(2R 지적 — 개발자 env 보존)
  const saved = {};
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GLM_API_KEY', 'KIMI_API_KEY']) { saved[k] = process.env[k]; delete process.env[k]; }
  assert.equal(await isBilledRunner(ws, 'claude'), false, '자격 없음 + env 키 없음 = 구독(키체인 로그인)');
  await saveRunnerCred(ws, 'claude', 'oauth', 'sk-ant-oat01-xxx');
  assert.equal(await isBilledRunner(ws, 'claude'), false, 'OAuth = 구독 — 돈이 나가지 않는다');
  await saveRunnerCred(ws, 'claude', 'apikey', 'sk-ant-api-xxx');
  assert.equal(await isBilledRunner(ws, 'claude'), true, 'API 키만 실제 청구다');
  await saveRunnerCred(ws, 'codex', 'host', 'x');
  assert.equal(await isBilledRunner(ws, 'codex'), false, '이 컴퓨터 로그인도 구독이다');
  // HIGH-1: 회사 자격이 없어도 호스트 env 키 폴백은 실제 과금 경로다 — 숨기면 예산 게이트가 꺼진다
  process.env.GLM_API_KEY = 'test-glm-key';
  assert.equal(await isBilledRunner(ws, 'glm'), true, 'GLM env 폴백 = 실제 과금');
  delete process.env.GLM_API_KEY;
  assert.equal(await isBilledRunner(ws, 'glm'), false);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-host';
  const wsC = 'bill-cred-c'; await mkdir(paths(wsC).root, { recursive: true });
  assert.equal(await isBilledRunner(wsC, 'claude'), true, 'claude env API 키 폴백 = 과금');
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-host';
  // 판정 근거: sdkEnvFor가 구독 토큰 존재 시 API 키를 소거해 **실행 자체가 구독으로 확정**된다(2R 결정론화)
  assert.equal(await isBilledRunner(wsC, 'claude'), false, '실행이 구독으로 확정되므로 판정도 구독');
  const { sdkEnvFor } = await import('../src/runners.mjs');
  const env = await sdkEnvFor(wsC, 'claude');
  assert.equal(env.ANTHROPIC_API_KEY, '', '두 env 공존 시 API 키 소거 — 판정·실행 정합을 코드로 보장');
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
