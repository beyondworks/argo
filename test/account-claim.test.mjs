// 로컬(게스트) → 로그인 전환 — "새 계정"이 아니라 같은 사람의 이어짐(유건 지시 2026-08-21).
// 잠그는 것: ① 주인 없는 회사가 로그인 계정으로 귀속된다 ② 로컬 스코프 계정 자격이 uid 스코프로
// 복사된다(이미 있는 러너는 덮지 않음) ③ 게스트 마커가 해제된다 ④ 로컬/게스트 id로는 호출 불가.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-claim-'));
const { createCompany, loadCompany } = await import('../src/workspace.mjs');
const { accountScope, saveRunnerCred, loadRunnerCred } = await import('../src/runners/creds.mjs');
const { enableGuestMode, guestModeOn } = await import('../src/gueststate.mjs');
const { claimLocalToAccount, migrateLocalAccountCreds } = await import('../src/accountclaim.mjs');

test('게스트 회사 + 로컬 자격 → 로그인 계정으로 그대로 이어진다', async () => {
  await createCompany('guestco-a1', '게스트 회사', 'captain', null, 'ko'); // ownerId 없음 = 주인 없는 회사
  await saveRunnerCred(accountScope('local'), 'claude', 'apikey', 'sk-ant-test-local-cred-000000000000');
  await enableGuestMode();
  assert.equal(guestModeOn(), true);

  const r = await claimLocalToAccount('uid-test-1');
  assert.equal(r.claimed, 1, '주인 없는 회사 1개 귀속');
  assert.deepEqual(r.names, ['게스트 회사']);
  assert.deepEqual(r.creds, ['claude'], '로컬 계정 자격이 uid 스코프로 복사');

  const c = await loadCompany('guestco-a1');
  assert.equal(c.ownerId, 'uid-test-1', '회사 주인이 로그인 계정');
  const moved = await loadRunnerCred(accountScope('uid-test-1'), 'claude');
  assert.equal(moved?.value, 'sk-ant-test-local-cred-000000000000', '계정 스코프에서 같은 자격이 보인다 — 다음 회사 시드 가능');
  assert.equal(guestModeOn(), false, '게스트 마커 해제');
});

test('계정에 이미 연결된 러너는 로컬 것이 덮지 않는다 (덮으면 로그인 직후 자격이 바뀐다)', async () => {
  await saveRunnerCred(accountScope('local'), 'claude', 'apikey', 'sk-ant-test-local-B-00000000000000');
  await saveRunnerCred(accountScope('uid-test-2'), 'claude', 'apikey', 'sk-ant-test-account-0000000000000');
  const moved = await migrateLocalAccountCreds('uid-test-2');
  assert.deepEqual(moved, [], '덮어쓰기 없음');
  assert.equal((await loadRunnerCred(accountScope('uid-test-2'), 'claude'))?.value, 'sk-ant-test-account-0000000000000');
});

test('로컬·게스트 id는 귀속 주체가 될 수 없다', async () => {
  await assert.rejects(() => claimLocalToAccount('local'));
  await assert.rejects(() => claimLocalToAccount('guest'));
  assert.deepEqual(await migrateLocalAccountCreds('local'), []);
});
