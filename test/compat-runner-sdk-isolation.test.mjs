// Anthropic 호환 러너(openrouter·glm·kimi·grok)의 SDK 격리 env — 실측 2026-09-03(OpenRouter 무료 모델 E2E, 이 기기엔 Claude Code 로그인이 있다):
//  · 호스트 ~/.claude가 보이면 CLI가 제3자 base 요청에 인증 헤더를 빼고 190초 뒤 401(Missing Authentication header) → CLAUDE_CONFIG_DIR 격리
//  · CLI 2.1.x 기본 도구 검색(deferred tools)은 비 Anthropic 엔드포인트에서 400 → ENABLE_TOOL_SEARCH=false
// claude 러너(Anthropic 본가)는 둘 다 건드리지 않는다 — 도구 검색은 본가에서만 동작하고, host 옵트인은 진짜 ~/.claude 로그인이 필요하다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-compat-'));
const { createCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred, runnerCredEnv, glmEnv, kimiEnv, compatSdkEnv } = await import('../src/runners/creds.mjs');
const ws = 'compat-iso'; await createCompany(ws, '격리', '사장', null, 'ko');

test('호환 러너 4종의 턴 env에 CLAUDE_CONFIG_DIR(회사별 격리)·ENABLE_TOOL_SEARCH=false가 실린다', async () => {
  for (const [runner, value] of [['openrouter', 'sk-or-x'], ['glm', 'glm-x'], ['kimi', 'kimi-x'], ['grok', 'xai-x']]) {
    await saveRunnerCred(ws, runner, 'apikey', value);
    const { env } = await runnerCredEnv(ws, runner);
    assert.equal(env.ENABLE_TOOL_SEARCH, 'false', `${runner}: 도구 검색이 켜져 있으면 비 Anthropic 엔드포인트가 400을 낸다`);
    assert.equal(env.CLAUDE_CONFIG_DIR, join(homedir(), '.argo', `claude-config-${ws}`), `${runner}: 호스트 ~/.claude를 보면 인증 헤더가 빠진다`);
    assert.equal(env.ANTHROPIC_API_KEY, '', `${runner}: 기존 계약(Anthropic 키 소거) 유지`);
  }
});

test('호스트 폴백 glmEnv/kimiEnv도 같은 격리를 받는다(스코프는 host-*)', () => {
  assert.equal(glmEnv().ENABLE_TOOL_SEARCH, 'false');
  assert.match(glmEnv().CLAUDE_CONFIG_DIR, /claude-config-host-glm$/);
  assert.match(kimiEnv().CLAUDE_CONFIG_DIR, /claude-config-host-kimi$/);
});

test('claude 러너(본가)는 격리·도구 검색 스위치를 받지 않는다 — 회귀 핀', async () => {
  await saveRunnerCred(ws, 'claude', 'apikey', 'sk-ant-x');
  const { env } = await runnerCredEnv(ws, 'claude');
  assert.ok(!('CLAUDE_CONFIG_DIR' in env) && !('ENABLE_TOOL_SEARCH' in env), 'claude 본가 턴에 호환용 스위치가 새면 도구 검색·host 로그인이 깨진다');
  assert.equal((await (async () => { await saveRunnerCred(ws, 'claude', 'host', 'host'); return runnerCredEnv(ws, 'claude'); })()), null, 'host 옵트인은 env 주입 없음(기존 계약)');
});

test('compatSdkEnv는 순수 형태 — 스코프별 다른 폴더', () => {
  assert.notEqual(compatSdkEnv('a').CLAUDE_CONFIG_DIR, compatSdkEnv('b').CLAUDE_CONFIG_DIR);
});
