// 계정 스코프(사용자별) 자격 저장·시드 — 온보딩("로그인 → 러너 연결 → 회사 만들기") 접합부 회귀 테스트.
// 임시 ARGO_ROOT 자가 설정 — 실데이터(~/.argo) 미접촉(approval-resolve 테스트와 동일 패턴).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-acct-'));
const { accountScope, saveRunnerCred, loadRunnerCred, clearRunnerCred, seedRunnerCreds } = await import('../src/runners.mjs');
const { createCompany, WS_ROOT } = await import('../src/workspace.mjs');

const UA = 'user-aaaa';
const UB = 'user-bbbb';

test('계정 자격은 사용자별 파일(.account-secrets-{uid}.json)에 저장된다', async () => {
  await saveRunnerCred(accountScope(UA), 'claude', 'apikey', 'sk-ant-user-a-key');
  const raw = JSON.parse(await readFile(join(WS_ROOT, `.account-secrets-${UA}.json`), 'utf8'));
  assert.equal(raw.runners.claude.value, 'sk-ant-user-a-key');
  assert.deepEqual(await loadRunnerCred(accountScope(UA), 'claude'), { type: 'apikey', value: 'sk-ant-user-a-key' });
});

test('사용자 간 격리 — B는 A의 계정 자격을 보지 못한다', async () => {
  assert.equal(await loadRunnerCred(accountScope(UB), 'claude'), null);
  await saveRunnerCred(accountScope(UB), 'glm', 'apikey', 'glm-user-b-key');
  assert.equal((await loadRunnerCred(accountScope(UA), 'claude')).value, 'sk-ant-user-a-key'); // A 불변
  assert.equal(await loadRunnerCred(accountScope(UA), 'glm'), null); // A는 B의 glm 없음
});

test('안전 uid — 경로 탈출/이상값은 local로 격리된다', async () => {
  // accountScope가 safeUid로 정규화 → '../etc' 등은 local 파일로 귀결(경로 탈출 없음)
  assert.equal(accountScope('../../etc/passwd'), accountScope('local'));
  assert.equal(accountScope(''), accountScope('local'));
  assert.equal(accountScope(null), accountScope('local'));
  await saveRunnerCred(accountScope('../../etc'), 'claude', 'apikey', 'sk-ant-escapes-to-local');
  assert.ok(existsSync(join(WS_ROOT, '.account-secrets-local.json')));
});

test('seedRunnerCreds(wsId, uid) — 그 사용자 계정에서만 복사, 교차 사용자 시드 없음', async () => {
  await createCompany('a-co', 'A 회사', 'captain');
  assert.equal(await seedRunnerCreds('a-co', UA), 1); // A의 claude만
  assert.equal((await loadRunnerCred('a-co', 'claude')).value, 'sk-ant-user-a-key');
  assert.equal(await loadRunnerCred('a-co', 'glm'), null); // B의 glm은 시드 안 됨(격리)

  await createCompany('b-co', 'B 회사', 'captain');
  assert.equal(await seedRunnerCreds('b-co', UB), 1); // B의 glm만
  assert.equal((await loadRunnerCred('b-co', 'glm')).value, 'glm-user-b-key');
  assert.equal(await loadRunnerCred('b-co', 'claude'), null);
});

test('seed는 기존 회사 러너를 덮지 않고, 계정 자격은 남는다', async () => {
  await saveRunnerCred('a-co', 'claude', 'apikey', 'sk-ant-company-own');
  await saveRunnerCred(accountScope(UA), 'claude', 'apikey', 'sk-ant-account-new');
  assert.equal(await seedRunnerCreds('a-co', UA), 0); // 이미 있어 덮지 않음
  assert.equal((await loadRunnerCred('a-co', 'claude')).value, 'sk-ant-company-own');
  assert.equal((await loadRunnerCred(accountScope(UA), 'claude')).value, 'sk-ant-account-new'); // 계정 자격 잔존
});

test('clearRunnerCred는 그 사용자 계정 스코프에서 해당 러너만 제거', async () => {
  await saveRunnerCred(accountScope(UA), 'glm', 'apikey', 'glm-a-extra');
  await clearRunnerCred(accountScope(UA), 'claude');
  assert.equal(await loadRunnerCred(accountScope(UA), 'claude'), null);
  assert.notEqual(await loadRunnerCred(accountScope(UA), 'glm'), null);
});
