// 본체 전수 검수(2026-09-22) — 러너 연결·오류 분류 결함 K05·K07·K08·K06·K09·K02·K17 행동 잠금.
//  K05 로그인 버튼: 관리본(~/.argo/tools)만 있는 기기에서 spawn('codex')가 ENOENT로 죽고 폴링은 영원히 미인증
//  K07 연결 경로가 10분 감지 캐시를 force 없이 사용 → 설치 직후 not-installed
//  K08 agy 감지가 Windows %LOCALAPPDATA%\agy\bin\agy.exe를 안 봄(실행 경로 agyCmd는 봄)
//  K06 setup-token 완료를 'exit'로 판정 → stdio가 다 비기 전 exit가 오면 토큰을 버리고 실패 표시
//  K09 CLI_MISSING_RE가 원문 전체의 ENOENT/command not found를 한도·인증보다 먼저 봄 → 오분류
//  K02 벤더 원문 "You've hit your session limit"(사용자 피드백 2026-09-10)이 한도로 분류되지 않음
//  K17 apiError가 stdout(크루 출력)의 첫 "message"를 원인으로 채택 + 이스케이프 따옴표에서 잘림
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

// 실제 CLI(사용자 PATH의 codex·agy)를 절대 잡지 않게 — 홈·셸·PATH를 임포트 전에 격리한다.
const HOME = await mkdtemp(join(tmpdir(), 'argo-k05-home-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.SHELL = '/usr/bin/true'; // ensureCliPath의 로그인 셸 PATH 캡처 무력화(실사용자 PATH 유입 차단)
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-k05-root-'));
process.env.ARGO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'argo-k05-cache-'));
delete process.env.ARGO_CODEX_PREFER_PATH;

const { detectRunners, startRunnerLogin, runnerLoginStatus, apiError, startClaudeSetupToken, setupTokenStatus } = await import('../src/runners/exec.mjs');
const { classifyRunnerError } = await import('../src/runners/error-class.mjs');
const { loadRunnerCred } = await import('../src/runners/creds.mjs');
const { paths } = await import('../src/workspace.mjs');

const SAFE_PATH = '/usr/bin:/bin';
process.env.PATH = SAFE_PATH; // 임포트가 앞에 꽂은 노드 디렉터리(~/.local/bin — 실제 agy가 있다)까지 걷어낸다

const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};

const MANAGED_DIR = join(HOME, '.argo', 'tools', 'codex-cli');
const MANAGED_BIN = join(MANAGED_DIR, 'codex');

test('K07·K05 로그인 — 캐시가 미설치로 데워진 뒤 관리본만 생겨도 로그인 CLI가 관리본으로 실행되고, 폴링도 관리본으로 로그인을 확인한다', { skip: process.platform === 'win32' }, async () => {
  assert.equal((await detectRunners()).codex.installed, false, '전제: 감지 캐시가 미설치로 데워짐');
  const marker = join(HOME, 'codex-login-args.txt');
  await mkdir(MANAGED_DIR, { recursive: true });
  await writeFile(MANAGED_BIN, `#!/bin/sh
if [ "$1 $2" = "login status" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
echo "$@" > '${marker}'
`);
  await chmod(MANAGED_BIN, 0o755);
  assert.deepEqual(await startRunnerLogin('codex'), { ok: true }, '설치 직후 연결 버튼이 not-installed(10분 캐시)거나 실패하면 안 된다');
  const args = await waitFor(() => readFile(marker, 'utf8').catch(() => ''));
  assert.equal(args.trim(), 'login', '관리본이 login 인자로 실행돼야 한다');
  assert.deepEqual(await runnerLoginStatus('codex'), { supported: true, authed: true }, '폴링이 PATH 이름(codex)만 보면 영원히 미인증');
});

test('K05 로그인 — 실행 파일을 띄우지 못하면(EACCES) 미처리 error 이벤트 대신 spawn-failed를 돌려준다', { skip: process.platform === 'win32' }, async () => {
  await mkdir(MANAGED_DIR, { recursive: true });
  await writeFile(MANAGED_BIN, '#!/bin/sh\nexit 0\n');
  await chmod(MANAGED_BIN, 0o644); // 실행 권한 없음 → spawn 'error'(EACCES)
  const r = await startRunnerLogin('codex');
  assert.equal(r.ok, false, '띄우지 못했는데 ok:true(브라우저가 열렸다고 안내)면 안 된다');
  assert.equal(r.reason, 'spawn-failed');
  await new Promise((res) => setTimeout(res, 200)); // 늦은 error 이벤트가 프로세스를 죽이지 않는지
});

test('K08 agy 감지 — Windows 공식 설치 경로(%LOCALAPPDATA%\\agy\\bin\\agy.exe)만 있어도 설치로 본다(실행 경로 agyCmd와 같은 판정)', async () => {
  const la = await mkdtemp(join(tmpdir(), 'argo-k08-la-'));
  await mkdir(join(la, 'agy', 'bin'), { recursive: true });
  await writeFile(join(la, 'agy', 'bin', 'agy.exe'), '');
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  const prevLa = process.env.LOCALAPPDATA;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.LOCALAPPDATA = la;
  try {
    const d = await detectRunners(true);
    assert.equal(d.antigravity.installed, true, 'agyCmd는 실행 가능한데 감지는 미설치 — 연결 화면이 설치 안내만 띄운다');
  } finally {
    Object.defineProperty(process, 'platform', desc);
    if (prevLa === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLa;
  }
});

test('K06 setup-token — 프로세스 exit가 출력보다 먼저 와도(손자가 파이프를 쥔 채 늦게 씀) 토큰을 받아 저장한다', { skip: process.platform === 'win32' }, async () => {
  const TOKEN = `sk-ant-oat01-${'A'.repeat(40)}`;
  const bin = await mkdtemp(join(tmpdir(), 'argo-k06-bin-'));
  // 가짜 script(1): 즉시 exit하지만, 파이프를 물려받은 백그라운드 자식이 0.3초 뒤 토큰을 쓴다.
  await writeFile(join(bin, 'script'), `#!/bin/sh\n( sleep 0.3; printf '%s\\n' '${TOKEN}' ) &\nexit 0\n`);
  await chmod(join(bin, 'script'), 0o755);
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = { ARGO_STANDALONE: process.env.ARGO_STANDALONE, CLAUDE_CLI: process.env.CLAUDE_CLI, ARGO_CLAUDE_BASE_URL: process.env.ARGO_CLAUDE_BASE_URL };
  process.env.ARGO_STANDALONE = '1';
  delete process.env.ARGO_TENANT_OWNER;
  process.env.CLAUDE_CLI = '/nonexistent/claude';
  process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.PATH = `${bin}:${SAFE_PATH}`;
  const ws = 'k06co';
  await mkdir(paths(ws).root, { recursive: true });
  try {
    assert.deepEqual(await startClaudeSetupToken(ws), { ok: true });
    const st = await waitFor(() => { const s = setupTokenStatus(ws); return s.status !== 'running' && s; });
    assert.equal(st.status, 'saved', `exit가 먼저 와 토큰이 버려졌다: ${st.error}`);
    assert.equal((await loadRunnerCred(ws, 'claude'))?.value, TOKEN);
  } finally {
    process.env.PATH = SAFE_PATH;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    srv.close();
  }
});

test('K09 분류 — 인증 만료·한도 실패의 꼬리에 셸 "command not found"/ENOENT가 섞여도 CLI 미발견으로 덮지 않는다', () => {
  const tail = '\n/bin/sh: pandoc: command not found\nError: ENOENT: no such file or directory, open \'/tmp/x\'';
  assert.equal(classifyRunnerError(`API Error: 401 {"type":"authentication_error"}${tail}`).code, 'auth_expired');
  assert.equal(classifyRunnerError(`You've hit your weekly limit · resets Aug 6${tail}`).code, 'quota');
  // 진짜 CLI 미발견은 apiError가 만든 확정 문구로 온다 — 그 연결은 유지된다.
  const spawnFail = apiError(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' }), 'codex').message;
  assert.equal(classifyRunnerError(spawnFail).code, 'cli_missing');
});

test('K02 분류 — 벤더 원문 "You\'ve hit your session limit"(피드백 2026-09-10)은 한도다', () => {
  assert.deepEqual(classifyRunnerError("Claude: You've hit your session limit · resets 2:20pm (Asia/Seoul)"), { code: 'quota', origin: 'vendor' });
});

test('K17 apiError — 원인은 stderr 우선(stdout 크루 출력의 JSON이 덮지 않음), 이스케이프 따옴표에서 잘리지 않는다', () => {
  const crew = apiError({ code: 1, stdout: '{"message":"hello from crew script"}\n', stderr: '{"error":{"message":"invalid api key"}}' }, 'codex').message;
  assert.match(crew, /invalid api key/);
  assert.doesNotMatch(crew, /hello from crew/);
  const esc = apiError({ code: 1, stdout: '', stderr: '{"error":{"message":"Model \\"gpt-x\\" is not available"}}' }, 'codex').message;
  assert.equal(esc, 'Model "gpt-x" is not available');
  // stderr에 원인이 없으면 종전대로 stdout의 벤더 JSON을 쓴다(회귀 방지).
  assert.equal(apiError({ code: 1, stdout: '{"message":"quota exceeded"}', stderr: 'boom' }, 'gemini').message, 'quota exceeded');
});
