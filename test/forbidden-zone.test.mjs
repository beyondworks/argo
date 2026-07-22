// 금지 구역(하드 차단) 회귀 테스트 — 실사용 크리티컬(2026-07-22) 고정:
// 크루가 실행 중인 Argo 앱 코드·~/.argo·타사 워크스페이스·자격 파일을 만지지 못한다.
// bypass/fs 능력이 켜져 있어도 열리지 않는 것이 계약이다(permission-gate.mjs makeIsForbidden).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-forbid-'));
const { makeIsForbidden, makePermissionGate } = await import('../src/permission-gate.mjs');

const WS_ROOT = process.env.ARGO_ROOT;
const wsRoot = join(WS_ROOT, 'my-co');
await mkdir(join(wsRoot, 'vault', 'notes'), { recursive: true });
await mkdir(join(WS_ROOT, 'other-co'), { recursive: true });
await writeFile(join(wsRoot, '.secrets.json'), '{}');
await writeFile(join(WS_ROOT, '.account-secrets-local.json'), '{}');

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // 이 레포 = 실행 중인 Argo 코드 루트

test('isForbidden: 실행 중인 Argo 코드 루트는 금지(앱 본체 수정 차단의 본체)', async () => {
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(APP_ROOT, 'src', 'chat.mjs')), true, '서버 코드');
  assert.equal(await f(join(APP_ROOT, 'app', 'globals.css')), true, '앱 UI 코드');
});

test('isForbidden: ~/.argo(격리 홈·자격)와 타사 워크스페이스·계정 시크릿은 금지', async () => {
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(homedir(), '.argo', 'codex-home-x', 'auth.json')), true);
  assert.equal(await f(join(WS_ROOT, 'other-co', 'company.json')), true, '교차 테넌트');
  assert.equal(await f(join(WS_ROOT, '.account-secrets-local.json')), true, '계정 시크릿');
});

test('isForbidden: 자기 워크스페이스 일반 파일은 허용, 직속 도트파일(.secrets.json)만 금지', async () => {
  const f = makeIsForbidden(wsRoot);
  assert.equal(await f(join(wsRoot, 'vault', 'notes', 'memo.md')), false, '크루의 책상');
  assert.equal(await f('vault/notes/memo.md'), false, '상대경로도 워크스페이스 기준');
  assert.equal(await f(join(wsRoot, '.secrets.json')), true, '회사 자격 파일');
  await mkdir(join(wsRoot, 'chats', '.archive'), { recursive: true });
  assert.equal(await f(join(wsRoot, 'chats', '.archive', 'old.json')), false, '한 단계 아래 도트 디렉토리는 정상 데이터');
});

test('isForbidden: 워크스페이스 안 심링크로 금지 구역을 우회하지 못한다', async () => {
  const f = makeIsForbidden(wsRoot);
  await symlink(APP_ROOT, join(wsRoot, 'vault', 'applink')).catch(() => {});
  assert.equal(await f(join(wsRoot, 'vault', 'applink', 'src', 'chat.mjs')), true, '심링크 canonical 판정');
});

test('permissionGate: bypass가 켜져 있어도 금지 구역 Write/Edit/Read는 deny', async () => {
  const caps = { fs: true, browser: true, shell: true, bypass: true };
  const gate = makePermissionGate('my-co', 'crew-a', caps, wsRoot);
  const w = await gate('Write', { file_path: join(APP_ROOT, 'app', 'ui.jsx'), content: 'x' });
  assert.equal(w.behavior, 'deny', 'bypass는 결재 생략이지 보호 구역 해제가 아니다');
  const r = await gate('Read', { file_path: join(wsRoot, '.secrets.json') });
  assert.equal(r.behavior, 'deny', '자격 파일 읽기 차단(유출 방지)');
  const ok = await gate('Write', { file_path: join(wsRoot, 'vault', 'notes', 'draft.md'), content: 'x' });
  assert.equal(ok.behavior, 'allow', '워크스페이스 일반 파일은 그대로 허용(회귀 없음)');
  const bash = await gate('Bash', { command: `sed -i '' 's/a/b/' ${join(APP_ROOT, 'src', 'chat.mjs')}` });
  assert.equal(bash.behavior, 'deny', '금지 구역 리터럴 경로가 든 셸 명령 1차 방어');
});

test('permissionGate: fs 능력이 켜져도 금지 구역 밖 일반 외부 경로는 기존대로 허용(회귀 없음)', async () => {
  const caps = { fs: true, browser: false, shell: false, bypass: false };
  const gate = makePermissionGate('my-co', 'crew-a', caps, wsRoot);
  const outside = await mkdtemp(join(tmpdir(), 'argo-outside-'));
  const r = await gate('Write', { file_path: join(outside, 'report.md'), content: 'x' });
  assert.equal(r.behavior, 'allow', 'fs 능력의 목적(사용자 문서 접근)은 유지');
});
