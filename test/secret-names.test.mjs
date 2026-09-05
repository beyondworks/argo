// 자격 파일명 규칙(secretbox.isSecretNameRel) — 클라우드 감사(2026-09-05)에서 평문으로 발견된 이름들이 봉투 계급이 되고, 예시 파일·일반 문서는 아니다.
// 동기화 효과: 키 미확보(cryptoOn=false) 사이클에서는 EXCLUDE(미업로드), hosted credSync-off에서는 불가시.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-secretnames-'));
const { isSecretRel, isSecretNameRel, SECRET_NAME_RE } = await import('../src/secretbox.mjs');
const { EXCLUDE } = await import('../src/sync.mjs');

test('SN1. 감사에서 평문으로 발견된 이름 전부 봉투 계급, 예시·일반 문서는 제외', () => {
  const found = ['vault/projects/20260830_stock-agent/.env', 'skills/.env', '.env', 'vault/Program/Voice/.env', 'vault/files/google-oauth/credentials.json', 'vault/files/google-oauth/token.json',
    'vault/projects/x/y/tokens.json', 'vault/files/mskt7hcao7b-koreayopotensia_key_20260809.pem', 'vault/projects/matji/helm/matji/templates/secret.yaml', 'vault/projects/matji/k8s/secret.yaml',
    'vault/projects/x/.claude/settings.local.json', 'vault/projects/x/.venv/Lib/site-packages/tornado/test/test.key'];
  for (const r of found) assert.equal(isSecretRel(r), true, `봉투 계급: ${r}`);
  for (const r of ['vault/p/.env.example', 'vault/p/.env.dist', 'vault/p/.env.sample', 'vault/p/.env.template', 'vault/notes/env.md', 'vault/p/README.md', 'company.json', 'routines.json', 'capabilities.json', 'vault/p/package.json', 'chats/seoyun.json', 'vault/p/environment.json', 'vault/p/tokens.md', 'vault/p/secret-santa.md', 'usage.jsonl'])
    assert.equal(isSecretRel(r), false, `일반: ${r}`);
  for (const r of ['x/.ssh/id_rsa', 'x/.aws/credentials', 'x/.codex/auth.json', 'x/.config/gh/hosts.yml', 'vault/p/.env.local', 'vault/p/.env.production', 'x/service-account-prod.json', 'x/id_ed25519.pub', 'x/cert.p12', 'x/.npmrc', 'x/.netrc'])
    assert.equal(isSecretNameRel(r), true, `자격 디렉터리·변형: ${r}`);
  assert.equal(SECRET_NAME_RE.test('.env.example'), false); assert.equal(SECRET_NAME_RE.test('.env.local'), true);
});

test('SN2. 동기화 효과 — 키 미확보 사이클에서 자격 파일명은 EXCLUDE(미업로드), 제어 파일 3종과 같은 취급', () => {
  // cryptoOn()은 계정 키 캐시 유무 — 테스트 프로세스는 키가 없다(=false) → isEncRel && !cryptoOn → EXCLUDE
  for (const r of ['.secrets.json', 'mcp.json', 'connections.json', 'vault/projects/x/.env', 'vault/files/credentials.json', 'vault/k.pem']) assert.equal(EXCLUDE(r), true, `키 없으면 미업로드: ${r}`);
  for (const r of ['vault/notes/a.md', 'vault/p/.env.example', 'company.json']) assert.equal(EXCLUDE(r), false, `일반 파일은 업로드: ${r}`);
});
