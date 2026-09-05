// 네이티브 엔진 분리 검수(review-native 2026-09-05) 처방의 행동 테스트 — CRITICAL-1(Grep glob 우회)·HIGH-1(유령 도구)·HIGH-2(전사 오염)·
// MEDIUM-1~4(실패 usage·동기화 제외·MCP 누수·ReDoS)·LOW + 독립 변이 GREEN 축(R3~R20). 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat, symlink, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';
import { useFakeAccountKey } from './helpers/fake-account-key.mjs';
await useFakeAccountKey(); // 전체 봉투 기본 켜짐 — 계정 키 없으면 EXCLUDE가 전체를 보류한다

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-native-rv-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-native-rv-'));
process.env.ARGO_MODEL_CATALOG = 'off';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const POSIX = process.platform !== 'win32';

const { nativeQuery } = await import('../src/engine/native-query.mjs');
const { builtinRunners, parseSearchResults, posixify, PATHY_GLOB_RE, grepWorkerPath, GREP_TIMEOUT_MS } = await import('../src/engine/builtin-tools.mjs');
const { sanitizeTranscript, saveNativeSession, sessionFile, SESSION_TRIM_TO } = await import('../src/engine/session.mjs');
const { connectMcpServers, MCP_CONNECT_TIMEOUT_MS } = await import('../src/engine/mcp-client.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { makePermissionGate, readToolTargets } = await import('../src/permission-gate.mjs');
const { classifyRunnerError, AUTH_TEXT_RE } = await import('../src/runners/error-class.mjs');
const { EXCLUDE } = await import('../src/sync.mjs');
const { makeCrewServer } = await import('../src/chat.mjs');

async function fakeMessages(script) {
  const bodies = [];
  const srv = createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => {
      const body = JSON.parse(d || '{}'); bodies.push({ url: req.url, headers: req.headers, body });
      const step = script[Math.min(bodies.length - 1, script.length - 1)];
      const out = typeof step === 'function' ? step(body, bodies.length) : step;
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.json ?? out));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, bodies, close: () => new Promise((r) => srv.close(r)) };
}
const msg = (content, stop = 'end_turn') => ({ id: 'm', type: 'message', role: 'assistant', model: 'fake', content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });
const env = (base, extra = {}) => ({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'tok-fake-1234567890', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ...extra });
async function collect(q) { const out = []; for await (const m of q) out.push(m); return out; }
async function company(ws) { await createCompany(ws, ws, '사장'); await mkdir(join(paths(ws).root, 'vault'), { recursive: true }); return paths(ws).root; }

test('C1. Grep glob 우회 봉쇄 — 금고·타사 워크스페이스·홈 자격 카나리 3종: 게이트 deny + 실행기 거절(2중) + 루트 상대 필터는 정상', async () => {
  const root = await company('rv-c1'); const other = await company('rv-c1-other');
  await writeFile(join(root, '.secrets.json'), JSON.stringify({ runners: { openrouter: { type: 'apikey', value: 'CREWKEY-CANARY-ABCDEF' } } }));
  await writeFile(join(other, 'company.json'), '{"name":"OTHER-CANARY"}');
  await mkdir(join(process.env.HOME, '.claude'), { recursive: true }); await writeFile(join(process.env.HOME, '.claude', '.credentials.json'), '{"token":"HOME-CANARY"}');
  await writeFile(join(root, 'vault', 'a.txt'), 'CANARY in txt\n'); await writeFile(join(root, 'vault', 'b.md'), 'CANARY in md\n');
  const gate = makePermissionGate('rv-c1', 'seoyun', root, null, 'ko', []);
  const cases = [
    { path: 'vault', glob: '../.secrets.json' }, { path: 'vault', glob: '../../rv-c1-other/**' }, { path: 'vault', glob: `${process.env.HOME}/.claude/.*` }, { glob: '~/.claude/.*' },
  ];
  for (const c of cases) {
    const g = await gate('Grep', { pattern: 'CANARY', ...c });
    assert.equal(g.behavior, 'deny', `게이트가 막는다: ${JSON.stringify(c)}`);
    const t = builtinRunners({ cwd: root });
    await assert.rejects(t.Grep({ pattern: 'CANARY', ...c }), /relative filename filter/, `게이트 없이도 실행기가 거절: ${JSON.stringify(c)}`);
  }
  assert.deepEqual(readToolTargets('Grep', { path: 'vault', glob: '../.secrets.json' }), ['vault', 'vault/../.secrets.json'], '경로형 glob이 판정 대상에 든다');
  assert.deepEqual(readToolTargets('Grep', { path: 'vault', glob: '**/*.md' }), ['vault'], '루트 상대 필터는 경로가 아니다');
  const t = builtinRunners({ cwd: root });
  assert.equal((await gate('Grep', { pattern: 'CANARY', path: 'vault', glob: '**/*.md' })).behavior, 'allow');
  assert.equal(await t.Grep({ pattern: 'CANARY', path: 'vault', glob: '**/*.md' }), 'b.md', 'glob은 루트 상대 필터로 실제 동작(R20)');
  assert.equal(await t.Grep({ pattern: 'CANARY', path: 'vault' }), 'a.txt\nb.md');
  await assert.rejects(t.Glob({ pattern: '../*.json' }), /relative to path/, 'Glob 패턴의 ..도 실행기가 거절');
  await assert.rejects(t.Glob({ pattern: `${root}/../rv-c1-other/*` }), /relative to path/);
  assert.equal((await gate('Read', { file_path: '.sessions/native/seoyun.json' })).behavior, 'deny', '.sessions는 보호 구역(R16)');
  assert.equal((await gate('Bash', { command: 'cat .sessions/native/seoyun.json' })).behavior, 'deny', '.sessions 등재 = Bash 리터럴 1차 방어(R16)');
  // 워커 층 단독(3중 방어의 안쪽): 실행기 거절을 건너뛰고 워커에 경로형 glob을 직접 줘도 열거 패턴이 되지 않고 루트 밖은 버린다
  const runWorker = (glob) => new Promise((res, rej) => {
    const w = new Worker(new URL('../src/engine/grep-worker.mjs', import.meta.url), { workerData: { root: join(root, 'vault'), pattern: 'CANARY', flags: '', glob, mode: 'content', headLimit: 50 } });
    w.once('message', (m) => res(m.ok ? m.text : `ERR ${m.error}`)); w.once('error', rej);
  });
  for (const glob of ['../.secrets.json', '../../rv-c1-other/**', `${process.env.HOME}/.claude/.*`]) {
    const out = await runWorker(glob);
    assert.ok(!/CREWKEY|OTHER-CANARY|HOME-CANARY/.test(out), `워커 단독으로도 유출 없음: ${glob} → ${out.slice(0, 80)}`);
  }
  // 계약 핀: glob은 **루트 상대 필터**이지 열거 패턴이 아니다 — 루트 안 파일의 절대경로를 glob으로 주면 필터로는 아무것도 못 고른다
  // (열거 패턴 자리에 넣는 회귀는 이 파일을 찾아낸다: 실경로 봉쇄만으로는 구분 못 하는 축)
  assert.equal(await runWorker(join(root, 'vault', 'a.txt')), '(no matches)', 'glob=절대경로는 필터로서 무매치(열거 패턴 회귀 감지)');
});

test('H1. 크루 도구 노출 집합 = SDK 최종 등재 배열 — 동료 0·커넥터 0이면 delegate·send_to_crew·use_connector 부재, 동료 있으면 등재', async () => {
  await company('rv-h1');
  const sink0 = []; makeCrewServer('rv-h1', 'seoyun', '서윤', [], 0, [], null, 'ko', [], '', sink0);
  assert.deepEqual(sink0.map((d) => d.name).sort(), ['hire_crew', 'request_approval', 'request_tool_install', 'schedule_task', 'start_long_task', 'update_profile'], '기본 6종만');
  const sink1 = []; makeCrewServer('rv-h1', 'seoyun', '서윤', [{ slug: 'jun', name: '준', role: 'dev' }], 0, [], null, 'ko', [], '', sink1);
  assert.ok(sink1.some((d) => d.name === 'delegate') && sink1.some((d) => d.name === 'send_to_crew'), '동료가 있으면 위임·쪽지 등재');
  assert.ok(!sink1.some((d) => d.name === 'use_connector'), '커넥터 0이면 use_connector 부재');
});

test('H2. tool_use는 stop_reason과 무관하게 실행되고, 죽은 턴의 꼬리는 재개 시 정리된다', async () => {
  const root = await company('rv-h2');
  const srv = await fakeMessages([
    msg([{ type: 'text', text: '문서 쓸게' }, { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'vault/h2.md', content: 'ok' } }], 'max_tokens'),
    msg([{ type: 'text', text: '썼다' }]),
  ]);
  try {
    const out = await collect(nativeQuery({ wsId: 'rv-h2', slug: 's', prompt: '써', cwd: root, systemPrompt: '', env: env(srv.base), model: 'm', canUseTool: makePermissionGate('rv-h2', 's', root, null, 'ko', []) }));
    assert.equal(out.at(-1).result, '썼다'); assert.equal(await readFile(join(root, 'vault', 'h2.md'), 'utf8'), 'ok', 'max_tokens 절단 응답의 tool_use도 실행');
    const tr = srv.bodies[1].body.messages; assert.equal(tr.at(-1).content[0].tool_use_id, 'w1', '대응 tool_result가 붙어 나간다');
  } finally { await srv.close(); }
  // 전사 정리(순수) — 짝 없는 tool_use·답 없는 꼬리·역할 연속 전부 제거, 완결된 턴은 보존
  const done = [{ role: 'user', content: 'q1' }, { role: 'assistant', content: [{ type: 'text', text: 'a1' }] }];
  const broken = [...done, { role: 'user', content: 'q2' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }];
  assert.deepEqual(sanitizeTranscript(broken), done, 'tool_result로 끝난 죽은 턴은 통째로 걷어내고 완결 턴만 남긴다');
  assert.deepEqual(sanitizeTranscript([...done, { role: 'user', content: 'q2' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }]), done, '짝 없는 tool_use');
  assert.deepEqual(sanitizeTranscript([...done, { role: 'user', content: 'dangling' }]), done, '답 없는 지시');
  assert.deepEqual(sanitizeTranscript([{ role: 'assistant', content: [{ type: 'text', text: 'orphan' }] }, ...done]), done, '첫 메시지는 user');
  // 재개 경로 실측 — 죽은 꼬리를 가진 세션 파일로 이어가면 벤더에 나가는 messages가 정상 형태
  await mkdir(join(root, '.sessions', 'native'), { recursive: true });
  await writeFile(sessionFile('rv-h2', 'dead'), JSON.stringify({ id: 'native-dead', at: 1, messages: broken }));
  const srv2 = await fakeMessages([msg([{ type: 'text', text: 'ok' }])]);
  try {
    const out2 = await collect(nativeQuery({ wsId: 'rv-h2', slug: 'dead', prompt: 'q3', cwd: root, systemPrompt: '', env: env(srv2.base), model: 'm', resume: 'native-dead' }));
    assert.equal(out2[0].session_id, 'native-dead');
    const sent = srv2.bodies[0].body.messages; assert.deepEqual(sent.map((m) => m.role), ['user', 'assistant', 'user'], '역할 연속 없음·짝 없는 tool_use 없음');
  } finally { await srv2.close(); }
});

test('M1. 도구를 쓴 뒤의 벤더 실패는 usage를 실은 실패 result로 나온다(집계 도달) — 원문은 errors[]', async () => {
  const root = await company('rv-m1'); await writeFile(join(root, 'vault', 'n.md'), 'x\n');
  const srv = await fakeMessages([
    msg([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'vault/n.md' } }], 'tool_use'),
    { status: 500, json: { error: { message: 'boom' } } },
  ]);
  try {
    const out = await collect(nativeQuery({ wsId: 'rv-m1', slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: env(srv.base), model: 'm', canUseTool: makePermissionGate('rv-m1', 's', root, null, 'ko', []) }));
    const r = out.at(-1); assert.equal(r.type, 'result'); assert.equal(r.subtype, 'error_during_execution'); assert.equal(r.is_error, true);
    assert.equal(r.usage.input_tokens, 10, '실패 전 사용량 보존'); assert.match(r.errors[0], /^API Error: 500 boom/);
    assert.equal(srv.bodies.length, 3, '500은 1회 재시도(총 2회) 뒤 포기');
  } finally { await srv.close(); }
});

test('M2·R10·R7·R8·R12. 동기화 제외·저장 절단·max_tokens env·도구 결과 상한·절대경로', async () => {
  assert.equal(EXCLUDE('.sessions/native/seoyun.json'), true, '.sessions 디렉터리는 동기화 대상이 아니다');
  assert.equal(EXCLUDE('vault/note.md'), false);
  const root = await company('rv-m2');
  const big = 'x'.repeat(5000);
  const sess = { id: 'native-big', messages: [] };
  for (let i = 0; i < 120; i++) sess.messages.push({ role: 'user', content: `u${i} ${big}` }, { role: 'assistant', content: [{ type: 'text', text: big }] });
  await saveNativeSession('rv-m2', 'big', sess);
  const size = (await stat(sessionFile('rv-m2', 'big'))).size;
  assert.ok(size <= SESSION_TRIM_TO + 2000 && sess.messages.length < 240, `저장 시 절단 적용(${size}B, ${sess.messages.length}msgs)`);
  await writeFile(join(root, 'vault', 'huge.txt'), 'y'.repeat(100_000));
  const srv = await fakeMessages([msg([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: join(root, 'vault', 'huge.txt') } }], 'tool_use'), msg([{ type: 'text', text: 'done' }])]);
  try {
    await collect(nativeQuery({ wsId: 'rv-m2', slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: env(srv.base, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' }), model: 'm', canUseTool: makePermissionGate('rv-m2', 's', root, null, 'ko', []) }));
    assert.equal(srv.bodies[0].body.max_tokens, 4096, 'CLAUDE_CODE_MAX_OUTPUT_TOKENS(OPENROUTER_MAX_OUTPUT_TOKENS 경유)를 존중');
    const tr = srv.bodies[1].body.messages.at(-1).content[0]; assert.ok(tr.content.length <= 60_000 + 200 && tr.content.length > 50_000, `도구 결과 상한(${tr.content.length})`);
    assert.match(tr.content, /^1\ty/, '절대경로 Read 정상');
  } finally { await srv.close(); }
});

test('R13. system/init에 외부 MCP 상태가 실린다(실패 서버 = failed) — chat.mjs mcpFailures가 소비하는 자리', async () => {
  const root = await company('rv-r13');
  const srv = await fakeMessages([msg([{ type: 'text', text: 'ok' }])]);
  try {
    const out = await collect(nativeQuery({ wsId: 'rv-r13', slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: env(srv.base), model: 'm', mcpServers: { ghost: { command: 'argo-definitely-missing-cmd-xyz', args: [] } } }));
    assert.deepEqual(out[0].mcp_servers, [{ name: 'crew', status: 'connected' }, { name: 'ghost', status: 'failed', error: out[0].mcp_servers[1].error }]);
    assert.ok(String(out[0].mcp_servers[1].error).length > 0);
  } finally { await srv.close(); }
});

test('M3·R3·R4·R13. 외부 MCP — 실서버 접속 성공(도구 gated·env 세척), 무응답 서버는 failed status + 자식 프로세스 정리', { skip: !POSIX }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-mcp-'));
  const server = join(dir, 'probe-server.mjs');
  await writeFile(server, `import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(ROOT, 'package.json'))});
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const s = new McpServer({ name: 'probe', version: '1.0.0' });
s.tool('envprobe', 'token presence', async () => ({ content: [{ type: 'text', text: 'token=' + (process.env.ANTHROPIC_AUTH_TOKEN ?? 'absent') }] }));
s.tool('readpath', 'path arg', { file_path: z.string() }, async ({ file_path }) => ({ content: [{ type: 'text', text: 'would read ' + file_path }] }));
await s.connect(new StdioServerTransport());
`);
  const marker = `mcp-leak-canary-${Date.now()}`;
  const mcp = await connectMcpServers({
    probe: { command: process.execPath, args: [server] },
    dead: { command: process.execPath, args: ['-e', `process.title='${marker}'; setInterval(() => {}, 1000)`] },
  }, { env: { PATH: process.env.PATH, ANTHROPIC_AUTH_TOKEN: 'leak' }, cwd: dir, timeoutMs: 2500 });
  try {
    assert.deepEqual(mcp.statuses.map((s) => `${s.name}:${s.status}`), ['probe:connected', 'dead:failed'], '상태 보고(R13)');
    const names = mcp.tools.map((t) => t.name); assert.ok(names.includes('mcp__probe__envprobe') && names.includes('mcp__probe__readpath'));
    assert.ok(mcp.tools.every((t) => t.gated === true), '외부 MCP 도구는 전부 게이트를 지난다(R3)');
    assert.equal(await mcp.tools.find((t) => t.name === 'mcp__probe__envprobe').run({}), 'token=absent', 'MCP 자식에 러너 자격 미상속(R4)');
    const root = await company('rv-m3'); const gate = makePermissionGate('rv-m3', 's', root, null, 'ko', []);
    assert.equal((await gate('mcp__probe__readpath', { file_path: '.secrets.json' })).behavior, 'deny', '외부 MCP 경로 인자도 게이트가 판정');
    await new Promise((r) => setTimeout(r, 400));
    const alive = (() => { try { return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
    assert.equal(alive, '', '접속 실패한 stdio 자식이 남지 않는다(MEDIUM-3)');
  } finally { await mcp.close(); }
});

test('M4·R5. Grep은 워커에서 돌아 ReDoS가 서버를 멈추지 않고 시간 상한에 걸린다; 도구 실행 중 interrupt는 즉시 끊는다', async () => {
  const root = await company('rv-m4'); await writeFile(join(root, 'vault', 'evil.txt'), `${'a'.repeat(40)}!\n`);
  const t = builtinRunners({ cwd: root, grepTimeoutMs: 1500 });
  let ticks = 0; const iv = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  // 상한이 죽으면 hang → node --test는 cancelled(= fail 0)로 보고해 배터리가 오판한다 → 8초 race로 즉시 red
  await assert.rejects(Promise.race([t.Grep({ pattern: '(a+)+$', path: 'vault' }), new Promise((_, rej) => setTimeout(() => rej(new Error('grep timeout did not fire within 8s')), 8000))]), /timed out/);
  clearInterval(iv);
  assert.ok(Date.now() - t0 < 5000 && ticks > 40, `이벤트 루프 생존(ticks=${ticks}, ${Date.now() - t0}ms)`);
  if (POSIX) {
    const srv = await fakeMessages([msg([
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 20' } },
      { type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: 'vault/after-abort.md', content: 'must not exist' } },
    ], 'tool_use'), msg([{ type: 'text', text: 'never' }])]);
    try {
      const q = nativeQuery({ wsId: 'rv-m4', slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: env(srv.base), model: 'm', canUseTool: makePermissionGate('rv-m4', 's', root, null, 'ko', []) });
      const p = collect(q); setTimeout(() => q.interrupt(), 500);
      const t1 = Date.now();
      await assert.rejects(Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('interrupt ignored')), 6000))]), (e) => e.aborted === true);
      assert.ok(Date.now() - t1 < 5000, '도구 실행 중에도 중단이 즉시 통한다(R5)');
      await assert.rejects(readFile(join(root, 'vault', 'after-abort.md')), '중단 뒤 다음 도구는 실행되지 않는다(R5 — 도구 사이 검사)');
    } finally { await srv.close(); }
  }
});

test('LOW·R15·R18·R19·R14. WebSearch 파서·경로 정규화·인증 원문 분류·중단 핸들 단일 등록', async () => {
  const html = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example <b>A</b></a><a class="result__snippet" href="#">Snippet &amp; more</a>';
  assert.deepEqual(parseSearchResults(html), [{ title: 'Example A', url: 'https://example.com/a', snippet: 'Snippet & more' }]);
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { assert.match(await builtinRunners({ cwd: ROOT, searchBase: `http://127.0.0.1:${srv.address().port}/?q=` }).WebSearch({ query: 'x' }), /1\. Example A\n\s+https:\/\/example\.com\/a/); } finally { srv.close(); }
  assert.equal(posixify('a\\b\\c.md', '\\'), 'a/b/c.md', '윈도우 구분자 정규화(R19)');
  assert.ok(PATHY_GLOB_RE.test('C:\\x\\y') && PATHY_GLOB_RE.test('..\\.secrets.json') && !PATHY_GLOB_RE.test('**/*.md'), '경로형 판정은 백슬래시도(R18)');
  assert.equal(classifyRunnerError('API Error: 401 invalid api key').code, 'auth_expired');
  assert.equal(classifyRunnerError('Request failed: unauthorized').code, 'auth_expired');
  assert.notEqual(classifyRunnerError('API Error: 403 forbidden by policy').code, 'auth_expired', '403은 인증으로 단정하지 않는다');
  assert.ok(AUTH_TEXT_RE.test('401') && !AUTH_TEXT_RE.test('4011'));
  const src = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  assert.equal((src.match(/abortReg = registerTurn\(/g) ?? []).length, 2, 'CLI·SDK 두 갈래 각 1회'); assert.doesNotMatch(src, /\n\s*abortReg = (?!registerTurn\()/, '중단 핸들을 뒤에서 덮어쓰지 않는다(R14)');
  assert.match(src, /const tools = \[\n\s*requestApproval, requestToolInstall, updateProfile, hireCrew, scheduleTask, startLongTask,/, '크루 도구 최종 배열 한 원천');
  assert.match(src, /if \(sink\) sink\.push\(\.\.\.tools\.map\(\(t\) => defs\.get\(t\)\)\.filter\(Boolean\)\);/, 'sink = 최종 배열');
});

test('SYM. 심링크 미추종(재검수 NEW-HIGH-1) — Grep·Glob이 vault 안 심링크로 금고·홈 자격에 닿지 않고, 내부 심링크도 노출하지 않는다', { skip: !POSIX }, async () => {
  const root = await company('rv-sym');
  await writeFile(join(root, '.secrets.json'), '{"k":"WSKEY-CANARY"}');
  await mkdir(join(process.env.HOME, '.claude'), { recursive: true }); await writeFile(join(process.env.HOME, '.claude', 'creds.json'), '{"t":"HOMECRED-CANARY"}');
  await writeFile(join(root, 'vault', 'a.txt'), 'CANARY a\n'); await writeFile(join(root, 'vault', 'b.md'), 'CANARY b\n');
  await symlink(join(root, '.secrets.json'), join(root, 'vault', 'note.json'));            // 파일 심링크 → 금고
  await symlink(join(process.env.HOME, '.claude', 'creds.json'), join(root, 'vault', 'hc.json')); // 파일 심링크 → 홈 자격
  await symlink(join(process.env.HOME, '.claude'), join(root, 'vault', 'dir'));               // 디렉터리 심링크 → 홈(하강 시 실경로 루트 밖)
  await symlink(join(root, 'vault', 'b.md'), join(root, 'vault', 'link.md'));                 // 내부 심링크(실경로는 루트 안 — lstat 층이 단독으로 막는다)
  const gate = makePermissionGate('rv-sym', 's', root, null, 'ko', []);
  assert.equal((await gate('Grep', { pattern: 'CANARY', path: 'vault' })).behavior, 'allow', '게이트는 path만 본다 — 실행기가 지켜야 한다');
  const t = builtinRunners({ cwd: root });
  assert.equal(await t.Grep({ pattern: 'CANARY', path: 'vault' }), 'a.txt\nb.md', '심링크(금고·홈·디렉터리 하강·내부)는 전부 결과 밖');
  const g = (await t.Glob({ pattern: '**/*', path: 'vault' })).split('\n');
  assert.ok(g.includes('a.txt') && g.includes('b.md'), '실파일은 나온다');
  for (const bad of ['note.json', 'hc.json', 'dir', 'link.md']) assert.ok(!g.some((x) => x === bad || x.startsWith(`${bad}/`)), `Glob 심링크 미노출·하강분 미노출: ${bad}`);
  const content = await t.Grep({ pattern: 'CANARY', path: 'vault', output_mode: 'content' });
  assert.ok(!/WSKEY|HOMECRED/.test(content), '내용도 유출 없음');
});

test('WP·S11·S21. 워커 경로 런타임 해석(번들 재작성 무관)·기본 상한 상수·긴 Grep 중 정지 신호', async () => {
  // 후보 순서: env > cwd/src/engine > argv1 기준 > 소스 import.meta.url
  const tmp = await mkdtemp(join(tmpdir(), 'argo-wp-')); await mkdir(join(tmp, 'src', 'engine'), { recursive: true });
  await copyFile(join(ROOT, 'src', 'engine', 'grep-worker.mjs'), join(tmp, 'src', 'engine', 'grep-worker.mjs'));
  assert.equal(grepWorkerPath({ env: {}, cwd: tmp, argv1: null }), join(tmp, 'src', 'engine', 'grep-worker.mjs'), 'cwd 기준(standalone·next start)');
  const alt = await mkdtemp(join(tmpdir(), 'argo-wp2-')); await mkdir(join(alt, 'src', 'engine'), { recursive: true }); await copyFile(join(ROOT, 'src', 'engine', 'grep-worker.mjs'), join(alt, 'src', 'engine', 'grep-worker.mjs'));
  assert.equal(grepWorkerPath({ env: {}, cwd: '/nonexistent-cwd', argv1: join(alt, 'server.js') }), join(alt, 'src', 'engine', 'grep-worker.mjs'), 'server.js 기준(사이드카)');
  assert.equal(grepWorkerPath({ env: { ARGO_GREP_WORKER: join(alt, 'src', 'engine', 'grep-worker.mjs') }, cwd: tmp, argv1: null }), join(alt, 'src', 'engine', 'grep-worker.mjs'), 'env 지정이 우선');
  assert.equal(grepWorkerPath({ env: {}, cwd: '/nonexistent-cwd', argv1: null }), join(ROOT, 'src', 'engine', 'grep-worker.mjs'), '소스 실행 폴백(테스트·dev)');
  assert.equal(GREP_TIMEOUT_MS, 30_000, '기본 상한 30초(S11)');
  const root = await company('rv-s21'); await writeFile(join(root, 'vault', 'e.txt'), `${'a'.repeat(60)}!\n`);
  const srv = await fakeMessages([msg([{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: '(a+)+$', path: 'vault' } }], 'tool_use'), msg([{ type: 'text', text: 'never' }])]);
  try {
    const q = nativeQuery({ wsId: 'rv-s21', slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: env(srv.base), model: 'm', canUseTool: makePermissionGate('rv-s21', 's', root, null, 'ko', []) });
    const p = collect(q); setTimeout(() => q.interrupt(), 400); const t1 = Date.now();
    await assert.rejects(Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('interrupt ignored during Grep')), 8000))]), (e) => e.aborted === true);
    assert.ok(Date.now() - t1 < 6000, '긴 Grep(기본 상한 30초) 중 정지 버튼이 통한다(S21)');
  } finally { await srv.close(); }
});

test('LOW. MCP 접속은 병렬(죽은 서버 2대 ≈ 1대 시간)·전사 머리는 텍스트 user', { skip: !POSIX }, async () => {
  const dead = (n) => ({ command: process.execPath, args: ['-e', `process.title='mcp-dead-${n}-${Date.now()}'; setInterval(() => {}, 1000)`] });
  const t0 = Date.now(); const one = await connectMcpServers({ a: dead(1) }, { timeoutMs: 1200 }); const t1 = Date.now() - t0; await one.close();
  const t2 = Date.now(); const two = await connectMcpServers({ a: dead(2), b: dead(3) }, { timeoutMs: 1200 }); const t3 = Date.now() - t2; await two.close();
  assert.deepEqual(two.statuses.map((s) => s.status), ['failed', 'failed']);
  assert.ok(t3 < t1 + 1200, `병렬 접속: 2대 ${t3}ms vs 1대 ${t1}ms (직렬이면 상한만큼 더 걸린다)`);
  assert.equal(MCP_CONNECT_TIMEOUT_MS, 8_000, '기본 상한 8초(3차 검수 T10 — 테스트가 주입하는 값과 별개로 기본값 경로를 핀)');
  assert.deepEqual(sanitizeTranscript([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, { role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }]),
    [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }], '머리에 tool_result만 든 user가 남지 않는다');
});
