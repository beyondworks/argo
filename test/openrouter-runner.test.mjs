// OpenRouter 러너(BYOK 계열 일반화, 설계 2026-07-27) 배선 가드.
// 핵심 불변식: ① SDK 계열(sdk-compat) — CLI 래핑 금지 ② BYOK apikey 단일 ③ 카탈로그 규칙 —
// 정적 모델 목록·기본 모델에는 스모크(scripts/openrouter-smoke.mjs) 통과 id만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-or-'));
const { paths } = await import('../src/workspace.mjs');
const { RUNNERS, RUNNER_AUTH, OPENROUTER_DEFAULT_MODEL, saveRunnerCred, runnerCredEnv, isBilledRunner } = await import('../src/runners.mjs');

test('등록: sdk-compat 계열 + BYOK apikey 단일 (CLI 래핑 금지)', () => {
  assert.equal(RUNNERS.openrouter?.kind, 'sdk-compat', 'CLI 래핑이면 러너 차등이 되살아난다 — BYOK 계열 원칙');
  assert.deepEqual(RUNNER_AUTH.openrouter?.methods, ['apikey'], 'OAuth·크레딧 대행 안 함(설계 YAGNI)');
  assert.ok(RUNNER_AUTH.openrouter?.keyUrl?.includes('openrouter.ai'));
});

test('카탈로그 규칙: 정적 목록·기본 모델은 스모크 통과분만 — 통과 전엔 비어 있어야 한다', () => {
  // 스모크가 통과 모델을 확정하면 이 단언을 그 목록 대조로 바꾼다(빈 목록 단언은 임시 상태의 가드).
  const ids = (RUNNERS.openrouter.models ?? []).map((m) => m.id);
  if (ids.length === 0) {
    assert.equal(OPENROUTER_DEFAULT_MODEL, '', '목록이 비었는데 기본 모델만 있으면 미검증 모델로 턴이 나간다');
  } else {
    assert.ok(ids.includes(OPENROUTER_DEFAULT_MODEL), '기본 모델은 반드시 검증된 목록 안에서');
  }
});

test('runnerCredEnv: GLM·Kimi와 동일한 Anthropic 호환 env 패턴 + 토큰 위생', async () => {
  const ws = 'or-env';
  await mkdir(paths(ws).root, { recursive: true });
  await saveRunnerCred(ws, 'openrouter', 'apikey', 'sk-or-test-123');
  const cred = await runnerCredEnv(ws, 'openrouter');
  assert.equal(cred.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.equal(cred.env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test-123');
  assert.equal(cred.env.ANTHROPIC_API_KEY, '', 'Anthropic 키 잔존 금지');
  assert.equal(cred.env.CLAUDE_CODE_OAUTH_TOKEN, '', '구독 토큰이 제3자 향 턴에 남으면 안 된다(감사 2026-07-20 대칭)');
});

test('billing: openrouter apikey = 청구 러너 (단일 판정 합류)', async () => {
  const ws = 'or-bill';
  await mkdir(paths(ws).root, { recursive: true });
  assert.equal(await isBilledRunner(ws, 'openrouter'), false, '미연결 = 비청구(env 폴백 없음)');
  await saveRunnerCred(ws, 'openrouter', 'apikey', 'sk-or-test-123');
  assert.equal(await isBilledRunner(ws, 'openrouter'), true);
});

test('배선 트립와이어: chat·oneshot이 openrouter 기본 모델 분기를 태운다', async () => {
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const oneshot = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.match(chat, /runner === 'openrouter' \? \{ model: effModel \|\| OPENROUTER_DEFAULT_MODEL \}/);
  assert.match(oneshot, /runner === 'openrouter' \? \{ model: model \|\| OPENROUTER_DEFAULT_MODEL \}/);
  // 외부 CLI 경로(externalExec)에 openrouter 분기가 생기면 BYOK 원칙 위반
  const runners = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  const external = runners.split('export async function externalExec')[1]?.split('\n}')[0] ?? '';
  assert.doesNotMatch(external, /openrouter/, 'openrouter는 SDK 계열 — externalExec(CLI) 분기 금지');
});
