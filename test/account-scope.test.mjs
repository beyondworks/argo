// 계정 스코프(@account) 자격 저장·시드 — 온보딩("로그인 → 러너 연결 → 회사 만들기") 접합부 회귀 테스트.
// 임시 ARGO_ROOT 자가 설정 — 실데이터(~/.argo) 미접촉(approval-resolve 테스트와 동일 패턴).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-acct-'));
const { ACCOUNT_SCOPE, saveRunnerCred, loadRunnerCred, clearRunnerCred, seedRunnerCreds } = await import('../src/runners.mjs');
const { createCompany, WS_ROOT } = await import('../src/workspace.mjs');

test('계정 스코프 자격은 WS_ROOT/.account-secrets.json에 저장된다', async () => {
  await saveRunnerCred(ACCOUNT_SCOPE, 'claude', 'apikey', 'sk-ant-test-account-key');
  const raw = JSON.parse(await readFile(join(WS_ROOT, '.account-secrets.json'), 'utf8'));
  assert.equal(raw.runners.claude.value, 'sk-ant-test-account-key');
  assert.deepEqual(await loadRunnerCred(ACCOUNT_SCOPE, 'claude'), { type: 'apikey', value: 'sk-ant-test-account-key' });
});

test('seedRunnerCreds가 계정 자격을 새 회사로 복사한다 — 기존 자격은 덮지 않고, 계정 자격은 남는다', async () => {
  await saveRunnerCred(ACCOUNT_SCOPE, 'glm', 'apikey', 'glm-test-key');
  await createCompany('seed-co', '시드 회사', 'captain');
  assert.equal(await seedRunnerCreds('seed-co'), 2); // claude + glm
  assert.equal((await loadRunnerCred('seed-co', 'claude')).value, 'sk-ant-test-account-key');
  assert.equal((await loadRunnerCred('seed-co', 'glm')).value, 'glm-test-key');
  // 회사가 이미 가진 러너는 시드가 덮지 않는다
  await saveRunnerCred('seed-co', 'claude', 'apikey', 'sk-ant-company-own');
  await saveRunnerCred(ACCOUNT_SCOPE, 'claude', 'apikey', 'sk-ant-account-new');
  assert.equal(await seedRunnerCreds('seed-co'), 0);
  assert.equal((await loadRunnerCred('seed-co', 'claude')).value, 'sk-ant-company-own');
  // 계정 자격은 시드 후에도 남는다 — 다음 회사도 시드받는다
  assert.equal((await loadRunnerCred(ACCOUNT_SCOPE, 'glm')).value, 'glm-test-key');
});

test('clearRunnerCred는 계정 스코프에서도 해당 러너만 제거한다', async () => {
  await clearRunnerCred(ACCOUNT_SCOPE, 'claude');
  assert.equal(await loadRunnerCred(ACCOUNT_SCOPE, 'claude'), null);
  assert.notEqual(await loadRunnerCred(ACCOUNT_SCOPE, 'glm'), null);
});
