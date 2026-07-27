// OpenRouter 러너(BYOK 계열 일반화, 설계 2026-07-27) 배선 가드.
// 핵심 불변식: ① SDK 계열(sdk-compat) — CLI 래핑 금지 ② BYOK apikey 단일 ③ 카탈로그 규칙 —
// 정적 모델 목록·기본 모델에는 스모크(scripts/openrouter-smoke.mjs) **전수 통과** id만
// ④ 402(선불 크레딧 소진)는 성공으로 삼키지 않는다 ⑤ 금액은 미기록(SDK 단가 오액 — 설계 §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-or-'));
const { paths } = await import('../src/workspace.mjs');
const { RUNNERS, RUNNER_AUTH, OPENROUTER_DEFAULT_MODEL, isOpenRouterCreditError, saveRunnerCred, runnerCredEnv, isBilledRunner } = await import('../src/runners.mjs');

test('등록: sdk-compat 계열 + BYOK apikey 단일 (CLI 래핑 금지)', () => {
  assert.equal(RUNNERS.openrouter?.kind, 'sdk-compat', 'CLI 래핑이면 러너 차등이 되살아난다 — BYOK 계열 원칙');
  assert.deepEqual(RUNNER_AUTH.openrouter?.methods, ['apikey'], 'OAuth·크레딧 대행 안 함(설계 YAGNI)');
  assert.ok(RUNNER_AUTH.openrouter?.keyUrl?.includes('openrouter.ai'));
});

test('카탈로그: 스모크 전수 통과 8종 + 기본 모델 포함 + 첫 항목=기본(러너 전환 관례)', () => {
  const ids = (RUNNERS.openrouter.models ?? []).map((m) => m.id);
  assert.equal(ids.length, 8, '2026-07-27 스모크 8/8 확정본 — 변경은 스모크 재실행 후에만');
  assert.ok(ids.includes(OPENROUTER_DEFAULT_MODEL), '기본 모델은 반드시 검증된 목록 안에서');
  assert.equal(ids[0], OPENROUTER_DEFAULT_MODEL, '첫 항목이 러너 전환 시 기본 선택된다(gemini 관례)');
});

test('runnerCredEnv: GLM·Kimi와 동일한 Anthropic 호환 env 패턴 + 토큰 위생 + 상한 미선언', async () => {
  // env 격리 — 개발자 셸의 OPENROUTER_* 오버라이드가 단언을 흔들지 않게(검수 LOW)
  const saved = {};
  for (const k of ['OPENROUTER_BASE_URL', 'OPENROUTER_MAX_OUTPUT_TOKENS']) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const ws = 'or-env';
    await mkdir(paths(ws).root, { recursive: true });
    await saveRunnerCred(ws, 'openrouter', 'apikey', 'sk-or-test-123');
    const cred = await runnerCredEnv(ws, 'openrouter');
    assert.equal(cred.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
    assert.equal(cred.env.ANTHROPIC_AUTH_TOKEN, 'sk-or-test-123');
    assert.equal(cred.env.ANTHROPIC_API_KEY, '', 'Anthropic 키 잔존 금지');
    assert.equal(cred.env.CLAUDE_CODE_OAUTH_TOKEN, '', '구독 토큰이 제3자 향 턴에 남으면 안 된다(감사 2026-07-20 대칭)');
    // 출력 상한은 기본 미선언(검수 MEDIUM-2: 러너 차등 + 긴 답변 절단) — env 옵트인 시에만
    assert.equal(cred.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
    process.env.OPENROUTER_MAX_OUTPUT_TOKENS = '4096';
    assert.equal((await runnerCredEnv(ws, 'openrouter')).env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096', '운영자 env 옵트인은 반영');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('billing: openrouter apikey = 청구 러너 (단일 판정 합류)', async () => {
  const ws = 'or-bill';
  await mkdir(paths(ws).root, { recursive: true });
  assert.equal(await isBilledRunner(ws, 'openrouter'), false, '미연결 = 비청구(env 폴백 없음)');
  await saveRunnerCred(ws, 'openrouter', 'apikey', 'sk-or-test-123');
  assert.equal(await isBilledRunner(ws, 'openrouter'), true);
});

test('isOpenRouterCreditError: 실측 402 문구만 — 인용·설명 답변 오탐 금지', () => {
  assert.equal(isOpenRouterCreditError('API Error: 402 This request requires more credits, or fewer max_tokens.'), true);
  assert.equal(isOpenRouterCreditError('  API Error: 402 …'), true);
  assert.equal(isOpenRouterCreditError('OpenRouter에서 "API Error: 402"가 나오면 크레딧을 충전하세요.'), false, '인용 답변은 오탐 금지(앞머리 고정)');
  assert.equal(isOpenRouterCreditError(''), false);
});

test('배선: chat.mjs — 402 안내는 success/else 쌍 밖 + costUsd 미기록 (제어흐름 트립와이어)', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  // CRITICAL 재발 방지(검수 실증): 402 블록이 success-if와 else 사이에 끼면 else가 402-if에 붙어
  // **전 러너 성공 턴이 throw**된다. success-if와 else의 인접(붙어 있음)을 문자 그대로 잠근다.
  assert.match(src, /if \(msg\.subtype === 'success'\) reply = msg\.result;\n      else \{/, 'success/else 쌍은 인접 불변 — 사이에 코드 삽입 금지');
  assert.match(src, /runner === 'openrouter' && isOpenRouterCreditError\(reply\)/, '402 안내 배선');
  assert.match(src, /costUsd: runner === 'openrouter' \? null : msg\.total_cost_usd/, '설계 §4 — SDK 금액은 Anthropic 단가라 openrouter에선 오액(미기록)');
});

test('배선: oneshot.mjs — 402는 성공이 아니라 실패로 승격(크루 카드·기억 오염 방지) + costUsd 미기록', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.match(src, /runner === 'openrouter' && isOpenRouterCreditError\(text\)/, '402 텍스트가 성공으로 반환되면 크루 카드에 영구 저장된다(검수 HIGH-1)');
  assert.match(src, /costUsd: runner === 'openrouter' \? null : costUsd/);
  // 외부 CLI 경로(externalExec)에 openrouter 분기가 생기면 BYOK 원칙 위반
  const runners = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  const external = runners.split('export async function externalExec')[1]?.split('\n}')[0] ?? '';
  assert.doesNotMatch(external, /openrouter/, 'openrouter는 SDK 계열 — externalExec(CLI) 분기 금지');
});

test('배선: PICK_ORDER ↔ RUNNER_AUTH 동기화 (다음 러너 추가 때 또 깨질 자리 — 불변식 수색)', async () => {
  const { PICK_ORDER } = await import('../app/runner-usable.mjs');
  assert.deepEqual([...PICK_ORDER].sort(), Object.keys(RUNNER_AUTH).sort(), 'PICK_ORDER에 빠진 러너는 명판·가용 판정에서 유령이 된다');
});
