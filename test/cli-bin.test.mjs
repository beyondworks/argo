// argo CLI 입구 — 실제 명령을 자식 프로세스로 실행해 잠근다(격리 ARGO_CLI_HOME·ARGO_ROOT, 가짜 기기 세션, 가짜 모델 엔드포인트).
// 요점: ① 설정은 공개 Supabase 값만 읽는다(서비스 키가 새지 않는다) ② CLI 대화가 앱 채팅과 같은 순서로 스레드에 기록돼 앱에서도 보인다
// ③ 대화형·한 번 실행은 실행 담당(리스)을 맡지 않는다 ④ 화면 없는 리눅스는 크루 브라우저를 헤드리스로.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { applyCliEnv, publicSupabaseFromDotenv, cliLang } from '../src/cli/env.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const base = await mkdtemp(join(tmpdir(), 'argo-cli-bin-'));
const HOME = join(base, 'home'); const ROOT = join(base, 'root'); const CLIH = join(base, 'cli');
await mkdir(HOME, { recursive: true });

test('설정: .env에서 공개 Supabase 값 두 개만 꺼낸다 — 서비스 키 줄은 읽지 않는다', async () => {
  const f = join(base, '.env.test');
  await writeFile(f, 'SUPABASE_SERVICE_ROLE_KEY=never-read\nNEXT_PUBLIC_SUPABASE_URL=https://sb.example\nNEXT_PUBLIC_SUPABASE_ANON_KEY="anon"\n');
  assert.deepEqual(publicSupabaseFromDotenv(f), { url: 'https://sb.example', anonKey: 'anon' });
const env = { ARGO_CLI_HOME: join(base, 'cfg-x') };
  applyCliEnv({ repoRoot: join(base, 'no-repo'), env, platform: 'linux' });
  // 같은 맥의 상주·앱(~/.argo/workspaces)과 기기 세션 파일을 같이 쓰면 refresh 토큰 이중 회전 → 세션 가족 폐기(#429 계열). 폴더를 나눈다.
  assert.equal(env.ARGO_ROOT, join(base, 'cfg-x', 'cli-workspaces'), '데이터 기본 위치 ~/.argo/cli-workspaces');
  assert.notEqual(env.ARGO_ROOT, join(base, 'cfg-x', 'workspaces'), '상주·앱의 데이터 폴더와 겹치지 않는다');
  assert.equal(env.ARGO_BROWSER_HEADLESS, '1', '화면 없는 리눅스 — 크루 브라우저 헤드리스');
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  const mac = { ARGO_CLI_HOME: join(base, 'cfg-y') }; applyCliEnv({ repoRoot: base, env: mac, platform: 'darwin' });
  assert.equal(mac.ARGO_BROWSER_HEADLESS, undefined, '맥은 화면이 있다');
});

test('언어 — cli.json > LC_ALL > LANG > macOS 언어 설정 순, 비어 있으면 macOS 한국어 사용자에게 영어가 나오지 않는다', () => {
  const ko = () => 'ko_KR'; const en = () => 'en_US';
  assert.equal(cliLang({}, {}, { platform: 'darwin', appleLocale: ko }), 'ko', 'LANG이 빈 맥 터미널(실측) — macOS 언어를 따른다');
  assert.equal(cliLang({}, {}, { platform: 'darwin', appleLocale: en }), 'en');
  assert.equal(cliLang({}, { LANG: 'en_US.UTF-8' }, { platform: 'darwin', appleLocale: ko }), 'en', 'LANG이 있으면 그것이 먼저');
  assert.equal(cliLang({}, { LC_ALL: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }, { platform: 'linux' }), 'ko', 'LC_ALL이 LANG보다 먼저');
  assert.equal(cliLang({ lang: 'en' }, { LANG: 'ko_KR.UTF-8' }, { platform: 'darwin', appleLocale: ko }), 'en', 'cli.json 선택이 가장 먼저');
  assert.equal(cliLang({}, {}, { platform: 'linux', appleLocale: ko }), 'en', '맥이 아니면 macOS 설정을 보지 않는다');
});

// 가짜 Messages 엔드포인트 — 크루 턴이 실제 SDK로 끝까지 돈다(chat-steer-sdk.test.mjs와 같은 방식)
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 't', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'title' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })); } // 스트리밍 아닌 요청(제목 생성)은 JSON으로
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: body.tools?.length ? 'CLI 답' : 'title' } });
    ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }); ev('message_stop', {}); res.end();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => srv.close());

// LC_ALL도 고정 — CI 러너는 LC_ALL=en_US가 설정돼 있고 cliLang은 LC_ALL을 LANG보다 먼저 본다(CI 실측)
const env = { ...process.env, HOME, USERPROFILE: HOME, ARGO_CLI_HOME: CLIH, ARGO_ROOT: ROOT, LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off', CLAUDE_CODE_MAX_RETRIES: '0',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fake', ARGO_CLAUDE_BASE_URL: `http://127.0.0.1:${srv.address().port}` };
for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'ARGO_TENANT_OWNER', 'ARGO_PREFER_LEADER', 'ARGO_NO_LEADER']) delete env[k];
// 비동기 실행 필수 — spawnSync는 이 프로세스의 이벤트 루프를 막아 같은 프로세스의 가짜 모델 서버가 응답하지 못한다(교착)
const argo = (...args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [join(REPO, 'bin', 'argo.mjs'), ...args], { env });
  let stdout = ''; let stderr = ''; c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
  const t = setTimeout(() => c.kill(), 120_000); c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});

test('argo status·chat — 로그인 없으면 안내하고, 로그인 뒤엔 크루 답이 앱과 같은 스레드에 기록된다', { timeout: 180_000 }, async () => {
  const st0 = await argo('chat', 'nova', '안녕');
  assert.notEqual(st0.status, 0);
  assert.match(st0.stderr, /argo login/, '기기 세션이 없으면 로그인 안내');
  // 가짜 기기 세션·회사·크루 — 앱이 쓰는 같은 함수로 시드(자식 프로세스와 같은 ARGO_ROOT)
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveDeviceSession } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/devicesession.mjs')).href)});
    const { createCompany, paths } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/workspace.mjs')).href)});
    const { saveRunnerCred } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/runners/creds.mjs')).href)});
    const fs = await import('node:fs/promises');
    await saveDeviceSession({ url: 'https://example.invalid', anonKey: 'anon-fake', session: { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-cli', email: 'cli@example.invalid' } } });
    await createCompany('cli-co', 'CLI 회사', 'captain', 'u-cli', 'ko');
    await fs.writeFile(paths('cli-co').agents + '/nova.md', '---\\nname: 노바\\nrole: 확인\\nrunner: claude\\n---\\n확인용.\\n');
    await saveRunnerCred('cli-co', 'claude', 'apikey', 'sk-ant-api03-' + 'x'.repeat(80));`], { env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const st = await argo('status');
  assert.match(st.stdout, /계정: cli@example\.invalid/);
  assert.match(st.stdout, /회사: CLI 회사 \(cli-co\)/);
  const r = await argo('chat', 'nova', 'CLI에서 보낸 지시');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CLI 답/);
  const t = JSON.parse(await readFile(join(ROOT, 'cli-co', 'chats', 'nova.json'), 'utf8'));
  assert.deepEqual(t.messages.map((m) => `${m.who}:${m.text}`), ['user:CLI에서 보낸 지시', 'crew:CLI 답']);
  assert.ok(t.messages.every((m) => !m.awaiting), '대기 표시가 남지 않는다');
});

test('상주(argo run)는 앱 서버와 같은 기동 순서를 쓴다 — 담당 우선, 대화형·한 번 실행은 담당을 맡지 않는다', async () => {
  const src = await readFile(join(REPO, 'bin', 'argo.mjs'), 'utf8');
  const run = src.slice(src.indexOf('async function runResident('), src.indexOf('/* ─── 서비스 등록'));
  assert.match(run, /process\.env\.ARGO_PREFER_LEADER = '1'/);
  assert.match(run, /await import\('\.\.\/instrumentation-node\.mjs'\)/, '기동 순서를 복제하지 않고 그대로 불러온다');
  const inter = src.slice(src.indexOf('async function interactive('), src.indexOf('try {\n  if (cmd'));
  assert.match(inter, /process\.env\.ARGO_NO_LEADER = '1'/);
  assert.match(src, /else if \(cmd === 'chat'\) \{\n\s*process\.env\.ARGO_NO_LEADER = '1';/);
});
