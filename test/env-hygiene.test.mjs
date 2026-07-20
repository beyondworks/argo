// env·시크릿 위생 회귀 테스트(감사 2026-07-20) — ① 실행 러너 외 제공사 키가 자식 프로세스에 상속
// (printenv 크로스 러너 유출) ② glm/kimi 턴에 CLAUDE_CODE_OAUTH_TOKEN 잔존 ③ 외부 CLI 실패
// 경로(apiError)에 키 마스킹 부재 — SDK 경로만 마스킹돼 동기화 이벤트 로그에 키 조각 영속.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-hygtest-'));
process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-hyghome-'));
const { scrubServerSecrets, maskKeyLike, saveRunnerCred, sdkEnvFor } = await import('../src/runners.mjs');

const FULL_ENV = {
  PATH: '/usr/bin', LANG: 'ko_KR.UTF-8',
  SUPABASE_SERVICE_ROLE_KEY: 'crown',
  ANTHROPIC_API_KEY: 'a-key', CLAUDE_CODE_OAUTH_TOKEN: 'a-oat', ANTHROPIC_AUTH_TOKEN: 'a-tok',
  OPENAI_API_KEY: 'o-key', GEMINI_API_KEY: 'g-key', GOOGLE_API_KEY: 'gg-key',
  GLM_API_KEY: 'z-key', KIMI_API_KEY: 'k-key',
};

test('scrubServerSecrets(env, runner): 실행 러너 소유 아닌 제공사 키 제거 — 크로스 러너 유출 차단', () => {
  const codex = scrubServerSecrets(FULL_ENV, 'codex');
  assert.equal(codex.OPENAI_API_KEY, 'o-key', '실행 러너(codex) 자신의 키는 보존');
  assert.equal(codex.PATH, '/usr/bin', '운영 변수 보존');
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GLM_API_KEY', 'KIMI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    assert.ok(!(k in codex), `codex 턴에 ${k} 부재 — printenv로 타 제공사 자격 열람 불가`);
  }
  const glm = scrubServerSecrets(FULL_ENV, 'glm');
  assert.equal(glm.GLM_API_KEY, 'z-key');
  assert.equal(glm.ANTHROPIC_AUTH_TOKEN, 'a-tok', 'Anthropic 호환 프로토콜 공용 변수는 glm 소유');
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in glm), 'Anthropic 구독 토큰은 glm 턴에서 제거');
  assert.ok(!('OPENAI_API_KEY' in glm));
  const claude = scrubServerSecrets(FULL_ENV, 'claude');
  assert.equal(claude.ANTHROPIC_API_KEY, 'a-key');
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, 'a-oat');
  assert.ok(!('GLM_API_KEY' in claude) && !('OPENAI_API_KEY' in claude) && !('GEMINI_API_KEY' in claude));
});

test('scrubServerSecrets(env): runner 미지정은 기존 동작 — 서버 시크릿만 제거(하위호환)', () => {
  const out = scrubServerSecrets(FULL_ENV);
  assert.ok(!('SUPABASE_SERVICE_ROLE_KEY' in out), '크라운주얼은 항상 제거');
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GLM_API_KEY', 'KIMI_API_KEY']) {
    assert.equal(out[k], FULL_ENV[k], `runner 미지정이면 제공사 키 보존(${k}) — 기존 소비처 무회귀`);
  }
});

test('maskKeyLike: 벤더 키 패턴 마스킹 — CLI 실패 경로와 SDK 경로 공용', () => {
  assert.equal(maskKeyLike('Incorrect API key provided: sk-proj-abcdefghijklmnop1234'), 'Incorrect API key provided: sk-***');
  assert.equal(maskKeyLike('token sk-ant-oat01-AbCdEf bad'), 'token sk-*** bad');
  assert.equal(maskKeyLike('key AIzaSyA1234567890abcdefghij invalid'), 'key sk-*** invalid');
  assert.equal(maskKeyLike('no key here (exit 1)'), 'no key here (exit 1)', '키 없는 메시지는 그대로');
});

test('sdkEnvFor(glm): 회사 자격 턴 env에 CLAUDE_CODE_OAUTH_TOKEN이 남지 않는다', async () => {
  const WS = 'hygco';
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-subscription-token'; // 호스트에 claude env 연결이 있는 상태
  try {
    await saveRunnerCred(WS, 'glm', 'apikey', 'glm-company-key');
    const env = await sdkEnvFor(WS, 'glm');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'glm-company-key', 'glm 회사 자격으로 실행');
    assert.ok(!env.CLAUDE_CODE_OAUTH_TOKEN, 'Anthropic 구독 토큰이 제3자(z.ai) 향 턴 env에 부재(빈 값 포함 허용)');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  }
});
