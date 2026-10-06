// 앱에 들어 있는 argo(앱 모드) — 앱 데이터 폴더를 같이 쓰되 계정이 섞이지 않고 이중 실행이 없게(설계 2-2, 반대 검토 M-a·M-c·L-h, 2026-10-01).
// 앱 모드 = ARGO_CLI_APP=1(맥 shim·윈도우 argo.cmd)이거나 앱 번들 server 폴더에서 실행될 때. 서버 타르볼의 CLI는 아니다(별도 폴더·동기화 그대로).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { appInstalled, isAppShared, applyCliEnv, appDataRoot, readAppVersion, appVersionChanged } from '../src/cli/env.mjs';
import { writePresence, clearPresence, serverRunning, presenceFile } from '../src/server-presence.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const base = await mkdtemp(join(tmpdir(), 'argo-cli-app-'));

test('앱 모드 판정 — ARGO_CLI_APP=1 또는 앱 번들 server 폴더/윈도우 node.exe 옆에서 실행, 서버 타르볼·저장소는 아니다', () => {
  assert.equal(appInstalled({ repoRoot: '/x/repo', env: { ARGO_CLI_APP: '1' }, platform: 'darwin', execPath: '/usr/bin/node' }), true);
  assert.equal(appInstalled({ repoRoot: '/Applications/Argo.app/Contents/Resources/server', env: {}, platform: 'darwin', execPath: '/Applications/Argo.app/Contents/MacOS/node' }), true, '번들 안에서 직접 실행');
  assert.equal(appInstalled({ repoRoot: '/Users/u/lean-projects/saas/argo', env: {}, platform: 'darwin', execPath: '/opt/homebrew/bin/node' }), false, '저장소');
  assert.equal(appInstalled({ repoRoot: '/home/u/.argo-selfhost/app/argo-server', env: {}, platform: 'linux', execPath: '/usr/bin/node' }), false, '서버 타르볼');
  const win = join(base, 'win-app'); mkdirSync(join(win, 'server'), { recursive: true }); writeFileSync(join(win, 'node.exe'), '');
  assert.equal(appInstalled({ repoRoot: join(win, 'server'), env: {}, platform: 'win32', execPath: join(win, 'node.exe') }), true, '윈도우 — node.exe 옆 server 폴더');
  assert.equal(appInstalled({ repoRoot: join(win, 'server'), env: {}, platform: 'win32', execPath: join(base, 'elsewhere', 'node.exe') }), false);
  assert.equal(appInstalled({ repoRoot: '/x/repo', env: { ARGO_CLI_APP: '0' }, platform: 'darwin', execPath: '/usr/bin/node' }), false);
});

test('앱 모드 환경 — 데이터 폴더는 앱 폴더(계정·로컬 모두), 동기화 끔, 앱 사이드카와 같은 러너 판정(ARGO_STANDALONE)', () => {
  const home = join(base, 'h1');
  for (const mode of [undefined, 'local', 'account']) {
    const cli = join(base, `cli-${mode}`); mkdirSync(cli, { recursive: true });
    if (mode) writeFileSync(join(cli, 'cli.json'), JSON.stringify({ mode }));
    const env = { HOME: home, ARGO_CLI_HOME: cli, ARGO_CLI_APP: '1' };
    applyCliEnv({ repoRoot: base, env, platform: 'darwin', execPath: '/usr/bin/node' });
    assert.equal(env.ARGO_ROOT, appDataRoot({ env, platform: 'darwin', home }), `모드 ${mode}: 앱 폴더`);
    assert.equal(env.ARGO_SYNC, '0', `모드 ${mode}: 앱 CLI는 동기화를 하지 않는다(리더 판정 M2 상태가 되지 않게)`);
    assert.equal(env.ARGO_STANDALONE, '1', `모드 ${mode}: 사이드카와 같은 판정(검토 M-a)`);
    assert.equal(isAppShared({ repoRoot: base, env, platform: 'darwin', execPath: '/usr/bin/node' }), true);
  }
});

test('앱 모드라도 사용자가 데이터 폴더를 직접 줬으면 그 폴더를 쓰고 동기화도 끄지 않는다(앱 폴더를 같이 쓰는 게 아니다)', () => {
  const env = { HOME: join(base, 'h2'), ARGO_CLI_HOME: join(base, 'cli-own'), ARGO_CLI_APP: '1', ARGO_ROOT: join(base, 'my-root') };
  applyCliEnv({ repoRoot: base, env, platform: 'darwin', execPath: '/usr/bin/node' });
  assert.equal(env.ARGO_ROOT, join(base, 'my-root'));
  assert.equal(env.ARGO_SYNC, undefined);
  assert.equal(isAppShared({ repoRoot: base, env, platform: 'darwin', execPath: '/usr/bin/node' }), false);
});

test('서버 타르볼·저장소 CLI는 종전 그대로 — 계정은 CLI 전용 폴더, ARGO_STANDALONE 없음, 동기화 유지', () => {
  const env = { HOME: join(base, 'h3'), ARGO_CLI_HOME: join(base, 'cli-srv') };
  applyCliEnv({ repoRoot: base, env, platform: 'linux', execPath: '/usr/bin/node' });
  assert.equal(env.ARGO_ROOT, join(base, 'cli-srv', 'cli-workspaces'));
  assert.equal(env.ARGO_STANDALONE, undefined);
  assert.equal(env.ARGO_SYNC, undefined);
});

test('앱 모드 환경이면 claude "이 컴퓨터 로그인" 자동 연결이 막힌다 — 앱이 같은 폴더에서 그 자격을 잘못된 연결로 보지 않게(검토 M-a)', () => {
  const probe = (appEnv) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { applyCliEnv } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/cli/env.mjs')).href)});
    applyCliEnv({ repoRoot: ${JSON.stringify(base)}, execPath: '/usr/bin/node' });
    const { hostOptInAllowed } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/runners/catalog.mjs')).href)});
    process.stdout.write(String(hostOptInAllowed('claude')));`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(base, 'h4'), ARGO_CLI_HOME: join(base, 'cli-probe'), ...appEnv } }).stdout;
  assert.equal(probe({}), 'true', '대조: 일반 CLI는 host 로그인을 쓸 수 있다');
  assert.equal(probe({ ARGO_CLI_APP: '1' }), 'false', '앱 모드는 사이드카와 같다');
});

test('앱 버전 — package.json 버전을 읽고, 없으면 null(확인 불가는 종료 사유가 아니다)', () => {
  const d = join(base, 'ver'); mkdirSync(d, { recursive: true });
  assert.equal(readAppVersion(d), null);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '0.1.92' })); assert.equal(readAppVersion(d), '0.1.92');
  writeFileSync(join(d, 'package.json'), '{ broken'); assert.equal(readAppVersion(d), null);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '0.1.92' }));
  assert.equal(appVersionChanged(d, '0.1.92'), false);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '0.1.93' }));
  assert.equal(appVersionChanged(d, '0.1.92'), true, '앱이 업데이트로 파일을 바꿨다 — 옛 모듈로 도는 프로세스는 멈춘다(지연 import가 두 버전을 섞기 전에)');
  writeFileSync(join(d, 'package.json'), '{ broken'); assert.equal(appVersionChanged(d, '0.1.92'), false, '읽을 수 없으면 종료 사유가 아니다');
  assert.equal(appVersionChanged(d, null), false);
});

test('서버 존재 표식 — 쓰고 지우고, 살아 있는 다른 프로세스만 "실행 중"으로 본다(죽은 pid·깨진 파일·내 pid는 아님)', () => {
  const root = join(base, 'pres'); mkdirSync(root, { recursive: true });
  assert.equal(serverRunning(root), null);
  writePresence(root, { pid: process.ppid });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(presenceFile(root), 'utf8'))).sort(), ['at', 'pid'], '표식은 pid와 시각뿐(경로·계정·토큰 없음)');
  assert.equal(serverRunning(root).pid, process.ppid);
  clearPresence(root, { pid: process.pid }); assert.ok(existsSync(presenceFile(root)), '남의 표식은 지우지 않는다');
  clearPresence(root, { pid: process.ppid }); assert.equal(existsSync(presenceFile(root)), false);
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  writePresence(root, { pid: dead }); assert.equal(serverRunning(root), null, '죽은 pid');
  writeFileSync(presenceFile(root), '{ broken'); assert.equal(serverRunning(root), null, '깨진 파일');
  writePresence(root, { pid: process.pid }); assert.equal(serverRunning(root), null, '내 프로세스는 제외(서버 안에서 부르는 경우)');
});

test('서버 존재 표식은 동기화 대상이 아니다', async () => {
  const { EXCLUDE } = await import('../src/sync.mjs');
  assert.equal(EXCLUDE('.server-presence.json'), true);
  // 크루 셸 방어는 test/forbidden-zone.test.mjs DOT_ITEMS(+드리프트 단언)가 잠근다
});

/* ─── 실제 명령(자식 프로세스) ─── */
const HOME = join(base, 'home'); mkdirSync(HOME, { recursive: true });
const CLIH = join(base, 'cli');
const ROOT = appDataRoot({ env: { HOME }, platform: process.platform, home: HOME });
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 't', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'title' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: body.tools?.length ? '앱 폴더 답' : 'title' } });
    ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }); ev('message_stop', {}); res.end();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => srv.close());
const env = { ...process.env, HOME, USERPROFILE: HOME, LOCALAPPDATA: join(HOME, 'AppData', 'Local'), XDG_DATA_HOME: '', ARGO_CLI_HOME: CLIH, ARGO_CLI_APP: '1', LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8',
  ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off', CLAUDE_CODE_MAX_RETRIES: '0',
  ARGO_NO_OPEN: '1', // 실제 브라우저를 열지 않는다 — login 경로를 타는 모든 실행에(2026-10-01: 시험이 사용자 기본 브라우저에 로그인 창을 띄웠다)
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fake', ARGO_CLAUDE_BASE_URL: `http://127.0.0.1:${srv.address().port}` };
for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'ARGO_TENANT_OWNER', 'ARGO_PREFER_LEADER', 'ARGO_NO_LEADER', 'ARGO_ROOT', 'ARGO_SYNC', 'ARGO_STANDALONE', 'ARGO_PARENT_PID', 'DISPLAY']) delete env[k];
const argo = (args, over = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), ...args], { env: { ...env, ...over } });
  let stdout = ''; let stderr = ''; c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
  const t = setTimeout(() => c.kill(), 90_000); c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});
/** 실제 브라우저가 열릴 수 없는 환경 — PATH에 **기록만 하는 가짜 open·xdg-open 폴더 하나뿐**(진짜 /usr/bin/open은 PATH에 없다), ARGO_NO_OPEN=1.
    가드가 깨져도 사용자 기본 브라우저에는 닿지 않는다(2026-10-01 사고: login 시험이 맥 기본 브라우저에 로그인 창을 실제로 띄웠다). 윈도우의 `cmd /c start`는 ARGO_NO_OPEN에만 기댄다. */
function noRealBrowser(dir, { noOpen = true } = {}) {
  mkdirSync(dir, { recursive: true });
  const mark = join(dir, 'opened.log');
  for (const name of ['open', 'xdg-open']) { writeFileSync(join(dir, name), `#!/bin/sh\necho "$@" >> '${mark}'\n`, { mode: 0o755 }); }
  return { PATH: dir, ...(noOpen ? { ARGO_NO_OPEN: '1' } : { ARGO_NO_OPEN: '' }), ARGO_FAKE_OPEN_LOG: mark };
}
const seedModule = (name) => pathToFileURL(join(REPO, 'src', name)).href;
function seed(body) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], { env: { ...env, ARGO_ROOT: ROOT }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('argo run·/serve·service install은 앱 모드에서 거절한다 — 같은 기기 id로 상주가 둘 뜨면 리스 판정이 양쪽 다 내 것이 된다', async () => {
  for (const args of [['run'], ['service', 'install']]) {
    const r = await argo(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr + r.stdout, /Argo 앱이 이미 이 컴퓨터에서 실행을 맡습니다/);
  }
  assert.deepEqual(existsSync(join(HOME, 'Library', 'LaunchAgents')) ? readdirSync(join(HOME, 'Library', 'LaunchAgents')) : [], [], '서비스 파일을 만들지 않았다');
  const en = await argo(['run'], { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });
  assert.match(en.stderr + en.stdout, /The Argo app already handles background work/);
});

test('앱이 실행 중이면 argo login은 어느 경우든 거절하고 표식 파일 위치를 알려 준다(계정이 섞이지 않게)', async () => {
  writePresence(ROOT, { pid: process.pid }); // 이 테스트 프로세스를 "앱 사이드카"로
  try {
    const r = await argo(['login']);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /Argo 앱이 실행 중입니다/);
    assert.ok((r.stderr + r.stdout).includes(presenceFile(ROOT)), '표식을 지우는 방법(pid 재사용 오판)을 위해 위치를 보여 준다');
    assert.doesNotMatch(r.stdout, /127\.0\.0\.1/, '로그인 서버를 열지 않았다');
  } finally { clearPresence(ROOT, { pid: process.pid }); }
});

test('앱이 꺼져 있어도 앱 폴더에 유효한 세션이 있으면 login은 거절하고 앱 계정을 알려 준다', async () => {
  seed(`
    const { saveDeviceSession } = await import(${JSON.stringify(seedModule('devicesession.mjs'))});
    await saveDeviceSession({ url: 'https://example.invalid', anonKey: 'anon-fake', session: { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-app', email: 'app@example.invalid' } } });`);
  const r = await argo(['login']);
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /앱 계정으로 로그인돼 있습니다: app@example\.invalid/);
  assert.doesNotMatch(r.stdout, /127\.0\.0\.1/);
  const st = await argo(['status']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /계정: app@example\.invalid/);
  assert.ok(st.stdout.includes(ROOT), '데이터 폴더는 앱 폴더');
});

test('앱 모드 대화 — 앱 폴더에 기록되고, 다른 프로세스가 같은 크루 턴을 진행 중이면 시작하지 않고 앱에서 답하는 중이라고 알린다', { timeout: 180_000 }, async () => {
  seed(`
    const { createCompany, paths } = await import(${JSON.stringify(seedModule('workspace.mjs'))});
    const { saveRunnerCred } = await import(${JSON.stringify(seedModule('runners/creds.mjs'))});
    const fs = await import('node:fs/promises');
    await createCompany('app-co', '앱 회사', 'captain', 'u-app', 'ko');
    await fs.writeFile(paths('app-co').agents + '/nova.md', '---\\nname: 노바\\nrole: 확인\\nrunner: claude\\n---\\n확인용.\\n');
    await saveRunnerCred('app-co', 'claude', 'apikey', 'sk-ant-api03-' + 'x'.repeat(80));`);
  const ok = await argo(['chat', 'nova', '앱 폴더로 보낸 지시']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /앱 폴더 답/);
  const f = join(ROOT, 'app-co', 'chats', 'nova.json');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).messages.map((m) => `${m.who}:${m.text}`), ['user:앱 폴더로 보낸 지시', 'crew:앱 폴더 답']);
  assert.ok(!readdirSync(join(ROOT, 'app-co', 'chats')).some((n) => n.endsWith('.lockd')), '잠금 폴더가 남지 않는다');
  // 앱(다른 프로세스)이 같은 크루 턴을 진행 중 — 신선한 상태 파일(pid = 살아 있는 이 테스트 프로세스)
  writeFileSync(join(ROOT, 'app-co', 'chats', 'nova.status.json'), JSON.stringify({ stage: 'work', detail: '', partial: '', startedAt: Date.now(), ts: Date.now(), pid: process.pid }));
  const before = readFileSync(f, 'utf8');
  const busy = await argo(['chat', 'nova', '겹치는 지시']);
  assert.notEqual(busy.status, 0);
  assert.match(busy.stderr + busy.stdout, /앱에서 이 에이전트가 답하는 중입니다/);
  assert.equal(readFileSync(f, 'utf8'), before, '턴을 시작하지 않았다(대화 파일 그대로)');
});

test('argo --version·-v·version — 버전만 출력하고 0으로 끝난다(설정·데이터 파일을 만들지 않는다)', async () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  for (const a of ['--version', '-v', 'version']) { const r = await argo([a]); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), `argo ${pkg.version}`); }
});

// KB 점검(10/6): 한 번 실행(argo chat <에이전트> <지시>)에서 턴이 실패해도 종료 코드가 0이라 스크립트가 실패를 알 수 없었다 — 실패는 1
test('한 번 실행 — 턴이 실패하면 종료 코드 1(성공은 0), 대화에는 실패로 남는다', { timeout: 180_000 }, async () => {
  rmSync(join(ROOT, 'app-co', 'chats', 'nova.status.json'), { force: true }); // 앞 시험이 남긴 '앱에서 답하는 중' 표시
  const bad = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture: bad request' } })); }); });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  try {
    const r = await argo(['chat', 'nova', '실패할 지시'], { ARGO_CLAUDE_BASE_URL: `http://127.0.0.1:${bad.address().port}` });
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    const last = JSON.parse(readFileSync(join(ROOT, 'app-co', 'chats', 'nova.json'), 'utf8')).messages.at(-1);
    assert.equal(last.text, '실패할 지시'); assert.ok(last.failed && !last.awaiting);
  } finally { bad.close(); }
});

test('앱 모드에서 회사가 없으면 40초를 기다리거나 새 회사를 권하지 않고 앱을 먼저 열라고 안내한다 — 계정 세션이 있고 앱이 아직 회사를 받지 못한 경우(검토 L-h)', async () => {
  const home = join(base, 'home-nocompany'); mkdirSync(home, { recursive: true });
  const root = appDataRoot({ env: { HOME: home }, platform: process.platform, home });
  const r0 = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveDeviceSession } = await import(${JSON.stringify(seedModule('devicesession.mjs'))});
    await saveDeviceSession({ url: 'https://example.invalid', anonKey: 'anon-fake', session: { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-new', email: 'new@example.invalid' } } });`], { env: { ...env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), ARGO_ROOT: root }, encoding: 'utf8' });
  assert.equal(r0.status, 0, r0.stderr);
  const t0 = Date.now();
  const r = await argo(['chat', 'nova', 'x'], { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local') });
  assert.ok(Date.now() - t0 < 20_000, '40초 대기 없음');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /앱을 열어 회사를 받아 온 뒤 다시 실행하세요/);
});

test('앱이 꺼진 상태에서 세션 없는 앱 폴더에 argo login — 저장하고 게스트 회사를 그 계정으로 귀속한다(앱의 로그인 경로와 같은 이어짐, 검토 M-c)', { timeout: 120_000 }, async () => {
  const { startFakeSupabase } = await import('./helpers/fake-supabase-http.mjs');
  const fake = await startFakeSupabase({ userId: 'u-login' });
  const home = join(base, 'home-login'); mkdirSync(home, { recursive: true });
  const root = appDataRoot({ env: { HOME: home }, platform: process.platform, home });
  const over = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fake', ARGO_LOGIN_PORT: '0', ...noRealBrowser(join(base, 'fakebin-login')) };
  const r0 = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { createCompany } = await import(${JSON.stringify(seedModule('workspace.mjs'))});
    const { enableGuestMode } = await import(${JSON.stringify(seedModule('gueststate.mjs'))});
    await createCompany('guest-co', '게스트 회사', 'captain', null, 'ko'); await enableGuestMode();`], { env: { ...env, ...over, ARGO_ROOT: root }, encoding: 'utf8' });
  assert.equal(r0.status, 0, r0.stderr);
  const child = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'login'], { env: { ...env, ...over } });
  let out = ''; let err = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((res) => child.on('close', res));
  try {
    let url; for (let i = 0; i < 100 && !url; i++) { url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]+/)?.[0]; if (!url) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(url, `로그인 주소가 나와야 한다\n${out}${err}`);
    const get = (u) => new Promise((resolve, reject) => http.get(u, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }).on('error', reject));
    const html = await get(url);
    const nonce = decodeURIComponent(html.match(/redirect_to=([^"&]+)/)[1]).match(/cli=([0-9a-f]+)/)[1];
    const u = new URL(url);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: u.port, path: '/bind', method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify({ cli: nonce, access_token: 'tok', refresh_token: 'rt-login' }));
    });
    assert.equal(status, 200);
    assert.equal(await exited, 0, `${out}${err}`);
  } finally { child.kill(); await fake.close(); }
  assert.match(out, /로그인했습니다/);
  assert.equal(JSON.parse(readFileSync(join(root, 'guest-co', 'company.json'), 'utf8')).ownerId, 'u-login', '주인 없던 회사가 로그인 계정으로 귀속돼야 목록에서 빠지지 않는다');
  assert.equal(existsSync(join(root, '.guest-mode.json')), false, '게스트 표시를 걷는다');
  assert.equal(JSON.parse(readFileSync(join(root, '.device-session.json'), 'utf8')).user.id, 'u-login', '세션은 앱 폴더에 저장');
});

for (const [sig, code] of [['SIGHUP', 129], ['SIGINT', 130]]) {
test(`터미널이 닫혀도(${sig}) 진행 중이던 턴이 "답 대기"로 남지 않는다 — 중단 기록으로 마무리하고 끝낸다(검토 L-a: 앱은 실행 중에 이런 고아 턴을 정리하지 않는다)`, { timeout: 120_000, skip: process.platform === 'win32' && '윈도우는 POSIX 신호를 전달할 수 없다' }, async () => {
  // 모델 응답이 오지 않는 서버 — 턴이 진행 중인 채로 신호를 보낸다
  const hang = http.createServer((req) => { req.on('data', () => {}); req.on('end', () => { /* 응답하지 않는다 */ }); });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const home = join(base, `home-hup-${sig}`); mkdirSync(home, { recursive: true });
  const root = appDataRoot({ env: { HOME: home }, platform: process.platform, home });
  const over = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), ARGO_CLAUDE_BASE_URL: `http://127.0.0.1:${hang.address().port}` };
  const r0 = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { createCompany, paths } = await import(${JSON.stringify(seedModule('workspace.mjs'))});
    const { saveRunnerCred } = await import(${JSON.stringify(seedModule('runners/creds.mjs'))});
    const { enableGuestMode } = await import(${JSON.stringify(seedModule('gueststate.mjs'))});
    const fs = await import('node:fs/promises');
    await createCompany('hup-co', 'HUP 회사', 'captain', null, 'ko'); await enableGuestMode();
    await fs.writeFile(paths('hup-co').agents + '/nova.md', '---\\nname: 노바\\nrole: 확인\\nrunner: claude\\n---\\n확인용.\\n');
    await saveRunnerCred('hup-co', 'claude', 'apikey', 'sk-ant-api03-' + 'x'.repeat(80));`], { env: { ...env, ...over, ARGO_ROOT: root, ARGO_CLI_HOME: join(base, `cli-hup-${sig}`) }, encoding: 'utf8' });
  assert.equal(r0.status, 0, r0.stderr);
  const cliHome = join(base, `cli-hup-${sig}`); mkdirSync(cliHome, { recursive: true }); writeFileSync(join(cliHome, 'cli.json'), JSON.stringify({ mode: 'local' }));
  const f = join(root, 'hup-co', 'chats', 'nova.json');
  const child = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'chat', 'nova', '끝나지 않는 지시'], { env: { ...env, ...over, ARGO_CLI_HOME: cliHome } });
  let err = ''; child.stderr.on('data', (d) => (err += d));
  const closed = new Promise((res) => child.on('close', (code, sig) => res({ code, sig })));
  try {
    for (let i = 0; i < 200 && !(existsSync(f) && JSON.parse(readFileSync(f, 'utf8')).messages?.some((m) => m.awaiting)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(JSON.parse(readFileSync(f, 'utf8')).messages.some((m) => m.awaiting), `턴이 시작돼 대기 표시가 있어야 한다\n${err}`);
    child.kill(sig);
    const end = await Promise.race([closed, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
    assert.notEqual(end, 'timeout', '신호를 받으면 곧 끝난다');
    assert.equal(end.code, code, `${sig} 종료 코드 — ${JSON.stringify(end)}\n${err}`);
    const msgs = JSON.parse(readFileSync(f, 'utf8')).messages;
    assert.ok(msgs.every((m) => !m.awaiting), '답 대기 표시가 남으면 앱 화면에 앱을 재시작할 때까지 "답 대기"가 남는다');
    assert.ok(msgs.some((m) => m.who === 'user' && (m.aborted || m.failed)), '중단 기록으로 마무리');
  } finally { child.kill('SIGKILL'); hang.close(); }
});
}

// ARGO_NO_OPEN=1이면 argo login이 브라우저를 열지 않는다 — 가짜 open이 불린 기록으로 본다(진짜 브라우저는 PATH에 없다). 없으면 종전대로 연다(대조군).
for (const noOpen of [true, false]) {
  test(`argo login — ARGO_NO_OPEN=${noOpen ? '1이면 브라우저를 열지 않는다' : '없으면 종전대로 연다(가짜 open이 불린다 — 대조군)'}`, { skip: process.platform === 'win32' && '윈도우는 cmd start라 가짜 open으로 볼 수 없다' }, async () => {
    const home = join(base, `home-open-${noOpen}`); mkdirSync(home, { recursive: true });
    const fakeEnv = noRealBrowser(join(base, `fakebin-open-${noOpen}`), { noOpen });
    const child = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'login'], { env: { ...env, HOME: home, USERPROFILE: home, ARGO_LOGIN_PORT: '0', ...fakeEnv, DISPLAY: ':0' } });
    let out = ''; child.stdout.on('data', (d) => (out += d));
    try {
      for (let i = 0; i < 100 && !/\?k=[0-9a-f]+/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(out, /http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]+/, '로그인 주소는 화면에 나온다');
      await new Promise((r) => setTimeout(r, 1500)); // openUrl은 주소 출력 직후 부른다
      const opened = existsSync(fakeEnv.ARGO_FAKE_OPEN_LOG) ? readFileSync(fakeEnv.ARGO_FAKE_OPEN_LOG, 'utf8') : '';
      if (noOpen) assert.equal(opened, '', '실제 브라우저 창이 뜨면 시험이 사용자 화면을 방해한다');
      else assert.match(opened, /127\.0\.0\.1/, '대조군: 변수가 없으면 열린다');
    } finally { child.kill('SIGKILL'); }
  });
}

/* ─── 독립 검수 #800 MEDIUM-2·LOW-1·LOW-3 ─── */
const guestSeed = (home, root, cliHome, mode = 'local') => {
  mkdirSync(cliHome, { recursive: true }); if (mode) writeFileSync(join(cliHome, 'cli.json'), JSON.stringify({ mode }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { createCompany, paths } = await import(${JSON.stringify(seedModule('workspace.mjs'))});
    const { saveRunnerCred } = await import(${JSON.stringify(seedModule('runners/creds.mjs'))});
    const { enableGuestMode } = await import(${JSON.stringify(seedModule('gueststate.mjs'))});
    const fs = await import('node:fs/promises');
    await createCompany('g-co', '게스트 회사', 'captain', null, 'ko'); await enableGuestMode();
    await fs.writeFile(paths('g-co').agents + '/nova.md', '---\\nname: 노바\\nrole: 확인\\nrunner: claude\\n---\\n확인용.\\n');
    await saveRunnerCred('g-co', 'claude', 'apikey', 'sk-ant-api03-' + 'x'.repeat(80));`], { env: { ...env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), ARGO_ROOT: root, ARGO_CLI_HOME: cliHome }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

test('앱이 실행 중이라 login을 거절당한 게스트 사용자는 CLI를 계속 쓸 수 있다 — 거절 전에 모드가 계정으로 저장되면 status·chat·login 모두 막혀 빠져나갈 길이 없다(MEDIUM-2)', { timeout: 180_000 }, async () => {
  const home = join(base, 'home-m2'); mkdirSync(home, { recursive: true });
  const cliHome = join(base, 'cli-m2');
  const root = appDataRoot({ env: { HOME: home }, platform: process.platform, home });
  guestSeed(home, root, cliHome);
  const over = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), ARGO_CLI_HOME: cliHome };
  writePresence(root, { pid: process.pid }); // 앱 실행 중
  try {
    const login = await argo(['login'], over);
    assert.equal(login.status, 1); assert.match(login.stderr + login.stdout, /Argo 앱이 실행 중입니다/);
    assert.equal(JSON.parse(readFileSync(join(cliHome, 'cli.json'), 'utf8')).mode, 'local', '거절됐으니 모드는 그대로(로그인에 성공했을 때만 계정으로 저장)');
    const st = await argo(['status'], over);
    assert.match(st.stdout, /이 컴퓨터에서만\(로그인 없음\)/, `status가 여전히 로컬 — ${st.stdout}${st.stderr}`);
    assert.doesNotMatch(st.stdout, /로그인 안 됨/);
    const chat = await argo(['chat', 'nova', '게스트로 계속'], over);
    assert.equal(chat.status, 0, chat.stderr); assert.match(chat.stdout, /앱 폴더 답/);
    assert.equal((await argo(['login'], over)).status, 1, '다시 login해도 같은 거절(상태가 망가지지 않았다)');
  } finally { clearPresence(root, { pid: process.pid }); }
});

const PTY = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
// 진짜 터미널 운전기(test/cli-repl.test.mjs와 같은 방식, 인자를 JSON으로 받는다) — 결과는 JSON 한 줄
const PTY_DRIVER = `
import pty, os, sys, time, select, json, re
cfg = json.loads(sys.argv[1]); pid, fd = pty.fork()
if pid == 0: os.execvp(cfg['argv'][0], cfg['argv'])
def rd(t, until=None):
    out=b''; end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: out+=os.read(fd,65536)
            except OSError: break
        if until and until in re.sub(r'\\x1b\\[[0-9;]*[A-Za-z]', '', out.decode(errors='replace')).replace('\\r', ''): break
    return out.decode(errors='replace')
res=[{'label':'boot','out':rd(cfg.get('bootWait',40), cfg.get('bootUntil'))}]
for s in cfg['steps']:
    try: os.write(fd, s['keys'].encode())
    except OSError: res.append({'label':s['label'],'out':'<<process gone>>'}); continue
    res.append({'label':s['label'],'out':rd(s.get('wait',1.5), s.get('until'))})
alive = True; end = time.time() + cfg.get('settle', 10)  # 끝날 때까지 기다린다(부하가 큰 전체 시험에서도 흔들리지 않게) — 시간이 다 되도록 안 끝나면 살아 있는 것
tail = b''
while time.time() < end:
    if os.waitpid(pid, os.WNOHANG)[0] != 0: alive = False; break
    r,_,_ = select.select([fd],[],[],0.1)  # 끝나는 동안에도 출력을 비운다 — 안 읽으면 맥 pty는 슬레이브가 닫히길 기다리며 종료가 멈춘다
    if r:
        try: tail += os.read(fd, 65536)
        except OSError: pass
res[-1]['out'] += tail.decode(errors='replace')
if alive: os.kill(pid, 9); os.waitpid(pid, 0)
print(json.dumps({'res':res,'alive':alive}))
`;
const runPty = (cfg, envOver) => new Promise((resolve) => {
  const c = spawn('python3', ['-c', PTY_DRIVER, JSON.stringify({ argv: [process.execPath, join(REPO, 'bin', 'argo.mjs'), ...(cfg.args ?? [])], ...cfg })], { env: { ...env, ...envOver } });
  let o = ''; let e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
  c.on('close', () => { try { resolve(JSON.parse(o.trim().split('\n').pop())); } catch { resolve({ res: [], alive: null, err: e.slice(-600) + o.slice(-300) }); } });
});
const ptyOut = (r) => r.res.map((x) => x.out).join('\n').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

test('대화형 첫 실행에서 "계정"을 골랐다가 앱 실행 중이라 거절당해도 모드가 저장되지 않아 다음 실행에서 다시 고를 수 있다(MEDIUM-2)', { skip: !PTY && 'python3 pty 필요(맥·리눅스)', timeout: 180_000 }, async () => {
  const home = join(base, 'home-m2i'); mkdirSync(home, { recursive: true });
  const cliHome = join(base, 'cli-m2i');
  const root = appDataRoot({ env: { HOME: home }, platform: process.platform, home });
  guestSeed(home, root, cliHome, null); // cli.json 없음 = 처음 실행
  const over = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), ARGO_CLI_HOME: cliHome };
  writePresence(root, { pid: process.pid });
  try {
    const first = await runPty({ bootUntil: '번호: ', steps: [{ label: 'account', keys: '1\r', wait: 20, until: '앱에서 로그인하세요' }] }, over);
    assert.match(ptyOut(first), /Argo 앱이 실행 중입니다/, first.err ?? ptyOut(first));
    assert.equal(first.alive, false, '거절하고 끝난다');
    const saved = existsSync(join(cliHome, 'cli.json')) ? JSON.parse(readFileSync(join(cliHome, 'cli.json'), 'utf8')).mode : null;
    assert.notEqual(saved, 'account', '로그인에 성공하지 못했으니 계정 모드로 저장하면 안 된다');
    const second = await runPty({ bootUntil: '번호: ', steps: [{ label: 'local', keys: '2\r', wait: 60, until: '대화 상대' }, { label: 'bye', keys: 'exit\r', wait: 5 }] }, over);
    assert.match(ptyOut(second), /Argo를 어떻게 쓸까요\?/, '다음 실행에서 다시 묻는다');
    assert.match(ptyOut(second), /대화 상대: 노바/, '이 컴퓨터에서만을 골라 게스트로 계속 쓴다');
  } finally { clearPresence(root, { pid: process.pid }); }
});

test('한 번 실행 argo chat 중 Ctrl+C(진짜 터미널)도 진행 중이던 턴을 중단 기록으로 마무리하고 130으로 끝난다 — "답 대기"가 남지 않는다(LOW-1)', { skip: !PTY && 'python3 pty 필요(맥·리눅스)', timeout: 180_000 }, async () => {
  const hang = http.createServer((req) => { req.on('data', () => {}); req.on('end', () => {}); });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const home = join(base, 'home-c1'); mkdirSync(home, { recursive: true });
  const cliHome = join(base, 'cli-c1');
  const root = appDataRoot({ env: { HOME: home }, platform: process.platform, home });
  guestSeed(home, root, cliHome);
  const over = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), ARGO_CLI_HOME: cliHome, ARGO_CLAUDE_BASE_URL: `http://127.0.0.1:${hang.address().port}` };
  try {
    const r = await runPty({ args: ['chat', 'nova', '끝나지 않는 지시'], bootUntil: '작업 중', bootWait: 60, steps: [{ label: 'ctrlc', keys: '\x03', wait: 20 }], settle: 20 }, over);
    assert.equal(r.alive, false, `Ctrl+C로 끝난다\n${r.err ?? ptyOut(r)}`);
    const msgs = JSON.parse(readFileSync(join(root, 'g-co', 'chats', 'nova.json'), 'utf8')).messages;
    assert.ok(msgs.some((m) => m.who === 'user'), '턴이 시작됐다');
    assert.ok(msgs.every((m) => !m.awaiting), '"답 대기"가 남으면 앱 화면에 앱을 재시작할 때까지 남는다');
    assert.ok(msgs.some((m) => m.aborted || m.failed), '중단 기록');
  } finally { hang.close(); }
});

test('앱이 꺼진 상태에서 시작한 로그인을 기다리는 동안 앱이 켜지면 저장 직전에 다시 확인해 거절한다 — 앱 폴더에 세션을 쓰지 않는다(LOW-3)', { timeout: 120_000 }, async () => {
  const { startFakeSupabase } = await import('./helpers/fake-supabase-http.mjs');
  const fake = await startFakeSupabase({ userId: 'u-late' });
  const home = join(base, 'home-l3'); mkdirSync(home, { recursive: true });
  const root = appDataRoot({ env: { HOME: home }, platform: process.platform, home });
  const over = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fake', ARGO_LOGIN_PORT: '0', ARGO_CLI_HOME: join(base, 'cli-l3'), ...noRealBrowser(join(base, 'fakebin-l3')) };
  const child = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'login'], { env: { ...env, ...over } });
  let out = ''; let err = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((res) => child.on('close', res));
  try {
    let url; for (let i = 0; i < 100 && !url; i++) { url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]+/)?.[0]; if (!url) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(url, `로그인 주소\n${out}${err}`);
    const get = (u) => new Promise((resolve, reject) => http.get(u, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }).on('error', reject));
    const nonce = decodeURIComponent((await get(url)).match(/redirect_to=([^"&]+)/)[1]).match(/cli=([0-9a-f]+)/)[1];
    writePresence(root, { pid: process.pid }); // 기다리는 사이 앱이 켜졌다
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: new URL(url).port, path: '/bind', method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0)); req.end(JSON.stringify({ cli: nonce, access_token: 'tok', refresh_token: 'rt-late' })); // 거절하고 끝나면 연결이 끊긴다 — 0으로 본다
    });
    assert.notEqual(status, 200, '앱이 켜진 뒤에는 저장하지 않는다');
    assert.equal(await exited, 1, `거절하고 끝난다\n${out}${err}`);
    assert.match(out + err, /Argo 앱이 실행 중입니다/);
    assert.equal(existsSync(join(root, '.device-session.json')), false, '앱 폴더에 세션이 쓰이면 앱의 동기화 루프가 시작되지 않는다(M-c)');
  } finally { child.kill('SIGKILL'); await fake.close(); clearPresence(root, { pid: process.pid }); }
});
