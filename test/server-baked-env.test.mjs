// 구글 커넥터 client secret을 빌드 때 서버 전용으로 굽는다(src/server-baked-env.mjs·scripts/bake-server-env.mjs) — 행동 시험. 값은 전부 가짜.
//  · 시크릿이 없는 빌드(포크·로컬): 커넥터는 지금처럼 '준비 중'(notReady), 연결 정의는 던진다.
//  · 구운 파일이 서버 트리 루트(cwd)에 있으면: 준비됨, 연결 정의에 secret이 실린다. process.env가 있으면 그쪽이 먼저.
//  · 구운 값은 process.env로 옮겨지지 않는다(에이전트 자식 프로세스가 물려받지 않게). 허용 목록 밖 키는 읽지 않는다.
//  · 유출 검사(assert-not-in-client)는 값이 있으면 실패하고, 출력에 값을 내지 않는다.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serverEnv, bakedEnv, BAKED_ENV_FILE, BAKED_ENV_NAMES, _resetBakedEnvForTest } from '../src/server-baked-env.mjs';
import { CONNECTOR_CATALOG, CONNECTOR_CATALOG_EN, connectorReady, connectorServerDef, mergeConnectorStatus } from '../src/market.mjs';
import { bakeServerEnv } from '../scripts/bake-server-env.mjs';

const NAME = 'ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET';
const FAKE = 'GOCSPX-fake-for-test-0123456789abcdef';
const repo = fileURLToPath(new URL('..', import.meta.url));
const google = [...CONNECTOR_CATALOG, ...CONNECTOR_CATALOG_EN].filter((i) => i.oauth?.client_secret_env === NAME);
const cwd0 = process.cwd(); const env0 = process.env[NAME];
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'argo-baked-')); process.chdir(dir); delete process.env[NAME]; _resetBakedEnvForTest(); });
afterEach(() => { process.chdir(cwd0); if (env0 === undefined) delete process.env[NAME]; else process.env[NAME] = env0; _resetBakedEnvForTest(); rmSync(dir, { recursive: true, force: true }); });

test('구글 항목 4개(캘린더·Gmail × ko·en)가 이 이름을 쓰고, 허용 목록에 이 이름이 있다', () => {
  assert.equal(google.length, 4);
  assert.deepEqual([...BAKED_ENV_NAMES], [NAME]);
});

test('시크릿 없는 빌드 — 두 커넥터 모두 준비 중, 연결 정의는 배포 설정 오류로 던진다(종전 동작)', () => {
  for (const item of google) {
    assert.equal(connectorReady(item), false, item.id);
    assert.throws(() => connectorServerDef(item), /환경변수 ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET가 설정되지 않았습니다/);
  }
  const rows = mergeConnectorStatus(CONNECTOR_CATALOG, []);
  for (const id of ['google-calendar', 'gmail']) assert.equal(rows.find((r) => r.id === id)?.notReady, true, id);
});

test('빈 값·공백만 있는 구운 파일도 준비 중', () => {
  writeFileSync(join(dir, BAKED_ENV_FILE), JSON.stringify({ [NAME]: '   ' }));
  assert.equal(connectorReady(google[0]), false);
});

test('구운 파일(서버 트리 루트 = cwd) — 준비됨, 연결 정의에 secret, 화면 목록에 notReady 없음', () => {
  writeFileSync(join(dir, BAKED_ENV_FILE), JSON.stringify({ [NAME]: FAKE }));
  for (const item of google) {
    assert.equal(connectorReady(item), true, item.id);
    assert.equal(connectorServerDef(item).oauth.client_secret, FAKE);
  }
  const rows = mergeConnectorStatus(CONNECTOR_CATALOG, []);
  for (const id of ['google-calendar', 'gmail']) assert.equal(rows.find((r) => r.id === id)?.notReady, undefined, id);
  assert.equal(process.env[NAME], undefined, '구운 값을 process.env에 옮기지 않는다 — 자식 프로세스가 물려받지 않게');
  const child = spawnSync(process.execPath, ['-e', `process.stdout.write(String(process.env.${NAME} ?? 'none'))`], { encoding: 'utf8' });
  assert.equal(child.stdout, 'none', '자식 프로세스 env에 없다');
});

test('실행 환경 값이 구운 값보다 먼저', () => {
  writeFileSync(join(dir, BAKED_ENV_FILE), JSON.stringify({ [NAME]: FAKE }));
  process.env[NAME] = 'env-wins-fake';
  assert.equal(serverEnv(NAME), 'env-wins-fake');
  assert.equal(connectorServerDef(google[0]).oauth.client_secret, 'env-wins-fake');
});

test('허용 목록 밖 키·깨진 파일은 읽지 않는다', () => {
  writeFileSync(join(dir, BAKED_ENV_FILE), JSON.stringify({ SUPABASE_SERVICE_ROLE_KEY: 'nope', [NAME]: FAKE }));
  assert.equal(serverEnv('SUPABASE_SERVICE_ROLE_KEY'), undefined);
  assert.deepEqual(Object.keys(bakedEnv()), [NAME]);
  _resetBakedEnvForTest(); writeFileSync(join(dir, BAKED_ENV_FILE), '{not json');
  assert.equal(serverEnv(NAME), undefined);
});

test('server.js 폴더(process.argv[1])에 있어도 읽는다 — cwd가 다른 실행', () => {
  const tree = join(dir, 'tree'); mkdirSync(tree);
  writeFileSync(join(tree, BAKED_ENV_FILE), JSON.stringify({ [NAME]: FAKE }));
  assert.equal(bakedEnv({ dirs: [dir, tree] })[NAME], FAKE);
});

test('굽기 — 값이 있으면 허용 이름만 쓰고(권한 600), 없으면 파일을 만들지 않고 앞 스테이징이 남긴 파일도 지운다', () => {
  const r = bakeServerEnv({ tree: dir, env: { [NAME]: ` ${FAKE} `, OTHER_SECRET: 'x', NEXT_PUBLIC_SUPABASE_URL: 'y' } });
  assert.deepEqual(r.names, [NAME]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, BAKED_ENV_FILE), 'utf8')), { [NAME]: FAKE });
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, BAKED_ENV_FILE)).mode & 0o777, 0o600);
  const r2 = bakeServerEnv({ tree: dir, env: {} });
  assert.deepEqual(r2.names, []); assert.equal(r2.file, null);
  assert.equal(existsSync(join(dir, BAKED_ENV_FILE)), false, '시크릿 없는 빌드에 옛 값이 섞이지 않는다');
});

test('스테이징 유출 가드의 시크릿 파일 패턴에 걸리지 않는 이름이다(가드 뒤에 굽지만, 가드를 우회하려고 이름을 고른 것이 아님을 남긴다)', () => {
  assert.doesNotMatch(BAKED_ENV_FILE, /(^|\.)((account-)?secrets(-[\w-]+)?|sync-credentials|connections|mcp)\.json$/);
  assert.doesNotMatch(BAKED_ENV_FILE, /\.env(\..+)?$/);
  for (const f of ['scripts/stage-sidecar.mjs', 'scripts/stage-server.mjs']) {
    const s = readFileSync(join(repo, f), 'utf8');
    assert.ok(s.indexOf('bakeServerEnv({') > s.indexOf("시크릿 파일 잔존 — 배포 차단"), `${f}: 굽기는 유출 가드 뒤`);
  }
});

test('유출 검사 — 가짜 값이 클라이언트 폴더에 있으면 실패(값은 출력하지 않음), 없으면 통과, 값이 비면 건너뜀', () => {
  const stat = join(dir, 'static'); mkdirSync(join(stat, 'chunks'), { recursive: true });
  writeFileSync(join(stat, 'chunks', 'a.js'), 'console.log("hello")');
  const run = (env) => spawnSync(process.execPath, [join(repo, 'scripts', 'assert-not-in-client.mjs'), stat], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const ok = run({ [NAME]: FAKE }); assert.equal(ok.status, 0, ok.stderr);
  writeFileSync(join(stat, 'chunks', 'b.js'), `var k="${FAKE}"`);
  const bad = run({ [NAME]: FAKE }); assert.equal(bad.status, 1);
  assert.match(bad.stderr, /b\.js/); assert.ok(!(bad.stdout + bad.stderr).includes(FAKE), '값을 출력하지 않는다');
  const skip = run({}); assert.equal(skip.status, 0); assert.match(skip.stdout, /값 없음/);
});

test('클라이언트 화면은 이 값을 읽는 모듈을 가져오지 않고, next 설정은 이 이름을 모른다', async () => {
  const { execFileSync } = await import('node:child_process');
  const files = execFileSync('git', ['ls-files', 'app', 'components'], { cwd: repo, encoding: 'utf8' }).split('\n').filter((f) => /\.(m?jsx?|tsx?)$/.test(f));
  for (const f of files) {
    const s = readFileSync(join(repo, f), 'utf8');
    if (!/^\s*['"]use client['"]/m.test(s)) continue;
    assert.doesNotMatch(s, /server-baked-env|from ['"][./]*src\/market\.mjs['"]/, `${f}('use client')가 서버 전용 값을 가져온다`);
  }
  for (const f of ['next.config.mjs']) if (existsSync(join(repo, f))) assert.ok(!readFileSync(join(repo, f), 'utf8').includes(NAME), `${f}가 ${NAME}을 다룬다(인라인 위험)`);
});
