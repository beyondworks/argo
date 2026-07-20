// 론칭 차단 보안 이슈 회귀 테스트 — 각 익스플로잇이 다시 열리지 않도록 보안 속성을 고정한다.
// 실행: npm test (node --test). 외부 의존 없이 순수·파일 단위만 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeRel } from '../src/sync.mjs';
import { scrubServerSecrets, isServerSecretKey } from '../src/runners.mjs';
import { makeInWorkspace, readToolTargets } from '../src/permission-gate.mjs';
import { arbitraryMcpBlocked, assertArbitraryMcpAllowed } from '../src/market.mjs';
import { writeJsonAtomic } from '../src/jsonstore.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'argo-sec-'));

/* ── P1-7: 원격 매니페스트 경로 탈출 차단 ── */
test('safeRel: 정상 상대경로는 허용', () => {
  for (const ok of ['company.json', 'chats/x.json', 'vault/notes/a.md', 'a/b/c.txt']) {
    assert.equal(safeRel(ok), true, ok);
  }
});
test('safeRel: 경로 탈출·절대경로·불량 세그먼트는 거부', () => {
  for (const bad of [
    '../etc/passwd', '../../x', 'a/../../b', '/etc/passwd', 'a//b', './x', 'a/./b',
    'a/..', '..', '.', '', 'a/\0/b', 'a/b/../../../c',
    'a\\b\\c', '..\\..\\etc', 'C:\\Windows', 'c:/x', 'sub\\..\\x', // Windows: 백슬래시·드라이브문자
  ]) {
    assert.equal(safeRel(bad), false, bad);
  }
});

/* ── P1-6: 서버 시크릿 env 세척(러너 자식 프로세스 유출 차단) ── */
test('scrubServerSecrets: 크로스테넌트 크라운주얼은 제거, 러너 키·운영변수는 보존', () => {
  const out = scrubServerSecrets({
    SUPABASE_SERVICE_ROLE_KEY: 'crown',
    DATABASE_URL: 'postgres://x',
    LS_WEBHOOK_SECRET: 'w',
    MY_JWT_SECRET: 'j',
    ANTHROPIC_API_KEY: 'a',
    CLAUDE_CODE_OAUTH_TOKEN: 'o',
    GLM_API_KEY: 'g',
    OPENAI_API_KEY: 'oa',
    GEMINI_API_KEY: 'ge',
    PATH: '/usr/bin',
    HOME: '/home/u',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  });
  // 제거되어야 하는 서버 시크릿
  for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'LS_WEBHOOK_SECRET', 'MY_JWT_SECRET']) {
    assert.equal(out[k], undefined, `${k}는 세척되어야 함`);
    assert.equal(isServerSecretKey(k), true, `${k}는 서버 시크릿으로 분류되어야 함`);
  }
  // 러너 동작에 필요한 키·운영 변수·공개 키는 보존
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GLM_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PATH', 'HOME', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
    assert.ok(k in out, `${k}는 보존되어야 함`);
    assert.equal(isServerSecretKey(k), false, `${k}는 서버 시크릿이 아니어야 함`);
  }
});

/* ── P1-5: 파일 읽기 워크스페이스 경계 + 심링크 탈출 방어 ── */
test('makeInWorkspace: 안은 허용, ../ 탈출·심링크 탈출은 거부', async () => {
  const root = await tmp();
  const inside = join(root, 'a.txt');
  await writeFile(inside, 'x');
  const outside = await tmp();
  await writeFile(join(outside, 'secret'), 's');
  await symlink(outside, join(root, 'link')); // 워크스페이스 안 → 밖을 가리키는 심링크

  const inWs = makeInWorkspace(root);
  assert.equal(await inWs(inside), true, '워크스페이스 안 파일');
  assert.equal(await inWs(join(root, 'sub', 'nonexistent.txt')), true, '안의 미존재 경로(부모가 안)');
  assert.equal(await inWs(join(root, '..', 'etc', 'passwd')), false, '렉시컬 ../ 탈출');
  assert.equal(await inWs('/etc/passwd'), false, '절대경로 밖');
  assert.equal(await inWs(join(root, 'link', 'secret')), false, '심링크를 통한 탈출');
  assert.equal(await inWs(''), false, '빈 경로');

  assert.equal(await inWs('/Users/x/**/.env'), false, '절대 glob 패턴은 밖');
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('readToolTargets: Glob은 path·pattern 모두 검사(path가 안이어도 절대 pattern 탈출 차단), Grep pattern 제외', () => {
  assert.deepEqual(readToolTargets('Read', { file_path: '/etc/passwd' }), ['/etc/passwd']);
  assert.deepEqual(readToolTargets('Glob', { pattern: '/Users/**/.env' }), ['/Users/**/.env']); // 절대 pattern → 검사
  assert.deepEqual(readToolTargets('Glob', { path: '/inside', pattern: '/Users/**/.env' }), ['/inside', '/Users/**/.env']); // 둘 다 — pattern 탈출 못 숨김
  assert.deepEqual(readToolTargets('Glob', { pattern: '**/*.js' }), ['**/*.js']); // 상대 pattern → cwd 내
  assert.deepEqual(readToolTargets('Grep', { pattern: 'secret' }), []); // pattern은 정규식 — 경로 아님(허용)
  assert.deepEqual(readToolTargets('Grep', { pattern: 'x', path: '/etc' }), ['/etc']);
});

/* ── P0-2: 호스팅 모드에서 임의 명령 실행형 MCP 차단 ── */
test('arbitraryMcpBlocked: 서비스키/테넌트 있으면 차단, opt-in·로컬이면 허용', () => {
  const save = {
    s: process.env.SUPABASE_SERVICE_ROLE_KEY,
    t: process.env.ARGO_TENANT_OWNER,
    a: process.env.ARGO_ALLOW_CUSTOM_MCP,
    d: process.env.ARGO_STANDALONE,
  };
  const setOrDel = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.ARGO_TENANT_OWNER;
    delete process.env.ARGO_ALLOW_CUSTOM_MCP;
    delete process.env.ARGO_STANDALONE; // 게이트가 이 값도 보므로 결정성 위해 명시 초기화
    assert.equal(arbitraryMcpBlocked(), false, '로컬(크라운주얼 없음) — 허용');
    assert.doesNotThrow(() => assertArbitraryMcpAllowed());

    process.env.SUPABASE_SERVICE_ROLE_KEY = 'crown';
    assert.equal(arbitraryMcpBlocked(), true, '서비스 키 있음 — 차단');
    assert.throws(() => assertArbitraryMcpAllowed(), /호스팅/);

    // 벨트 — 데스크톱 사이드카(ARGO_STANDALONE=1)는 서비스 키만 env로 새어든 경우 로컬 앱이라 허용
    process.env.ARGO_STANDALONE = '1';
    assert.equal(arbitraryMcpBlocked(), false, 'standalone — 서비스 키만 있으면 허용(벨트)');
    delete process.env.ARGO_STANDALONE;

    // 서비스 키만(테넌트 아님)일 때는 명시 opt-in으로도 해제
    process.env.ARGO_ALLOW_CUSTOM_MCP = '1';
    assert.equal(arbitraryMcpBlocked(), false, '서비스 키 + 명시 opt-in — 해제');
    delete process.env.ARGO_ALLOW_CUSTOM_MCP;

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.ARGO_TENANT_OWNER = 'user-123';
    assert.equal(arbitraryMcpBlocked(), true, '테넌트 바인딩 — 차단');

    // 테넌트 바인딩(멀티테넌트 마커)은 standalone·opt-in belt로도 못 여는 하드 차단 —
    // runners.mjs startClaudeSetupToken와 동일 불변식(상위 능력이라 방어는 최소한 대칭, 검수 HIGH)
    process.env.ARGO_STANDALONE = '1';
    assert.equal(arbitraryMcpBlocked(), true, 'standalone이어도 테넌트 바인딩은 차단(불변)');
    delete process.env.ARGO_STANDALONE;
    process.env.ARGO_ALLOW_CUSTOM_MCP = '1';
    assert.equal(arbitraryMcpBlocked(), true, 'opt-in이어도 테넌트 바인딩은 차단(불변)');
  } finally {
    setOrDel('SUPABASE_SERVICE_ROLE_KEY', save.s);
    setOrDel('ARGO_TENANT_OWNER', save.t);
    setOrDel('ARGO_ALLOW_CUSTOM_MCP', save.a);
    setOrDel('ARGO_STANDALONE', save.d);
  }
});

/* ── P1-8: 시크릿 담는 워크스페이스 JSON은 0600으로 생성 ── */
test('writeJsonAtomic: 0600으로 생성(소유자만)', async () => {
  const d = await tmp();
  const f = join(d, '.secrets.json');
  await writeJsonAtomic(f, { runners: { claude: { type: 'apikey', value: 'sk-x' } } });
  const mode = (await stat(f)).mode & 0o777;
  assert.equal(mode, 0o600, `기대 0600, 실제 ${mode.toString(8)}`);
  await rm(d, { recursive: true, force: true });
});
