// argo 대화 화면 — 진짜 터미널(가상 pty)에서 사람이 치는 순서대로 행동을 잠근다(유건 결정 2026-09-30).
// ① `argo`만 치면 심볼·버전 머리 뒤 바로 대화 ② Ctrl+C·Ctrl+D로는 나가지 않는다(빈 줄이면 나가는 법 안내, 입력 중이면 줄만 지움)
// ③ 답하는 중 Ctrl+C는 그 턴만 멈춘다 ④ /quit·exit로만 나간다. 격리 ARGO_CLI_HOME·ARGO_ROOT, 가짜 기기 세션, 가짜 모델 서버.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const hasPy = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
const base = await mkdtemp(join(tmpdir(), 'argo-cli-repl-'));
const HOME = join(base, 'home'); const ROOT = join(base, 'root'); const CLIH = join(base, 'cli');
await mkdir(HOME, { recursive: true });

// 가짜 Messages 엔드포인트 — 메시지에 SLOW가 있으면 답을 오래 끈다(답하는 중 Ctrl+C 확인용)
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    const slow = JSON.stringify(body.messages ?? []).includes('SLOW');
    // 비스트리밍 — 도구가 있으면 크루 턴이다(SDK는 스트림에 내용이 늦으면 같은 요청을 비스트리밍으로도 보낸다, 실측). 없으면 제목·상태 요약 같은 보조 호출.
    if (!body.stream) {
      const text = body.tools?.length ? '크루 답입니다' : 'title';
      const send = () => { if (!res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 't', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })); } };
      if (slow && body.tools?.length) setTimeout(send, 15_000); else send(); // 취소된 요청에 빈 몸통을 보내지 않는다(SDK가 오류로 읽는다)
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const text = body.tools?.length ? '크루 답입니다' : 'title';
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const finish = () => { if (res.writableEnded) return; ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }); ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }); ev('message_stop', {}); res.end(); };
    // 오래 걸리는 답 — 실제처럼 글자가 조금씩 흘러든다(ping만 오는 무소식 스트림은 SDK가 멈춘 것으로 보고 끊는다, 실측)
    if (slow) { const drip = setInterval(() => { if (!res.writableEnded) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '' } }); }, 400); setTimeout(() => { clearInterval(drip); finish(); }, 15_000); req.on('close', () => clearInterval(drip)); } else finish();
    req.on('close', () => { if (!res.writableEnded) res.end(); });
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => srv.close());

// LC_ALL도 고정 — CI 러너는 LC_ALL=en_US가 설정돼 있고 cliLang은 LC_ALL을 LANG보다 먼저 본다(CI 실측)
const env = { ...process.env, HOME, USERPROFILE: HOME, ARGO_CLI_HOME: CLIH, ARGO_ROOT: ROOT, LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off', ARGO_SYNC: '0', CLAUDE_CODE_MAX_RETRIES: '0', NO_COLOR: '1',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fake', ARGO_CLAUDE_BASE_URL: `http://127.0.0.1:${srv.address().port}` };
for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'ARGO_TENANT_OWNER', 'ARGO_PREFER_LEADER', 'ARGO_NO_LEADER']) delete env[k];

// pty 운전기 — 단계마다 키를 보내고 그 뒤 출력을 모은다. 결과는 JSON 한 줄.
const DRIVER = `
import pty, os, sys, time, select, json, re
steps = json.loads(sys.argv[2]); pid, fd = pty.fork()
if pid == 0: os.execvp(sys.argv[1], sys.argv[1:2] + [sys.argv[3]])
def rd(t, until=None):
    out=b''; end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: out+=os.read(fd,65536)
            except OSError: break
        if until and until in re.sub(r'\\x1b\\[[0-9;]*[A-Za-z]', '', out.decode(errors='replace')).replace('\\r', ''): break  # 화면 제어 문자를 지운 뒤 찾는다(프롬프트 앞에 \\x1b[1G\\x1b[0J가 낀다)
    return out.decode(errors='replace')
res=[{'label':'boot','out':rd(40, sys.argv[4] if len(sys.argv) > 4 else '\\u203a ')}]
for s in steps:
    try: os.write(fd, s['keys'].encode())
    except OSError: res.append({'label':s['label'],'out':'<<process gone>>'}); continue
    res.append({'label':s['label'],'out':rd(s.get('wait',1.5), s.get('until'))})
alive = os.waitpid(pid, os.WNOHANG)[0] == 0
if alive: os.kill(pid, 9); os.waitpid(pid, 0); code = None
else: code = None
try:
    p, st = os.waitpid(pid, os.WNOHANG)
except ChildProcessError: pass
print(json.dumps({'res':res,'alive':alive}))
`;

test('대화 화면 — 머리·바로 대화, Ctrl+C·Ctrl+D로 안 나가고, 답하는 중 Ctrl+C는 턴만 멈추며, exit로 나간다', { skip: !hasPy && 'python3 pty 필요(맥·리눅스)', timeout: 280_000 }, async () => {
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveDeviceSession } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/devicesession.mjs')).href)});
    const { createCompany, paths } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/workspace.mjs')).href)});
    const { saveRunnerCred } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/runners/creds.mjs')).href)});
    const fs = await import('node:fs/promises');
    await saveDeviceSession({ url: 'https://example.invalid', anonKey: 'anon-fake', session: { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-repl', email: 'repl@example.invalid' } } });
    await createCompany('repl-co', '대화 회사', 'captain', 'u-repl', 'ko');
    await fs.writeFile(paths('repl-co').agents + '/nova.md', '---\\nname: 노바\\nrole: 확인\\nrunner: claude\\n---\\n확인용.\\n');
    await saveRunnerCred('repl-co', 'claude', 'apikey', 'sk-ant-api03-' + 'x'.repeat(80));`], { env, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  // 매 단계는 입력 줄(›)이 다시 뜰 때까지 기다린다 — 사람은 답이 끝난 걸 보고 다음 줄을 친다.
  const steps = [
    { label: 'help', keys: '/help\r', until: '입력 중이면 지우기' },
    { label: 'crew-list', keys: '/crew\r', until: '번호' },
    { label: 'crew-pick', keys: '1\r', until: '대화 상대' },
    { label: 'ctrlc-empty', keys: '\x03' },
    { label: 'ctrlc-typing', keys: 'abc\x03' },
    { label: 'ctrld', keys: '\x04' },
    { label: 'chat', keys: '안녕\r', wait: 60, until: '\n› ' },
    { label: 'paste', keys: '\x1b[200~붙인 첫 줄\r붙인 둘째 줄\x1b[201~\r', wait: 60, until: '\n› ' },
    { label: 'slow', keys: 'SLOW 오래 걸리는 일\r', wait: 8, until: '작업 중' },
    { label: 'type-during', keys: '두 번째 말\r', wait: 3, until: '답이 끝나면 보냅니다' },
    { label: 'ctrlc-typed-in-turn', keys: '지울 글자\x03', wait: 2 },
    { label: 'ctrlc-turn', keys: '\x03', wait: 60, until: '\n› ' },
    { label: 'exit', keys: 'exit\r', wait: 5 },
  ];
  const r = await new Promise((resolve) => {
    const c = spawn('python3', ['-c', DRIVER, process.execPath, JSON.stringify(steps), join(REPO, 'bin', 'argo.mjs')], { env });
    let o = ''; let e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
    c.on('close', () => resolve({ o, e }));
  });
  assert.ok(r.o.trim(), `pty 운전기 출력 없음: ${r.e.slice(-800)}`);
  const { res, alive } = JSON.parse(r.o.trim().split('\n').pop() || '{}');
  const out = Object.fromEntries(res.map((x) => [x.label, x.out]));
  if (process.env.REPL_DUMP) for (const x of res) console.log('=== ' + x.label + '\n' + x.out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  assert.match(out.boot, /▀██▀/, '심볼');
  assert.match(out.boot, /v\d+\.\d+\.\d+ · CLI/, '버전');
  assert.match(out.boot, /대화 상대: 노바/, '크루가 한 명이면 바로 그 크루와 대화');
  assert.match(out.help, /\/quit, exit/);
  assert.match(out['crew-list'], /대화할 크루를 고르세요[\s\S]*1\. 노바/, '/crew만 치면 크루 목록(실측: 지금 크루만 다시 보였다)');
  assert.match(out['ctrlc-empty'], /나가려면 \/quit 또는 exit/, '빈 줄 Ctrl+C — 안내만');
  assert.doesNotMatch(out['ctrlc-typing'] + out.ctrld, /나가려면|Aborted/, '입력 중 Ctrl+C·Ctrl+D — 나가지도 오류도 없다');
  assert.match(out.chat, /노바[\s\S]*크루 답입니다/, '크루 답');
  assert.doesNotMatch(out.boot + out.chat, /Warning|canUseTool/, '내부 경고가 대화 화면에 끼지 않는다');
  assert.doesNotMatch(out['ctrlc-typed-in-turn'], /멈췄습니다|멈추는 중/, '답하는 중이라도 친 글자가 있으면 Ctrl+C는 그 줄만 지운다');
  assert.match(out['ctrlc-turn'], /멈췄습니다/, '답하는 중 Ctrl+C — 턴만 멈춘다');
  assert.match(out['type-during'], /두 번째 말\s+\(답이 끝나면 보냅니다\)/, '답하는 중에 친 줄은 대기열로');
  assert.match(out['ctrlc-turn'], /멈췄습니다[\s\S]*노바[\s\S]*크루 답입니다/, '멈춘 뒤 대기열의 말을 보낸다');
  assert.equal(alive, false, 'exit로 나갔다');
  const t = JSON.parse(await readFile(join(ROOT, 'repl-co', 'chats', 'nova.json'), 'utf8'));
  assert.ok(t.messages.some((m) => m.who === 'crew' && m.text === '크루 답입니다'), '앱과 같은 대화 기록');
  assert.ok(t.messages.every((m) => !m.awaiting), '멈춘 턴도 대기 표시가 남지 않는다');
  // 여러 줄 붙여넣기는 한 메시지 한 턴(실측: 줄마다 턴이 됐다)
  assert.ok(t.messages.some((m) => m.who === 'user' && m.text === '붙인 첫 줄\n붙인 둘째 줄'), '붙여넣은 두 줄이 한 메시지로');
  assert.ok(!t.messages.some((m) => m.who === 'user' && (m.text === '붙인 첫 줄' || m.text === '붙인 둘째 줄')), '줄마다 따로 가지 않는다');
});

test('AI 미연결 기기 — 첫 화면에 /ai 안내, 말을 걸면 /ai로 안내(앱 문구 "설정 →" 아님), 코어 로그는 화면 대신 cli.log', { skip: !hasPy && 'python3 pty 필요(맥·리눅스)', timeout: 120_000 }, async () => {
  const b2 = await mkdtemp(join(tmpdir(), 'argo-cli-repl-norunner-'));
  const env2 = { ...env, HOME: join(b2, 'home'), USERPROFILE: join(b2, 'home'), ARGO_CLI_HOME: join(b2, 'cli'), ARGO_ROOT: join(b2, 'root') };
  delete env2.ARGO_SYNC; // 동기화 시작 로그([argo] …)가 실제로 찍히게 — 화면이 아니라 cli.log로 가야 한다
  await mkdir(env2.HOME, { recursive: true });
  const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { saveDeviceSession } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/devicesession.mjs')).href)});
    const { createCompany, paths } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/workspace.mjs')).href)});
    const fs = await import('node:fs/promises');
    await saveDeviceSession({ url: 'https://example.invalid', anonKey: 'anon-fake', session: { access_token: 'a', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-nr', email: 'nr@example.invalid' } } });
    await createCompany('nr-co', '연결 없는 회사', 'captain', 'u-nr', 'ko');
    await fs.writeFile(paths('nr-co').agents + '/nova.md', '---\\nname: 노바\\nrole: 확인\\nrunner: claude\\n---\\n확인용.\\n');`], { env: env2, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const steps = [{ label: 'chat', keys: '안녕\r', wait: 40, until: '\n› ' }, { label: 'exit', keys: 'exit\r', wait: 5 }];
  const r = await new Promise((resolve) => {
    const c = spawn('python3', ['-c', DRIVER, process.execPath, JSON.stringify(steps), join(REPO, 'bin', 'argo.mjs')], { env: env2 });
    let o = ''; let e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
    c.on('close', () => resolve({ o, e }));
  });
  assert.ok(r.o.trim(), `pty 운전기 출력 없음: ${r.e.slice(-800)}`);
  const { res } = JSON.parse(r.o.trim().split('\n').pop());
  const out = Object.fromEntries(res.map((x) => [x.label, x.out]));
  assert.match(out.boot, /이 기기에는 아직 AI가 연결되지 않았습니다\. \/ai로 연결하세요/);
  assert.doesNotMatch(out.boot, /\[argo\]/, '코어 로그가 화면에 끼지 않는다');
  assert.match(out.chat, /\/ai/);
  assert.doesNotMatch(out.chat, /설정 →/, '앱 기준 안내가 아니라 CLI 명령으로');
  const log = await readFile(join(env2.ARGO_CLI_HOME, 'cli.log'), 'utf8').catch(() => '');
  assert.match(log, /\[argo\]/, '코어 로그는 cli.log에');
});

test('이 컴퓨터에서만(로컬) — 처음 실행에서 고르면 앱 데이터 폴더에 주인 없는 회사, 로컬 표시 파일, 메신저 대기는 거절', { skip: !hasPy && 'python3 pty 필요(맥·리눅스)', timeout: 120_000 }, async () => {
  const b3 = await mkdtemp(join(tmpdir(), 'argo-cli-local-'));
  const env3 = { ...env, HOME: join(b3, 'home'), USERPROFILE: join(b3, 'home'), ARGO_CLI_HOME: join(b3, 'cli'), XDG_DATA_HOME: join(b3, 'xdg'), LOCALAPPDATA: join(b3, 'la') };
  delete env3.ARGO_ROOT; // 모드가 폴더를 정하게
  await mkdir(env3.HOME, { recursive: true });
  const { appDataRoot } = await import('../src/cli/env.mjs');
  const appRoot = appDataRoot({ env: env3, home: env3.HOME });
  const steps = [
    { label: 'pick-local', keys: '2\r', until: '새 회사 이름' },
    { label: 'company', keys: '로컬 회사\r', wait: 20, until: '\n› ' },
    { label: 'serve', keys: '/serve\r', until: '\n› ' },
    { label: 'exit', keys: 'exit\r', wait: 5 },
  ];
  const r = await new Promise((resolve) => {
    const c = spawn('python3', ['-c', DRIVER, process.execPath, JSON.stringify(steps), join(REPO, 'bin', 'argo.mjs'), '번호'], { env: env3 });
    let o = ''; let e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d));
    c.on('close', () => resolve({ o, e }));
  });
  assert.ok(r.o.trim(), `pty 운전기 출력 없음: ${r.e.slice(-800)}`);
  const { res, alive } = JSON.parse(r.o.trim().split('\n').pop());
  const out = Object.fromEntries(res.map((x) => [x.label, x.out]));
  assert.match(out.boot, /Argo를 어떻게 쓸까요\?[\s\S]*이 컴퓨터에서만 쓰기/);
  assert.match(out.company, /이 컴퓨터에서만\(로그인 없음\) · 로컬 회사/);
  assert.match(out.serve, /메신저 대기\(상주\)를 쓸 수 없습니다/);
  assert.equal(alive, false);
  const { readdir } = await import('node:fs/promises');
  const ws = (await readdir(appRoot)).find((d) => !d.startsWith('.'));
  const co = JSON.parse(await readFile(join(appRoot, ws, 'company.json'), 'utf8'));
  assert.equal(co.name, '로컬 회사'); assert.equal(co.ownerId, undefined, '주인 없음 — 앱 로컬 모드 목록에 보이고, 로그인하면 클레임');
  assert.equal(JSON.parse(await readFile(join(appRoot, '.guest-mode.json'), 'utf8')).enabled, true, '앱의 로컬 시작 표시와 같은 파일');
  assert.equal(JSON.parse(await readFile(join(env3.ARGO_CLI_HOME, 'cli.json'), 'utf8')).mode, 'local', '다음 실행부터 묻지 않는다');
  const run = spawnSync(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'run'], { env: env3, encoding: 'utf8' });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /메신저 대기\(상주\)를 쓸 수 없습니다/, 'argo run도 거절 — 앱과 같은 폴더에 예약 실행이 두 번 돌지 않게');
});

test('로컬 모드인데 이 컴퓨터의 앱이 계정으로 로그인돼 있으면 — 앱 세션을 같이 쓰지 않고 계정 모드로(세션 가족 폐기 방지)', async () => {
  const b4 = await mkdtemp(join(tmpdir(), 'argo-cli-local-signed-'));
  const env4 = { ...env, HOME: join(b4, 'home'), USERPROFILE: join(b4, 'home'), ARGO_CLI_HOME: join(b4, 'cli'), XDG_DATA_HOME: join(b4, 'xdg'), LOCALAPPDATA: join(b4, 'la') };
  delete env4.ARGO_ROOT;
  const { appDataRoot } = await import('../src/cli/env.mjs');
  const appRoot = appDataRoot({ env: env4, home: env4.HOME });
  const { writeFile, stat } = await import('node:fs/promises');
  await mkdir(appRoot, { recursive: true }); await mkdir(env4.ARGO_CLI_HOME, { recursive: true });
  await writeFile(join(appRoot, '.device-session.json'), '{"app":"signed-in"}');
  await writeFile(join(env4.ARGO_CLI_HOME, 'cli.json'), JSON.stringify({ mode: 'local' }));
  const before = (await stat(join(appRoot, '.device-session.json'))).mtimeMs;
  const r = spawnSync(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'status'], { env: env4, encoding: 'utf8' });
  assert.match(r.stdout, /계정 모드로 씁니다/);
  assert.match(r.stdout, new RegExp(`데이터: .*cli-workspaces`), '앱 폴더가 아니라 CLI 계정 폴더');
  assert.equal(JSON.parse(await readFile(join(env4.ARGO_CLI_HOME, 'cli.json'), 'utf8')).mode, 'account');
  assert.equal((await stat(join(appRoot, '.device-session.json'))).mtimeMs, before, '앱 세션 파일은 건드리지 않는다');
});

test('데스크톱 앱이 없는 리눅스(서버) — 로컬 모드 안내가 "Argo 앱과 같은 데이터"라고 하지 않는다(그 폴더를 쓰는 앱이 없다)', { timeout: 60_000 }, async () => {
  const b5 = await mkdtemp(join(tmpdir(), 'argo-cli-linux-'));
  const { writeFile } = await import('node:fs/promises');
  // 플랫폼만 리눅스로 — 리눅스 데스크톱 앱은 배포하지 않는다(release.yml: 맥 2종·Windows)
  const preload = join(b5, 'linux.mjs'); await writeFile(preload, "Object.defineProperty(process, 'platform', { value: 'linux' });\n");
  const env5 = { ...env, HOME: join(b5, 'home'), USERPROFILE: join(b5, 'home'), ARGO_CLI_HOME: join(b5, 'cli'), XDG_DATA_HOME: join(b5, 'xdg'), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  delete env5.ARGO_ROOT;
  await mkdir(env5.HOME, { recursive: true });
  if (hasPy) { // 처음 실행의 선택지
    const r = await new Promise((resolve) => {
      const c = spawn('python3', ['-c', DRIVER, process.execPath, '[]', join(REPO, 'bin', 'argo.mjs'), '번호'], { env: env5 });
      let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => resolve(o));
    });
    const boot = JSON.parse(r.trim().split('\n').pop()).res[0].out;
    assert.match(boot, /이 컴퓨터에서만 쓰기 — 로그인 없이, 이 컴퓨터에만 저장합니다/);
    assert.doesNotMatch(boot, /Argo 앱/);
  }
  await mkdir(env5.ARGO_CLI_HOME, { recursive: true }); await writeFile(join(env5.ARGO_CLI_HOME, 'cli.json'), JSON.stringify({ mode: 'local' }));
  const run = spawnSync(process.execPath, [join(REPO, 'bin', 'argo.mjs'), 'run'], { env: env5, encoding: 'utf8' });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /메신저 대기\(상주\)를 쓸 수 없습니다/);
  assert.doesNotMatch(run.stderr, /Argo 앱/, '예약 작업을 맡을 앱이 없다');
});
