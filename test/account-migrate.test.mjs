// 레거시 계정 파일 마이그레이션 — 사용자 스코프 도입 전 무스코프 .account-secrets.json이
// local 스코프(.account-secrets-local.json)로 1회 이관되는지. WS_ROOT는 모듈 로드 시 고정되고
// 마이그레이션은 프로세스당 1회 플래그라, 격리를 위해 별도 테스트 파일에서 레거시 파일을 먼저 심은 뒤 import한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-legacy-'));
const ROOT = process.env.ARGO_ROOT;
// import 전에 레거시 파일을 심는다(top-level await — runners.mjs가 첫 로드에서 WS_ROOT를 이 루트로 고정).
await writeFile(join(ROOT, '.account-secrets.json'), JSON.stringify({ runners: { claude: { type: 'apikey', value: 'sk-ant-legacy' } } }));
const { accountScope, loadRunnerCred } = await import('../src/runners.mjs');

test('local 로드 시 레거시 파일이 .account-secrets-local.json으로 이관된다', async () => {
  const cred = await loadRunnerCred(accountScope('local'), 'claude');
  assert.equal(cred?.value, 'sk-ant-legacy');
  assert.ok(existsSync(join(ROOT, '.account-secrets-local.json')), 'local 스코프 파일 생성됨');
  assert.ok(!existsSync(join(ROOT, '.account-secrets.json')), '레거시 원본은 rename으로 사라짐');
});

test('마이그레이션 후 재로드도 안정(local 파일 우선, 재이관 없음)', async () => {
  const cred = await loadRunnerCred(accountScope('local'), 'claude');
  assert.equal(cred?.value, 'sk-ant-legacy');
});
