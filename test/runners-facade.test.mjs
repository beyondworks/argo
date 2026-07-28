// runners.mjs facade 계약 테스트 — 관심사 분리(src/runners/*) 후 재배선 누락으로 export가
// 조용히 사라지는 것을 영구 차단한다. 이름 목록은 분리 직전(main cb94975) 스냅샷을 하드코딩 —
// export를 의도적으로 제거·개명하려면 이 목록을 함께 고쳐야 한다(그게 이 게이트의 목적).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 임시 ARGO_ROOT — WS_ROOT는 모듈 로드 시 고정되므로 import보다 먼저 심는다(실데이터 미접촉)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-facadetest-'));
const R = await import('../src/runners.mjs');

// 분리 직전 베이스라인 62개 — 알파벳순
const BASELINE = [
  'CODEX_EFFORTS', 'GLM_DEFAULT_MODEL', 'KIMI_DEFAULT_MODEL',
  'OPENROUTER_DEFAULT_MODEL', 'OPENROUTER_ONBOARD_MODEL', 'RUNNERS', 'RUNNER_AUTH',
  'accountScope', 'apiError', 'billedRunnerMap', 'bundledClaudeCli', 'claudeEnvFor',
  'clearRunnerCred', 'codexEffortArgs', 'codexSandboxArgs', 'detectRunners',
  'externalExec', 'extractSetupAuthUrl', 'extractSetupToken', 'extractSetupTokenCandidates',
  'glmEnv', 'homeEnv', 'hostOptInAllowed', 'importCodexAuth', 'isBilledRunner',
  'isCliRunner', 'isOpenRouterCreditError', 'isOpenRouterCreditReply',
  'isOpenRouterLimitError', 'isOpenRouterLimitReply', 'isServerSecretKey', 'kimiEnv',
  'loadClaudeKey', 'loadRunnerCred', 'maskClaudeKey', 'maskCred', 'maskKeyLike',
  'normalizePastedCred', 'oauthFormatError', 'pickRunner', 'probeGeminiHostOAuth',
  'probeGeminiOAuth', 'provisionCodexCli', 'provisionGeminiCli', 'recoverCodexAuth',
  'resolveRunner', 'runnerCredEnv', 'runnerLoginStatus', 'runnerStatus', 'saveRunnerCred',
  'scrubServerSecrets', 'sdkEnvFor', 'seedRunnerCreds', 'setupTokenStatus',
  'startClaudeSetupToken', 'startRunnerLogin', 'startRunnerWebAuth', 'submitRunnerWebAuth',
  'submitSetupCode', 'verifyRunnerCred', 'webAuthDone', 'writeCodexTurnConfig',
];

test('facade 계약 — 베이스라인 62개 export가 전부 존재하고 undefined가 아니다', () => {
  assert.equal(BASELINE.length, 62, '베이스라인 목록 자체가 62개여야 한다');
  for (const name of BASELINE) {
    assert.ok(name in R, `export 유실: ${name} — src/runners/*.mjs 재배선(facade re-export)을 확인하라`);
    assert.notEqual(typeof R[name], 'undefined', `export가 undefined: ${name}`);
  }
});
