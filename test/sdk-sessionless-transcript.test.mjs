// 세션을 남기지 않는 SDK 턴은 SDK 전사도 디스크에 남기지 않는다(재검수 4차 LOW 2026-10-08) — 실제 Claude Agent SDK(가짜 Messages 엔드포인트)로 돌린다.
// 메신저 DM·기억 안 남김 채널 턴은 다시 잇지 않는데(sessionId=null), SDK 기본값(persistSession: true)은 설정 폴더 projects/ 아래 <세션>.jsonl을 쓴다.
// 그 전사에는 주인 혼자 1:1 턴에 실린 데스크톱 맥락(다른 조직 1:1 줄 포함)이 그대로 들어가고, 세션 id를 기록하지 않아 회수(msgr-recall)가 지우지 못한다.
// 잠그는 행동: ① 데스크톱 턴은 종전대로 전사를 남기고 다음 턴이 그 세션을 잇는다(인접 핀 — 하네스가 전사를 실제로 보는지도 이것으로 확인)
//              ② 메신저 DM 턴·기억 안 남김 채널 턴은 새 전사 0개 ③ 보통 채널 턴은 종전대로 전사를 남긴다(인접 핀).
// HOME·설정 폴더는 임시 폴더다 — 실제 사용자 ~/.claude는 건드리지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const base = await mkdtemp(join(tmpdir(), 'argo-sessionless-'));
const home = join(base, 'home');
Object.assign(process.env, { ARGO_ROOT: join(base, 'root'), HOME: home, USERPROFILE: home, TMPDIR: join(base, 'tmp'),
  ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'ARGO_TENANT_OWNER']) delete process.env[key];
for (const d of [process.env.ARGO_ROOT, home, process.env.TMPDIR]) await mkdir(d, { recursive: true });
const fetchBefore = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => (String(url).startsWith(process.env.ARGO_CLAUDE_BASE_URL ?? '\0') ? fetchBefore(url, ...rest) : Promise.reject(new Error('Network disabled in sessionless test')));

// 가짜 Claude Messages 엔드포인트 — 기본은 짧은 답 '네'. 장면 표지([STEER]·[ABORT])가 있으면 onScene이 고른다(끼워 넣기·중단 경로).
const sse = (res, step) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  if (step.bash) {
    ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `tu${Date.now()}`, name: 'Bash', input: {} } });
    ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: step.bash, description: 'fixture' }) } });
    ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
  } else {
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } });
    ev('content_block_stop', { index: 0 }); ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
  }
  ev('message_stop', {}); res.end();
};
const bodies = {}; // 장면 → 요청 본문(messages JSON) 목록
let onScene = async () => ({ text: '네' });
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', async () => {
    if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    const raw = JSON.stringify(body.messages ?? []);
    const scene = (body.tools ?? []).length ? raw.match(/\[(STEER|ABORT)\]/)?.[1] : null; // 도구 없는 요청 = SDK 제목 생성 — 장면으로 세지 않는다(chat-steer-sdk와 같은 규칙)
    if (!scene) return sse(res, { text: '네' });
    (bodies[scene] ??= []).push(raw);
    return sse(res, await onScene(scene, bodies[scene].length));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); globalThis.fetch = fetchBefore; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { steerTurn, interruptTurn } = await import('../src/turn-abort.mjs');

const OWNER = '11111111-1111-4111-8111-111111111111';
const WS = 'sessionless';
await createCompany(WS, '전사 검수', '유건', OWNER, 'ko');
await mkdir(paths(WS).agents, { recursive: true });
await writeFile(join(paths(WS).agents, 'sd.md'), '---\nname: 클로드\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(WS, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 키(요청은 로컬 가짜로만)

/** 임시 폴더 아래 SDK 전사 전부(<설정 폴더>/projects/<프로젝트>/<세션>.jsonl) — 설정 폴더가 어디로 잡히든(HOME/.claude·~/.argo 격리 폴더) 놓치지 않게 base 전체를 본다 */
async function transcripts(dir = base, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') await transcripts(p, out); } else if (e.name.endsWith('.jsonl') && p.split(/[\\/]/).includes('projects')) out.push(p);
  }
  return out;
}
const msgrCtx = (extra) => ({ kind: 'msgr', orgId: null, uid: OWNER, actor: OWNER, ownerName: '유건', msgId: 1, threadRoot: 1, ...extra });

test('데스크톱 턴은 종전대로 SDK 전사를 남기고, 다음 턴이 그 세션을 잇는다(인접 핀 — 하네스가 전사를 실제로 본다)', async () => {
  const before = (await transcripts()).length;
  const r = await chat(WS, 'sd', '안녕', null, {});
  assert.equal(r.reply.trim(), '네');
  assert.ok(r.sessionId, '세션 id가 돌아온다');
  const after1 = await transcripts();
  assert.ok(after1.length > before, `전사가 생긴다(${before} → ${after1.length})`);
  assert.ok(after1.some((f) => f.endsWith(`${r.sessionId}.jsonl`)), '그 세션의 전사');
  const r2 = await chat(WS, 'sd', '이어서', r.sessionId, {});
  assert.equal(r2.reply.trim(), '네', '저장된 세션을 이어 쓴다(전사가 있어야 resume이 된다)');
  assert.equal(r2.sessionId, r.sessionId, '같은 세션을 이었다(resume이 실패해 새 세션으로 다시 시도해도 답은 "네"라 답만으로는 모른다 — 확인 검수 LOW)');
});

test('메신저 DM 턴(세션을 남기지 않는 턴)은 SDK 전사를 하나도 남기지 않는다', async () => {
  const before = await transcripts();
  const r = await chat(WS, 'sd', '안녕 DM', null, { source: 'messenger', mirrorCtx: msgrCtx({ channelKind: 'dm', channelId: 'dddddddd-0000-4000-8000-000000000001' }) });
  assert.equal(r.reply.trim(), '네', '턴 자체는 그대로 성공한다');
  assert.equal(r.sessionId, null, '전제: 세션을 남기지 않는 턴');
  assert.deepEqual((await transcripts()).filter((f) => !before.includes(f)), [], '새 전사 0개');
});

test('기억 안 남김 채널 턴도 전사를 남기지 않고, 보통 채널 턴은 종전대로 남긴다(인접 핀)', async () => {
  const CH = 'dddddddd-0000-4000-8000-000000000003';
  let before = await transcripts();
  const off = await chat(WS, 'sd', '안녕 채널', null, { source: 'messenger', mirrorCtx: msgrCtx({ channelKind: 'channel', channelId: CH }), journal: { off: true } });
  assert.equal(off.reply.trim(), '네');
  assert.equal(off.sessionId, null, '전제: 세션을 남기지 않는 턴');
  assert.deepEqual((await transcripts()).filter((f) => !before.includes(f)), [], '새 전사 0개');
  before = await transcripts();
  const on = await chat(WS, 'sd', '안녕 채널', null, { source: 'messenger', mirrorCtx: msgrCtx({ channelKind: 'channel', channelId: CH }) });
  assert.ok(on.sessionId, '보통 채널은 채널 세션을 남긴다');
  assert.ok((await transcripts()).filter((f) => !before.includes(f)).length > 0, '전사가 생긴다');
});

// 끼워 넣기·중단은 같은 SDK 프로세스의 입력 통로·interrupt로 돈다 — 전사를 디스크에 안 남겨도 그대로여야 한다(재시도는 sessionId=null로 새로 시작해 전사를 읽지 않는다).
// 도구 없이 답하는 장면을 쓴다 — 메신저 DM 턴은 게이트가 셸 도구를 거절해(방 대화·조직 문서만) 도구 결과 뒤 싣기 대신 답 뒤 이어진 실행으로 실린다.
const DM = () => msgrCtx({ channelKind: 'dm', channelId: 'dddddddd-0000-4000-8000-000000000002' });
test('세션을 남기지 않는 DM 턴 — 답을 쓰는 사이 끼워 넣은 메시지는 같은 실행에서 이어 답하고(답을 합친다), 전사는 남지 않는다', { timeout: 120_000 }, async () => {
  const before = await transcripts();
  onScene = async (scene, n) => {
    if (n === 1) { assert.equal(await steerTurn(WS, 'sd', { source: 'messenger', text: '늦은 끼워 넣기' }), true, '실행 중인 턴이 받는다'); return { text: '첫 답' }; }
    return { text: '이어진 답' };
  };
  const r = await chat(WS, 'sd', '[STEER] 답해', null, { source: 'messenger', mirrorCtx: DM() });
  assert.equal(bodies.STEER.length, 2);
  assert.match(bodies.STEER[1], /늦은 끼워 넣기/, '끼워 넣은 메시지가 같은 실행의 다음 요청에 실렸다');
  assert.equal(r.reply, '첫 답\n\n이어진 답');
  assert.deepEqual((await transcripts()).filter((f) => !before.includes(f)), [], '새 전사 0개');
});

test('세션을 남기지 않는 DM 턴 — 응답을 기다리는 중에 중단하면 중단으로 끝나고, 전사는 남지 않는다', { timeout: 120_000 }, async () => {
  const before = await transcripts();
  onScene = async (scene, n) => {
    if (n === 1) { setTimeout(() => { interruptTurn(WS, 'sd', { source: 'messenger' }).catch(() => {}); }, 200); await new Promise((r) => setTimeout(r, 3000)); }
    return { text: '중단 뒤에 나오면 안 되는 답' };
  };
  await assert.rejects(chat(WS, 'sd', '[ABORT] 오래 걸리는 작업', null, { source: 'messenger', mirrorCtx: DM() }), (e) => e?.aborted === true);
  assert.deepEqual((await transcripts()).filter((f) => !before.includes(f)), [], '새 전사 0개');
});
