// Claude 턴은 사용자 ~/.claude에 대화 전사를 남기지 않는다(2026-10-15 제보: ChatGPT 'Claude 정보 가져오기'에 "Argo" 대화 수십 개).
// 실제 SDK CLI 턴을 로컬 가짜 Messages 끝점(ARGO_CLAUDE_BASE_URL)으로 돌려, 임시 HOME의 파일 목록을 턴 전후로 비교한다(실자격·비용 0).
// 잠그는 경우 표(자격 3종 × OS):
//  A1 API 키 · A2 구독 토큰 — 모든 OS에서 격리(~/.argo/claude-config-cl-<회사>), 인증 헤더 그대로
//  A3 이 컴퓨터 로그인(host, 파일 저장소) — 맥·리눅스는 격리하고 로그인 유지, 윈도우는 종전 유지(자격 증명 관리자 미검증)
//     맥 실행에서는 턴을 건너뛴다 — CLI가 실제 로그인 키체인 항목을 먼저 찾으므로 시험이 사용자 자격에 닿지 않게(맥 키체인은 병합 전 실턴으로 확인)
//  B1 옛 ~/.claude 세션 이어 쓰기 — 격리 폴더로 복사해 맥락 유지, 원본 보존 · B2 어디에도 없음 — 새 세션 재시도 · B3 이미 있음 — 덮지 않음
//  C1 세션을 남기지 않는 턴(persistSession:false) — ~/.claude에 .claude.json도 안 남김 · C2 메신저 회수가 격리 폴더 전사를 찾아 지움
//  D1 호환 러너(glm)는 종전 격리 폴더(ws-·hostfb-) 그대로
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-cfgiso-'));
const home = await mkdtemp(join(tmpdir(), 'argo-cfgiso-home-'));
process.env.HOME = process.env.USERPROFILE = home;
Object.assign(process.env, { ARGO_ROOT: root, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete process.env[k];

const reqs = []; // [인증 방식, 요청 messages 수]
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const srv = http.createServer((req, res) => {
  let b = ''; req.setEncoding('utf8'); req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      reqs.push([req.headers['x-api-key'] ? 'apikey' : req.headers.authorization ? 'bearer' : 'none', JSON.parse(b || '{}').messages?.length ?? 0]);
      return sse(res, [['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred, sdkEnvFor } = await import('../src/runners/creds.mjs');
const { claudeConfigEnv, adoptLegacyTranscript } = await import('../src/runners/claude-config.mjs');
const { chat } = await import('../src/chat.mjs');
const { sdkConfigDirs, dropTranscripts } = await import('../src/gateway/msgr-recall.mjs');
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { invalidateDetectCache } = await import('../src/runners.mjs');

const userClaude = join(home, '.claude');
const isoDir = (ws) => join(home, '.argo', `claude-config-cl-${ws}`);
async function walk(d) { const out = []; let es = []; try { es = await readdir(d, { withFileTypes: true }); } catch { return out; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) out.push(...await walk(p)); else out.push(p); } return out; }
const homeFiles = async () => new Map(await Promise.all((await walk(home)).map(async (p) => { const s = await stat(p); return [relative(home, p).split(sep).join('/'), `${s.mtimeMs}:${s.size}`]; })));
/** 사용자 Claude 자리(~/.claude 아래·~/.claude.json)에 새로 생겼거나 바뀐 파일 — 앞 시험이 만든 파일을 다시 고쳐 쓰는 것도 잡는다 */
const newUserClaude = (before, after) => [...after].filter(([p, v]) => before.get(p) !== v && (p.startsWith('.claude/') || p === '.claude.json')).map(([p]) => p);
const transcriptsIn = async (dir) => (await walk(join(dir, 'projects'))).filter((p) => p.endsWith('.jsonl'));

async function company(ws, type, value) {
  await createCompany(ws, ws, 'owner', null, 'ko');
  await writeFile(join(paths(ws).agents, 'pepper.md'), '---\nname: 페퍼\nrole: 비서\nrunner: claude\n---\n페퍼\n');
  await saveRunnerCred(ws, 'claude', type, value);
}
async function turn(ws, msg = '안녕', sid = null) {
  const before = await homeFiles(); const r0 = reqs.length;
  const r = await chat(ws, 'pepper', msg, sid, {});
  return { r, added: newUserClaude(before, await homeFiles()), reqs: reqs.slice(r0) };
}
const APIKEY = `sk-ant-api03-${'x'.repeat(80)}`; // 형식만 맞춘 가짜 — 요청은 로컬 가짜 끝점으로만 간다
const OAUTH = `sk-ant-oat01-${'y'.repeat(80)}`;

test('A1 API 키 턴 — ~/.claude에 아무것도 남기지 않고 전사는 회사 격리 폴더에, 인증은 x-api-key 그대로', async () => {
  await company('iso-a1', 'apikey', APIKEY);
  const t = await turn('iso-a1');
  assert.equal(t.r.reply, 'done');
  assert.deepEqual(t.added, []);
  assert.equal((await transcriptsIn(isoDir('iso-a1'))).length, 1);
  assert.equal(t.reqs.at(-1)[0], 'apikey');
});

test('A2 구독 토큰 턴 — 같은 격리, 인증은 bearer 그대로', async () => {
  await company('iso-a2', 'oauth', OAUTH);
  const t = await turn('iso-a2');
  assert.equal(t.r.reply, 'done');
  assert.deepEqual(t.added, []);
  assert.equal((await transcriptsIn(isoDir('iso-a2'))).length, 1);
  assert.equal(t.reqs.at(-1)[0], 'bearer');
});

test('A3 이 컴퓨터 로그인(host) — 맥·리눅스는 격리하고 env에 자격 저장소 고정값, 윈도우는 종전 유지', async () => {
  // env 모양은 OS 분기를 직접 본다(순수) — 실행 OS와 무관하게 세 갈래 모두 잠근다
  assert.deepEqual(claudeConfigEnv('w', { tokenCred: false, platform: 'win32' }), {});
  for (const platform of ['darwin', 'linux']) {
    const e = claudeConfigEnv('w', { tokenCred: false, platform });
    assert.equal(e.CLAUDE_CONFIG_DIR, isoDir('w'));
    assert.equal(e.CLAUDE_SECURESTORAGE_CONFIG_DIR, ''); // 빠지면 host 로그인이 끊긴다(임시 HOME 실측 "Not logged in")
  }
  for (const platform of ['darwin', 'linux', 'win32']) assert.equal(claudeConfigEnv('w', { tokenCred: true, platform }).CLAUDE_CONFIG_DIR, isoDir('w'));
  await company('iso-a3', 'host', 'host');
  const env = await sdkEnvFor('iso-a3', 'claude');
  if (process.platform === 'win32') assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  else { assert.equal(env.CLAUDE_CONFIG_DIR, isoDir('iso-a3')); assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, ''); }
});

test('A3 host 실턴(파일 저장소 ~/.claude/.credentials.json) — 리눅스: 로그인 유지 + 격리 / 윈도우: 종전대로 ~/.claude', { skip: process.platform === 'darwin' && '맥은 CLI가 실제 로그인 키체인을 먼저 찾는다 — 병합 전 실턴으로 확인' }, async () => {
  await mkdir(userClaude, { recursive: true });
  await writeFile(join(userClaude, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-${'z'.repeat(80)}`, refreshToken: `sk-ant-ort01-${'r'.repeat(80)}`, expiresAt: Date.now() + 3600e3, scopes: ['user:inference', 'user:profile'], subscriptionType: 'pro' } }));
  await company('iso-a3t', 'host', 'host');
  invalidateDetectCache(); // 앞 시험(A1·A2 턴)이 로그인 파일 없을 때의 감지 결과를 캐시해 두면 15초 재확인 전까지 host를 미연결로 본다(윈도우 CI 'AI 러너가 하나도 연결돼 있지 않습니다') — 사용자가 터미널에서 로그인한 뒤 재확인이 지난 상태로 맞춘다
  process.env.ANTHROPIC_BASE_URL = process.env.ARGO_CLAUDE_BASE_URL; // host는 env를 주입하지 않는다 — 가짜 끝점으로 보내려면 호스트 env로
  try {
    const t = await turn('iso-a3t');
    assert.equal(t.r.reply, 'done');
    assert.equal(t.reqs.at(-1)[0], 'bearer');
    if (process.platform === 'win32') assert.equal((await transcriptsIn(userClaude)).some((p) => p.includes('iso-a3t')), true);
    else { assert.deepEqual(t.added, []); assert.equal((await transcriptsIn(isoDir('iso-a3t'))).length, 1); }
  } finally { delete process.env.ANTHROPIC_BASE_URL; await rm(join(userClaude, '.credentials.json'), { force: true }); }
});

test('B1 옛 ~/.claude 세션(새 앱 + 옛 데이터) 이어 쓰기 — 격리 폴더로 복사해 같은 세션·맥락 유지, 원본 보존', async () => {
  await company('iso-b1', 'apikey', APIKEY);
  const t1 = await turn('iso-b1');
  const sid = t1.r.sessionId;
  // 격리 전 버전이 남긴 모양으로 옮긴다 — 전사가 ~/.claude/projects/<작업 폴더>/에만 있다
  const [f] = (await walk(home)).filter((p) => p.endsWith(`${sid}.jsonl`));
  const proj = f.split(sep).at(-2);
  await mkdir(join(userClaude, 'projects', proj), { recursive: true });
  const legacy = join(userClaude, 'projects', proj, `${sid}.jsonl`);
  if (f !== legacy) { await rename(f, legacy); }
  const before = await readFile(legacy, 'utf8');
  const t2 = await turn('iso-b1', '두번째', sid);
  assert.equal(t2.r.sessionId, sid);           // 새 세션으로 끊기지 않았다
  const turnMsgs = (t) => Math.max(...t.reqs.map((r) => r[1])); // 턴 뒤 한 메시지짜리 부속 요청이 따라오므로 본 요청(가장 긴 것)을 본다
  assert.ok(turnMsgs(t2) > turnMsgs(t1)); // 1턴 대화가 2턴 요청에 실렸다 = 맥락 유지(복사 없이 새 세션이면 같다)
  assert.equal(await readFile(legacy, 'utf8'), before); // 원본은 그대로(사용자 데이터 — 지우지도 고치지도 않는다)
  assert.deepEqual(t2.added, []);
});

test('B2 이을 세션이 어디에도 없음(다른 기기) — 종전처럼 새 세션으로 답한다', async () => {
  await company('iso-b2', 'apikey', APIKEY);
  const ghost = '11111111-2222-4333-8444-555555555555';
  const t = await turn('iso-b2', '안녕', ghost);
  assert.equal(t.r.reply, 'done');
  assert.notEqual(t.r.sessionId, ghost);
  assert.deepEqual(t.added, []);
});

test('B3 격리 폴더에 이미 있으면 복사하지 않는다(덮어쓰기 0) · 이상한 id는 무시 · 복사 실패는 던지지 않는다', async () => {
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const to = join(home, 'b3-to');
  await mkdir(join(to, 'projects', 'p'), { recursive: true }); await writeFile(join(to, 'projects', 'p', `${sid}.jsonl`), 'NEW');
  await mkdir(join(userClaude, 'projects', 'p'), { recursive: true }); await writeFile(join(userClaude, 'projects', 'p', `${sid}.jsonl`), 'OLD');
  assert.equal(await adoptLegacyTranscript(to, sid), false);
  assert.equal(await readFile(join(to, 'projects', 'p', `${sid}.jsonl`), 'utf8'), 'NEW');
  assert.equal(await adoptLegacyTranscript(to, '../../etc/passwd'), false);
  // 새 폴더 자리에 파일이 있어 mkdir이 실패하는 경우 — false, 예외 없음
  const sid2 = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
  await writeFile(join(userClaude, 'projects', 'p', `${sid2}.jsonl`), 'OLD2');
  const blocked = join(home, 'b3-blocked'); await writeFile(blocked, 'x');
  assert.equal(await adoptLegacyTranscript(blocked, sid2), false);
  // 서브에이전트 폴더(같은 이름)도 같이 복사, 원본은 남는다
  const to2 = join(home, 'b3-to2');
  await mkdir(join(userClaude, 'projects', 'p', sid2, 'subagents'), { recursive: true }); await writeFile(join(userClaude, 'projects', 'p', sid2, 'subagents', 'a.jsonl'), 'S');
  assert.equal(await adoptLegacyTranscript(to2, sid2), true);
  assert.equal(await readFile(join(to2, 'projects', 'p', sid2, 'subagents', 'a.jsonl'), 'utf8'), 'S');
  assert.equal((await stat(join(userClaude, 'projects', 'p', `${sid2}.jsonl`))).isFile(), true);
});

test('C1 세션을 남기지 않는 턴(persistSession:false) — sdkEnvFor env로 돌리면 ~/.claude·~/.claude.json에 아무것도 없다', async () => {
  await company('iso-c1', 'apikey', APIKEY);
  const env = await sdkEnvFor('iso-c1', 'claude');
  const before = await homeFiles();
  for await (const m of query({ prompt: 'hi', options: { cwd: paths('iso-c1').root, env, settingSources: [], persistSession: false, maxTurns: 1 } })) if (m.type === 'result') assert.equal(m.subtype, 'success');
  assert.deepEqual(newUserClaude(before, await homeFiles()), []);
  assert.equal((await transcriptsIn(isoDir('iso-c1'))).length, 0);
});

test('C2 메신저 회수 — 전사 폴더 후보에 격리 폴더가 들고, 그 안의 전사를 지운다', async () => {
  await company('iso-c2', 'apikey', APIKEY);
  const t = await turn('iso-c2');
  assert.ok((await sdkConfigDirs()).includes(isoDir('iso-c2')));
  assert.equal((await transcriptsIn(isoDir('iso-c2'))).length, 1);
  assert.ok(await dropTranscripts('iso-c2', 'pepper', [t.r.sessionId]) >= 1);
  assert.equal((await transcriptsIn(isoDir('iso-c2'))).length, 0);
});

test('D1 호환 러너(glm)는 종전 격리 폴더 그대로 — claude 격리 폴더(cl-)를 쓰지 않는다', async () => {
  await createCompany('iso-d1', 'iso-d1', 'owner', null, 'ko');
  await saveRunnerCred('iso-d1', 'glm', 'apikey', 'g'.repeat(40));
  const env = await sdkEnvFor('iso-d1', 'glm');
  assert.equal(env.CLAUDE_CONFIG_DIR, join(home, '.argo', 'claude-config-ws-iso-d1'));
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
});
