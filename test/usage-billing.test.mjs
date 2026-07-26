// 구독(OAuth) 턴이 청구액으로 표시되던 회귀 가드 — 실사용 신고 2026-07-26:
// "어스(OAuth) 방식으로 연결했는데 비용이 나가는 것처럼 보이니까, 진짜 내 구독료 안에서 쓰는 건지
//  추가로 청구가 되는 건지 헷갈리네요."
// SDK는 구독 턴에도 total_cost_usd에 정가 상당액을 리포트한다 — 그걸 그대로 더하면 청구서로 읽힌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('billed 필드가 없는 옛 행은 청구로 본다 — 과거 집계를 소급 변경하지 않는다', async () => {
  const ws = 'bill-legacy';
  await seed(ws, [{ costUsd: 7 }]);
  assert.equal((await readUsageSummary(ws)).month.costUsd, 7);
});

test('isBilledRunner: apikey만 청구, oauth·host·미연결은 구독', async () => {
  const ws = 'bill-cred';
  await mkdir(paths(ws).root, { recursive: true });
  assert.equal(await isBilledRunner(ws, 'claude'), false, '자격 없음(호스트 폴백)은 구독이다');
  await saveRunnerCred(ws, 'claude', 'oauth', 'sk-ant-oat01-xxx');
  assert.equal(await isBilledRunner(ws, 'claude'), false, 'OAuth = 구독 — 돈이 나가지 않는다');
  await saveRunnerCred(ws, 'claude', 'apikey', 'sk-ant-api-xxx');
  assert.equal(await isBilledRunner(ws, 'claude'), true, 'API 키만 실제 청구다');
  await saveRunnerCred(ws, 'codex', 'host', 'x');
  assert.equal(await isBilledRunner(ws, 'codex'), false, '이 컴퓨터 로그인도 구독이다');
});
