// 메신저 v2 링크 범위 턴의 활동 기록(events.jsonl — 개인 클라우드로 동기화) — SDK 경로(검수 2026-10-23: 팀 방 지시 원문이 gist·msg·steps로 남았다).
// 실제 Claude Agent SDK를 가짜 Messages 엔드포인트로 돌린다(실 모델·네트워크 0). 경우 표는 PR 본문, CLI 경로는 link-turn-events-cli.test.mjs.
// 핀(고치기 전에도 통과): 로컬 턴·개인 공간 링크 턴은 gist·msg·steps를 종전대로 남긴다.
// 고치는 것: 팀 공간·모름·기억 안 남김 링크 턴은 gist = 고정 라벨, msg·steps 없음(stepsTotal 개수만).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const base = await mkdtemp(join(tmpdir(), 'argo-linkev-sdk-'));
const home = join(base, 'home');
Object.assign(process.env, { ARGO_ROOT: join(base, 'root'), HOME: home, USERPROFILE: home, TMPDIR: join(base, 'tmp'),
  ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'ARGO_TENANT_OWNER', 'ARGO_LEDGER_SPLIT']) delete process.env[key];
for (const d of [process.env.ARGO_ROOT, home, process.env.TMPDIR]) await mkdir(d, { recursive: true });
const fetchBefore = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => (String(url).startsWith(process.env.ARGO_CLAUDE_BASE_URL ?? '\0') ? fetchBefore(url, ...rest) : Promise.reject(new Error('Network disabled in link-events test')));

// 가짜 Messages 엔드포인트 — 도구가 실린 요청에서 [BASH]가 있고 아직 도구 결과가 없으면 Bash 한 번, 그 다음은 '네'. [FAIL]이면 400.
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
const srv = http.createServer((req, res) => {
  let b = ''; req.setEncoding('utf8'); req.on('data', (c) => { b += c; });
  req.on('end', () => {
    if (!(req.method === 'POST' && req.url.startsWith('/v1/messages'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const body = JSON.parse(b || '{}');
    const raw = JSON.stringify(body.messages ?? []);
    if (!(body.tools ?? []).length) return sse(res, { text: '네' }); // SDK 제목 생성 등
    if (raw.includes('[FAIL]')) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture failure' } })); }
    if (raw.includes('[BASH]') && !raw.includes('tool_result')) return sse(res, { bash: 'echo STEP_SECRET_CMD' });
    return sse(res, { text: '네' });
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => { srv.close(); globalThis.fetch = fetchBefore; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { readEvents } = await import('../src/events.mjs');

const OWNER = '11111111-1111-4111-8111-111111111111';
const SPACE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROOM = 'dddddddd-0000-4000-8000-000000000001';
const WORK = 'eeeeeeee-0000-4000-8000-000000000001';
let seq = 0;
async function company() {
  const ws = `linkev-sdk-${++seq}`;
  await createCompany(ws, '린', '유건', OWNER, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'sd.md'), '---\nname: 클로드\nrole: 검증\nrunner: claude\n---\n검증용.\n');
  await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 키(요청은 로컬 가짜로만)
  return ws;
}
const link = (extra = {}) => ({ kind: 'scope', scope: { kind: 'link', work: WORK, room: ROOM, owner: true, ...extra } });
const turnRow = async (ws) => (await readEvents(ws, 50)).find((e) => e.type === 'turn');
const rawEvents = async (ws) => JSON.stringify(await readEvents(ws, 50));

test('핀: 로컬(데스크톱) SDK 턴은 gist·msg·steps를 종전대로 남긴다', async () => {
  const ws = await company();
  const r = await chat(ws, 'sd', '[BASH] LOCAL_SECRET 정리해 줘', null, {});
  assert.equal(r.reply.trim(), '네');
  const e = await turnRow(ws);
  assert.equal(e.ok, true);
  assert.match(e.gist, /LOCAL_SECRET/);
  assert.match(e.msg, /LOCAL_SECRET/);
  assert.ok(e.steps?.length >= 1, '도구 단계가 남는다(하네스가 steps를 실제로 만든다는 확인)');
  assert.ok(e.stepsTotal >= 1);
});

test('핀: 개인 공간 링크 턴(주인 1:1)은 종전대로 원문을 남긴다', async () => {
  const ws = await company();
  await chat(ws, 'sd', '[BASH] PERSONAL_SECRET 정리', null, { source: 'messenger', mirrorCtx: link({ space: SPACE, spaceKind: 'personal' }) });
  const e = await turnRow(ws);
  assert.match(e.gist, /PERSONAL_SECRET/);
  assert.match(e.msg, /PERSONAL_SECRET/);
  assert.ok(e.steps?.length >= 1);
});

for (const [name, extra, label] of [
  ['팀 공간', { space: SPACE, spaceKind: 'team' }, '조직 방 지시 (dddddddd)'],
  ['공간 모름(옛 범위·조회 실패)', {}, '메신저 방 지시 (dddddddd)'],
  ['개인 공간 + 기억 안 남김', { space: SPACE, spaceKind: 'personal', memoryOff: true }, '메신저 방 지시 (dddddddd)'],
]) {
  test(`${name} 링크 SDK 턴 — 성공 행은 고정 라벨, msg·steps 없음, 단계 수만`, async () => {
    const ws = await company();
    const r = await chat(ws, 'sd', '[BASH] TEAM_SECRET 회의록 정리', null, { source: 'messenger', mirrorCtx: link(extra) });
    assert.equal(r.reply.trim(), '네', '턴 자체는 그대로');
    const e = await turnRow(ws);
    assert.equal(e.ok, true);
    assert.equal(e.gist, label);
    assert.equal('msg' in e, false);
    assert.equal('steps' in e, false);
    assert.ok(e.stepsTotal >= 1, '개수는 남는다(도구를 실제로 썼다)');
    assert.doesNotMatch(await rawEvents(ws), /TEAM_SECRET|STEP_SECRET_CMD/, '활동 기록 어디에도 원문 없음');
    assert.ok(r.trace?.steps?.length >= 1, '돌려주는 trace(화면 진행 표시)는 그대로');
  });
}

test('팀 공간 링크 SDK 턴 — 실패 행도 고정 라벨, msg·steps 없음(로컬 실패는 종전대로 msg)', async () => {
  const ws = await company();
  await assert.rejects(chat(ws, 'sd', '[FAIL] TEAM_FAIL_SECRET', null, { source: 'messenger', mirrorCtx: link({ space: SPACE, spaceKind: 'team' }) }));
  const e = (await readEvents(ws, 50)).find((x) => x.type === 'turn' && x.ok === false);
  assert.ok(e, '실패 행이 남는다');
  assert.equal(e.gist, '조직 방 지시 (dddddddd)');
  assert.equal('msg' in e, false);
  assert.equal('steps' in e, false);
  assert.doesNotMatch(await rawEvents(ws), /TEAM_FAIL_SECRET/);
  const ws2 = await company();
  await assert.rejects(chat(ws2, 'sd', '[FAIL] LOCAL_FAIL', null, {}));
  const e2 = (await readEvents(ws2, 50)).find((x) => x.type === 'turn' && x.ok === false);
  assert.match(e2.msg, /LOCAL_FAIL/, '핀: 로컬 실패는 원문을 남긴다(재실행의 원천)');
});
