// D4(K49)·K41 가드 — 청구되는데 금액을 모르는 턴(CLI 러너·네이티브 엔진은 costUsd: null)과 턴당 비용 분모.
// 금액을 추정하지 않는다(chat.mjs 결정: 틀린 금액 표시·예산 차감은 신고 계열의 재발). 대신 몇 턴이
// 금액 집계에서 빠졌는지 세어 화면이 "(N턴 금액 미집계)"로 말하게 하고, 턴당 비용은 금액이 잡힌
// 청구 턴으로만 나눈다(구독 턴·미집계 턴이 섞이면 턴당 비용이 낮게 보이던 K41).
// 행은 실제 appendUsage로 쓴다 — chat.mjs의 SDK·CLI 두 기록 지점과 같은 인자 모양.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-uncounted-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-uncounted-'));
const { paths } = await import('../src/workspace.mjs');
const { appendUsage } = await import('../src/usage.mjs');
const billing = await import('../src/billing.mjs');

const tok = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

test('청구·구독·금액 없는 청구 턴이 섞이면 uncounted와 턴당 비용이 정확하다', async () => {
  const ws = 'uncounted-mix';
  await mkdir(paths(ws).root, { recursive: true });
  // SDK 경로(chat.mjs result) — Claude API 키 턴 2개: 금액 있음
  await appendUsage(ws, { kind: 'chat', slug: 'a', runner: 'claude', model: 'claude-sonnet-4-5', usage: tok, costUsd: 0.4, ms: 10, billed: true });
  await appendUsage(ws, { kind: 'chat', slug: 'a', runner: 'claude', model: 'claude-sonnet-4-5', usage: tok, costUsd: 0.2, ms: 10, billed: true });
  // SDK 경로 — 구독(OAuth) 턴: SDK가 정가 상당액을 싣지만 청구 아님
  await appendUsage(ws, { kind: 'chat', slug: 'a', runner: 'claude', model: 'claude-sonnet-4-5', usage: tok, costUsd: 9, ms: 10, billed: false });
  // CLI 경로(chat.mjs CLI 분기) — codex API 키 턴: usage {}·costUsd null·billed true
  await appendUsage(ws, { kind: 'chat', slug: 'b', runner: 'codex', model: 'codex:gpt-5.5', usage: {}, costUsd: null, ms: 10, billed: true });
  // 네이티브 엔진(native-query total_cost_usd: null) — GLM API 키 턴
  await appendUsage(ws, { kind: 'chat', slug: 'b', runner: 'glm', model: 'glm-4.6', usage: tok, costUsd: null, ms: 10, billed: true });

  const sum = await billing.readUsageSummary(ws);
  for (const key of ['today', 'month', 'total']) {
    const s = sum[key];
    assert.equal(s.turns, 5, key);
    assert.equal(s.subTurns, 1, `${key}: 구독 턴 1`);
    assert.equal(s.uncounted, 2, `${key}: 청구인데 금액을 모르는 턴 2(codex CLI·glm 네이티브)`);
    assert.ok(Math.abs(s.costUsd - 0.6) < 1e-9, `${key}: 금액은 추정 없이 보고된 것만`);
    assert.ok(Math.abs(s.costPerTurn - 0.3) < 1e-9, `${key}: 턴당 비용 = 0.6 ÷ 금액 잡힌 청구 턴 2 (전체 5로 나누면 0.12)`);
  }
});

test('금액 있는 청구 턴이 없으면 턴당 비용은 없음, 미집계 수는 그대로', async () => {
  const ws = 'uncounted-cli-only';
  await mkdir(paths(ws).root, { recursive: true });
  await appendUsage(ws, { kind: 'chat', slug: 'b', runner: 'codex', model: 'codex:gpt-5.5', usage: {}, costUsd: null, ms: 10, billed: true });
  await appendUsage(ws, { kind: 'chat', slug: 'b', runner: 'codex', model: 'codex', usage: {}, costUsd: null, ms: 10, billed: false });
  const s = (await billing.readUsageSummary(ws)).month;
  assert.equal(s.hasCost, false);
  assert.equal(s.costPerTurn, null);
  assert.equal(s.uncounted, 1, '구독 턴은 미집계로 세지 않는다 — 돈이 안 나간다');
});
