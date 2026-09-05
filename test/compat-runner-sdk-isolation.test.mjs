// Anthropic 호환 러너(openrouter·glm·kimi·grok)의 SDK 격리 env — 실측 2026-09-03(OpenRouter 무료 모델 E2E, 이 기기엔 Claude Code 로그인이 있다):
//  · 호스트 ~/.claude가 보이면 CLI가 제3자 base 요청에 인증 헤더를 빼고 190초 뒤 401(Missing Authentication header) → CLAUDE_CONFIG_DIR 격리
//  · CLI 2.1.x 기본 도구 검색(deferred tools)은 비 Anthropic 엔드포인트에서 400 → ENABLE_TOOL_SEARCH=false
// claude 러너(Anthropic 본가)는 둘 다 건드리지 않는다 — 도구 검색은 본가에서만 동작하고, host 옵트인은 진짜 ~/.claude 로그인이 필요하다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
// 실 홈 미접촉 — compatSdkEnv가 ~/.argo/claude-config-*를 만든다(검수 LOW-1, runner-cred.test.mjs 선례)
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-compat-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-compat-'));
const { createCompany } = await import('../src/workspace.mjs');
const { saveRunnerCred, runnerCredEnv, glmEnv, kimiEnv, compatSdkEnv } = await import('../src/runners/creds.mjs');
const ws = 'compat-iso'; await createCompany(ws, '격리', '사장', null, 'ko');

test('호환 러너 4종의 턴 env에 CLAUDE_CONFIG_DIR(회사별 격리)·ENABLE_TOOL_SEARCH=false가 실린다', async () => {
  for (const [runner, value] of [['openrouter', 'sk-or-x'], ['glm', 'glm-x'], ['kimi', 'kimi-x'], ['grok', 'xai-x']]) {
    await saveRunnerCred(ws, runner, 'apikey', value);
    const { env } = await runnerCredEnv(ws, runner);
    assert.equal(env.ENABLE_TOOL_SEARCH, 'false', `${runner}: 도구 검색이 켜져 있으면 비 Anthropic 엔드포인트가 400을 낸다`);
    assert.equal(env.CLAUDE_CONFIG_DIR, join(homedir(), '.argo', `claude-config-ws-${ws}`), `${runner}: 호스트 ~/.claude를 보면 인증 헤더가 빠진다`);
    assert.equal(env.ANTHROPIC_API_KEY, '', `${runner}: 기존 계약(Anthropic 키 소거) 유지`);
  }
});

test('호스트 폴백 glmEnv/kimiEnv도 같은 격리를 받는다(스코프는 hostfb-*)', () => {
  assert.equal(glmEnv().ENABLE_TOOL_SEARCH, 'false');
  assert.match(glmEnv().CLAUDE_CONFIG_DIR, /claude-config-hostfb-glm$/);
  assert.match(kimiEnv().CLAUDE_CONFIG_DIR, /claude-config-hostfb-kimi$/);
});

// 회사 폴더와 호스트 폴백 폴더의 네임스페이스가 갈리는가 — 슬러그가 'hostfb-glm'인 회사가 호스트 폴백
// 버킷(세션·대화 전사본이 쌓이는 곳)을 함께 쓰면 테넌트 경계가 무너진다(검수 LOW-2).
test('회사 스코프와 호스트 폴백 스코프는 접두로 갈린다 — 슬러그 충돌로도 같은 폴더가 되지 않는다', async () => {
  const evil = 'hostfb-glm';
  await createCompany(evil, '충돌', '사장', null, 'ko');
  await saveRunnerCred(evil, 'glm', 'apikey', 'glm-y');
  const { env } = await runnerCredEnv(evil, 'glm');
  assert.notEqual(env.CLAUDE_CONFIG_DIR, glmEnv().CLAUDE_CONFIG_DIR, '회사 폴더 ≠ 호스트 폴백 폴더');
  assert.match(env.CLAUDE_CONFIG_DIR, /claude-config-ws-hostfb-glm$/);
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

// 스위프 — 러너 env를 조립하는 테스트는 전부 HOME을 임시화해야 한다. compatSdkEnv가 ~/.argo/claude-config-*를
// 만들기 때문에, 한 파일만 빠져도 개발자·CI 홈에 폴더가 쌓인다(검수 LOW-1 실측: 6개 잔존).
// 목록이 아니라 규칙으로 잠근다 — 새 테스트가 생겨도 자동으로 걸린다(레포 교훈: 규칙 vs 목록이면 목록이 뒤처진다).
test('스위프: 러너 env를 조립하는 테스트 파일은 모두 HOME을 임시화한다', async () => {
  const { readdir, readFile: rf } = await import('node:fs/promises');
  const dir = new URL('.', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.test.mjs'));
  const missing = [];
  for (const f of files) {
    const src = await rf(new URL(f, dir), 'utf8');
    // sdkEnvFor도 compatSdkEnv에 도달한다 — 이 토큰이 빠져 있으면 자격만 심고 sdkEnvFor를 부르는
    // 테스트가 실 홈에 폴더를 만들면서도 스위프를 통과한다(2차 검수 실측 미탐).
    const buildsEnv = /\b(runnerCredEnv|sdkEnvFor|compatSdkEnv|glmEnv\(|kimiEnv\()/.test(src);
    if (buildsEnv && !/process\.env\.HOME\s*=/.test(src)) missing.push(f);
  }
  assert.deepEqual(missing, [], `HOME 임시화 누락 — 실 홈에 claude-config-*가 쌓인다: ${missing.join(', ')}`);
});
