// 네이티브 엔진(하네스 통일 P-A) — 가짜 Messages 서버로 도구 왕복·게이트·크루 도구·오류 매핑·재시도·중단·세션 재개를 행동으로 잠근다.
// 실벤더 호출 0. ARGO_ROOT·HOME은 임시(스위프 규칙).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-native-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-native-'));
process.env.ARGO_MODEL_CATALOG = 'off';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const { nativeQuery, nativeRunnerEnabled, crewToolSpecs, NATIVE_DEFAULT_MAX_TOKENS } = await import('../src/engine/native-query.mjs');
const { authFromEnv, extractErrorMessage, callMessages } = await import('../src/engine/messages-http.mjs');
const { builtinRunners, shellEnv, BUILTIN_SPECS } = await import('../src/engine/builtin-tools.mjs');
const { trimMessages, sessionFile } = await import('../src/engine/session.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');
const { classifyRunnerError } = await import('../src/runners/error-class.mjs');

/** 가짜 Messages 서버 — script[i]가 i번째 요청의 응답(함수면 body를 받아 {status, json}을 돌려준다). 요청 본문을 기록한다. */
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
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, bodies, close: () => new Promise((r) => srv.close(r)) };
}
const msg = (content, stop = 'end_turn', model = 'fake-model') => ({ id: 'm', type: 'message', role: 'assistant', model, content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });
const env = (base) => ({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'tok-fake-1234567890', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
async function collect(q) { const out = []; for await (const m of q) out.push(m); return out; }

test('E1. authFromEnv — Bearer/x-api-key 매핑, 구독 OAuth 거절, 오류 message 추출', () => {
  assert.deepEqual(authFromEnv({ ANTHROPIC_BASE_URL: 'https://x/api/', ANTHROPIC_AUTH_TOKEN: 't' }), { base: 'https://x/api', headers: { authorization: 'Bearer t' } });
  assert.deepEqual(authFromEnv({ ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_API_KEY: 'k' }), { base: 'https://x', headers: { 'x-api-key': 'k' } });
  assert.throws(() => authFromEnv({ ANTHROPIC_BASE_URL: 'https://x', CLAUDE_CODE_OAUTH_TOKEN: 'o' }), /구독 로그인/);
  assert.throws(() => authFromEnv({ ANTHROPIC_BASE_URL: 'https://x', CLAUDE_CODE_OAUTH_TOKEN: 'o' }, 'en'), /subscription login/);
  assert.throws(() => authFromEnv({ ANTHROPIC_BASE_URL: 'https://x' }), /자격이 없습니다/);
  assert.equal(extractErrorMessage('{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'), 'invalid x-api-key');
  assert.equal(extractErrorMessage('<html>bad gateway</html>'), '<html>bad gateway</html>');
  assert.equal(nativeRunnerEnabled('openrouter', { ARGO_NATIVE_RUNNERS: 'openrouter, glm' }), true);
  assert.equal(nativeRunnerEnabled('claude', { ARGO_NATIVE_RUNNERS: 'openrouter, glm' }), false);
  assert.equal(nativeRunnerEnabled('glm', {}), false, '기본 off — 구 경로(SDK)');
});

test('E2. 루프 — Read 왕복 → 금지 구역 Write는 게이트 deny → 크루 도구(결재) 실호출 → 최종 답변; SDK와 같은 스트림·세션 영속·max_tokens 기본', async () => {
  const ws = 'native-e2'; await createCompany(ws, '네이티브', '사장');
  const root = paths(ws).root; await mkdir(join(root, 'vault'), { recursive: true });
  await writeFile(join(root, 'vault', 'note.md'), 'hello native\n');
  const { makeCrewServer } = await import('../src/chat.mjs');
  const sink = []; makeCrewServer(ws, 'seoyun', '서윤', [], 0, [], null, 'ko', [], '', sink);
  assert.ok(sink.some((d) => d.name === 'request_approval'), 'sink에 크루 도구 정의가 모인다');
  const srv = await fakeMessages([
    msg([{ type: 'text', text: '읽어볼게' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'vault/note.md' } }], 'tool_use'),
    msg([
      { type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '.secrets.json', content: '{}' } },
      { type: 'tool_use', id: 'tu3', name: 'mcp__crew__request_approval', input: { action: '메일 발송', reason: '테스트' } },
    ], 'tool_use'),
    msg([{ type: 'text', text: '끝. 결재 올렸어.' }]),
  ]);
  try {
    const q = nativeQuery({ wsId: ws, slug: 'seoyun', prompt: '노트 읽고 시크릿에 써봐', cwd: root, systemPrompt: 'SYS', env: env(srv.base), model: 'fake-model',
      crewTools: sink, canUseTool: makePermissionGate(ws, 'seoyun', root, null, 'ko', []) });
    const out = await collect(q);
    assert.deepEqual(out.map((m) => m.type), ['system', 'assistant', 'assistant', 'assistant', 'result'], 'SDK query()와 같은 스트림 형태');
    assert.equal(out[0].subtype, 'init'); assert.ok(out[0].session_id.startsWith('native-')); assert.deepEqual(out[0].mcp_servers, [{ name: 'crew', status: 'connected' }]);
    const r = out.at(-1); assert.equal(r.subtype, 'success'); assert.equal(r.result, '끝. 결재 올렸어.'); assert.equal(r.total_cost_usd, null); assert.equal(r.usage.input_tokens, 30); assert.equal(r.num_turns, 3);
    // 요청 본문 — 도구 사양(내장 7 + 크루), system, max_tokens 기본
    const b1 = srv.bodies[0].body;
    assert.equal(b1.system, 'SYS'); assert.equal(b1.max_tokens, 8192, 'max_tokens 기본 8192 — SDK의 32000이 OpenRouter 선불 잔액 402(716토큰만 감당)를 부르던 실측 완화. 상수와 비교하면 동어반복(변이 N7 green)'); assert.equal(b1.model, 'fake-model');
    assert.equal(srv.bodies[0].headers.authorization, 'Bearer tok-fake-1234567890');
    for (const n of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'mcp__crew__request_approval']) assert.ok(b1.tools.some((t) => t.name === n), `도구 ${n}`);
    assert.equal(srv.bodies[0].headers['anthropic-version'], '2023-06-01', 'Messages API 버전 헤더');
    for (const ghost of ['mcp__crew__delegate', 'mcp__crew__send_to_crew', 'mcp__crew__use_connector']) assert.ok(!b1.tools.some((t) => t.name === ghost), `동료 0·커넥터 0에서 유령 도구 금지: ${ghost}`);
    // 2번째 요청 = Read 결과(파일 내용·줄번호) 회신
    const tr1 = srv.bodies[1].body.messages.at(-1); assert.equal(tr1.role, 'user'); assert.equal(tr1.content[0].tool_use_id, 'tu1'); assert.match(tr1.content[0].content, /1\thello native/);
    // 3번째 요청 = 게이트 deny(is_error + 금지 문구) + 결재 등록 결과
    const tr2 = srv.bodies[2].body.messages.at(-1);
    const deny = tr2.content.find((c) => c.tool_use_id === 'tu2'); assert.equal(deny.is_error, true); assert.ok(deny.content.length > 5 && !/^Wrote /.test(deny.content), '게이트 문구가 모델에 돌아간다');
    await assert.rejects(readFile(join(root, '.secrets.json')), '금지 구역 쓰기가 실제로 일어나지 않았다(행동)');
    const appr = tr2.content.find((c) => c.tool_use_id === 'tu3'); assert.equal(appr.is_error, undefined); assert.match(appr.content, /결재 요청이 등록/);
    assert.ok((await readFile(paths(ws).approvals, 'utf8')).includes('메일 발송'), '결재함 파일에 실제 등록(같은 핸들러)');
    // 세션 영속 — 전사가 파일에 남고 id가 일치
    const sess = JSON.parse(await readFile(sessionFile(ws, 'seoyun'), 'utf8')); assert.equal(sess.id, out[0].session_id); assert.equal(sess.messages.length, 6);
    // 재개 — resume id가 같으면 이어서(서버가 받는 messages가 이전 전사 + 새 지시)
    const srv2 = await fakeMessages([msg([{ type: 'text', text: '이어서' }])]);
    try {
      const out2 = await collect(nativeQuery({ wsId: ws, slug: 'seoyun', prompt: '다음', cwd: root, systemPrompt: 'SYS', env: env(srv2.base), model: 'fake-model', crewTools: sink, resume: sess.id }));
      assert.equal(out2[0].session_id, sess.id, '같은 세션 이어감'); assert.equal(srv2.bodies[0].body.messages.length, 7);
      const out3 = await collect(nativeQuery({ wsId: ws, slug: 'seoyun', prompt: '새로', cwd: root, systemPrompt: 'SYS', env: env(srv2.base), model: 'fake-model', crewTools: sink, resume: 'native-other-device' }));
      assert.notEqual(out3[0].session_id, sess.id, '모르는 resume id면 새 세션(턴이 죽지 않는다)');
    } finally { await srv2.close(); }
  } finally { await srv.close(); }
});

test('E3. 오류 매핑 — 401/402/529는 `API Error: <status> <message>`로 던져 error-class·자가치유 정규식이 문다; 5xx는 1회 재시도', async () => {
  const ws = 'native-e3'; await createCompany(ws, '오류', '사장'); const root = paths(ws).root;
  for (const [status, code] of [[401, 'auth_expired'], [402, 'quota'], [429, 'quota']]) {
    const srv = await fakeMessages([{ status, json: { error: { type: 'x', message: status === 401 ? 'invalid api key' : 'insufficient credits' } } }]);
    try {
      await assert.rejects(collect(nativeQuery({ wsId: ws, slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: env(srv.base), model: 'm', saveSession: false })),
        (e) => { assert.match(e.message, new RegExp(`^API Error: ${status} `)); assert.equal(e.status, status); assert.equal(classifyRunnerError(e.message).code, code); return true; });
      assert.equal(srv.bodies.length, 1, `${status}은 재시도하지 않는다(죽은 자격 재발사 금지 — 불변식 A)`);
    } finally { await srv.close(); }
  }
  const srv = await fakeMessages([{ status: 529, json: { error: { message: 'Overloaded' } } }, msg([{ type: 'text', text: 'ok after retry' }])]);
  try {
    const out = await collect(nativeQuery({ wsId: ws, slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: env(srv.base), model: 'm', saveSession: false }));
    assert.equal(out.at(-1).result, 'ok after retry'); assert.equal(srv.bodies.length, 2, '과부하 1회 재시도');
  } finally { await srv.close(); }
});

test('E4. 중단 — interrupt()는 aborted 오류로 끝난다(사장 정지 버튼 계약)', async () => {
  const ws = 'native-e4'; await createCompany(ws, '중단', '사장'); const root = paths(ws).root;
  const srv = await fakeMessages([() => new Promise(() => {})]); // 응답 없음
  const slow = createServer((req, res) => { /* 영원히 대기 */ }); await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    const q = nativeQuery({ wsId: ws, slug: 's', prompt: 'x', cwd: root, systemPrompt: '', env: env(`http://127.0.0.1:${slow.address().port}`), model: 'm', saveSession: false });
    const p = collect(q); setTimeout(() => q.interrupt(), 150);
    // 중단이 무시되면 영원히 대기한다(변이 배터리 실사고 2026-09-05: 10분 상한까지 hang) → 5초 상한으로 red가 되게
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('interrupt ignored — still running after 5s')), 5000));
    await assert.rejects(Promise.race([p, timeout]), (e) => e.aborted === true);
  } finally { slow.close(); await srv.close(); }
});

test('E5. 내장 도구 — Read 줄번호·Edit 유일성·Glob·Grep 모드·Bash 종료코드/시간초과·WebFetch·셸 env 세척', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'argo-native-tools-'));
  await mkdir(join(cwd, 'a', 'b'), { recursive: true });
  await writeFile(join(cwd, 'a', 'x.md'), 'alpha\nbeta\nalpha\n'); await writeFile(join(cwd, 'a', 'b', 'y.txt'), 'gamma\n');
  const t = builtinRunners({ cwd, env: { PATH: process.env.PATH, ANTHROPIC_AUTH_TOKEN: 'leak', HOME: process.env.HOME } });
  assert.equal(await t.Read({ file_path: 'a/x.md', offset: 2, limit: 1 }), '2\tbeta\n…[1 more lines]', 'offset은 Claude Code와 같은 1-based');
  await assert.rejects(t.Edit({ file_path: 'a/x.md', old_string: 'alpha', new_string: 'z' }), /matches 2 times/);
  assert.match(await t.Edit({ file_path: 'a/x.md', old_string: 'alpha', new_string: 'z', replace_all: true }), /2 replacements/);
  assert.equal((await t.Glob({ pattern: '**/*.md' })).trim(), 'a/x.md');
  assert.equal(await t.Grep({ pattern: 'gamma' }), 'a/b/y.txt');
  assert.equal(await t.Grep({ pattern: '^z', path: 'a', output_mode: 'count' }), 'x.md:2');
  assert.match(await t.Grep({ pattern: 'GAMMA', '-i': true, output_mode: 'content' }), /a\/b\/y\.txt:1:gamma/);
  assert.match(await t.Write({ file_path: 'new/dir/f.txt', content: 'hi' }), /Wrote 2 bytes/);
  if (process.platform !== 'win32') {
    assert.match(await t.Bash({ command: 'echo $ANTHROPIC_AUTH_TOKEN-x; exit 3' }), /^-x\n\n\[exit 3\]$/, '자격 env 미상속 + 종료 코드');
    assert.match(await t.Bash({ command: 'sleep 5', timeout: 1000 }), /\[timeout after 1000ms\]/);
  }
  assert.equal(shellEnv({ ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'b', CLAUDE_CONFIG_DIR: 'c', PATH: 'p' }).PATH, 'p');
  assert.deepEqual(Object.keys(shellEnv({ ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'b', CLAUDE_CONFIG_DIR: 'c', PATH: 'p' })), ['PATH']);
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><script>x()</script><p>Hello <b>web</b></p></html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { assert.match(await t.WebFetch({ url: `http://127.0.0.1:${srv.address().port}/` }), /^HTTP 200\nHello web$/); } finally { srv.close(); }
  assert.deepEqual(BUILTIN_SPECS.map((s) => s.name), ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'], 'Claude Code와 같은 이름 — permission-gate readToolTargets 호환');
});

test('E6. 세션 절단·크루 도구 스키마 — tool_result만 남는 머리는 버린다, zod→JSON 스키마 변환·입력 검증', async () => {
  const big = 'x'.repeat(1000);
  const msgs = [];
  for (let i = 0; i < 600; i++) msgs.push({ role: 'user', content: `u${i} ${big}` }, { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] });
  const out = trimMessages(msgs, 400_000, 300_000);
  assert.ok(JSON.stringify(out).length <= 300_000 && out.length < msgs.length);
  assert.equal(out[0].role, 'user'); assert.equal(typeof out[0].content, 'string', '머리가 tool_result만인 user 메시지가 아니다');
  const { z } = await import('zod');
  const [spec] = crewToolSpecs([{ name: 'ping', description: 'd', shape: { n: z.number(), s: z.string().optional() }, handler: async ({ n }) => ({ content: [{ type: 'text', text: `pong ${n}` }] }) }]);
  assert.equal(spec.name, 'mcp__crew__ping'); assert.deepEqual(spec.input_schema.required, ['n']); assert.equal(spec.input_schema.$schema, undefined);
  assert.equal(await spec.run({ n: 2 }), 'pong 2');
  await assert.rejects(spec.run({ n: 'x' }), /invalid input: n/);
});

test('E7. 배선 핀 — chat.mjs가 플래그 러너를 nativeQuery로 갈라 같은 프롬프트 꼬리·모델·게이트·크루 도구를 넘긴다', async () => {
  const src = await readFile(join(ROOT, 'src', 'chat.mjs'), 'utf8');
  assert.match(src, /import \{ query, createSdkMcpServer, tool as sdkTool \} from '@anthropic-ai\/claude-agent-sdk';/);
  assert.match(src, /const tool = \(name, description, shape, handler\) => \{ const t = sdkTool\(name, description, shape, handler\); if \(sink\) defs\.set\(t, \{ name, description, shape, handler \}\); return t; \};/, 'sink 정의 수집(WeakMap) — 등재는 최종 배열에서');
  assert.match(src, /const nativeOn = nativeRunnerEnabled\(runner\);\n\s*const crewSink = nativeOn \? \[\] : null;\n\s*const crewServer = makeCrewServer\([^\n]*workFolder, crewSink\);/);
  const branch = src.split('const q = nativeOn ? nativeQuery({')[1]?.split('}) : query({')[0] ?? '';
  assert.ok(branch, 'q 분기가 존재');
  for (const re of [/systemPrompt: systemPromptFor\(md, p\.root, skills, meta, lang\) \+ sysTail/, /env: sdkEnv, model: sdkModel, crewTools: crewSink, mcpServers: servers \?\? \{\}/, /canUseTool: makePermissionGate\(wsId, agentSlug, p\.root, chain\.length \? chain\[chain\.length - 1\] : null, lang, workRoots\)/, /resume: resumeId/, /prompt: promptBlocks \?\? promptText/]) assert.match(branch, re);
  assert.equal((src.match(/systemPromptFor\(md, p\.root, skills, meta, lang\) \+ sysTail/g) ?? []).length, 2, '두 엔진이 같은 프롬프트 꼬리');
  assert.equal((src.match(/\.\.\.\(sdkModel \? \{ model: sdkModel \} : \{\}\)/g) ?? []).length, 1, 'SDK 경로도 같은 모델 선택식');
  assert.match(src, /abortReg = registerTurn\(wsId, agentSlug, \(\) => q\.interrupt\(\)\);/, '중단 핸들은 두 엔진 공통 계약');
});
