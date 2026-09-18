// 슬랙 채널 턴의 세션 격리를 **실제 SDK로** 돌린다(#596과 같은 계열 — 슬랙 공유 채널은 여러 사람이 본다). 모델만 로컬 가짜 Messages 엔드포인트(ARGO_CLAUDE_BASE_URL — 실자격·비용 0)이고,
// 텔레그램 API는 이 프로세스의 fetch에서 가로챈다(SDK는 자식 프로세스라 영향 없음). 실행 입구는 큐 워커가 부르는 **실제 잡 핸들러**
// (회사 봇 makeTgGatewayHandler → runTurn, 크루 봇 makeTgAgentHandler → runAgentTurn)다.
// 크루 전역 세션은 주인이 데스크톱·1:1에서 나눈 대화다. 그룹 턴이 그것을 이어받으면 주인의 대화가 다른 참여자가 보는 그룹 답에 섞인다.
// 그룹은 그룹 채팅 id 범위 세션을 따로 잇고, 1:1은 설계대로 전역 세션(웹과 같은 스레드)을 잇는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-slack-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-slack-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

let bodies = [];
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      bodies.push(b);
      return sse(res, [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
const tgSent = []; let infoCalls = 0; const infoReqs = [];
// 슬랙 conversations.info 응답(채널 → 응답). 없는 채널은 권한 없음(ok:false) — 사용자 봇 토큰에 *:read가 없을 때의 실제 모양
const kinds = { C0SHARED: { ok: true, channel: { id: 'C0SHARED', is_channel: true, is_im: false } }, C0OTHER: { ok: true, channel: { id: 'C0OTHER', is_channel: true, is_im: false } }, D0OWNER: { ok: true, channel: { id: 'D0OWNER', is_im: true } } };
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('slack.com')) return origFetch(url, opts);
  const u = new URL(String(url));
  if (u.pathname === '/api/conversations.info') {
    // 읽기 메서드 요청 모양을 잠근다 — 쿼리 문자열 GET + Bearer(JSON 본문이면 실제 슬랙이 인자를 못 읽어 판정이 늘 실패 → 모든 1:1이 공유로 떨어진다)
    infoCalls += 1; infoReqs.push({ method: opts?.method ?? 'GET', channel: u.searchParams.get('channel'), auth: opts?.headers?.authorization, body: opts?.body });
    const r = kinds[u.searchParams.get('channel')]; return new Response(JSON.stringify(r ?? { ok: false, error: 'missing_scope' }), { headers: { 'content-type': 'application/json' } });
  }
  const body = JSON.parse(opts?.body ?? '{}'); tgSent.push({ url: String(url), body });
  return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
};
after(() => { srv.close(); globalThis.fetch = origFetch; });

const { createCompany, paths, getDeviceId } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { appendTurn, loadThread } = await import('../src/thread.mjs');
const { _slackForTest: S } = await import('../src/gateway.mjs');
const ws = 'slack-sdk';
await createCompany(ws, '슬랙', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

const PRIVATE = 'OWNER-PRIVATE-DESK-1111';
const GROUP_A = -100111, GROUP_B = -100222;
const sent = () => bodies.join('\n');
// 업그레이드 전 사용자의 스레드 모양 — 전역 세션만 있고 그룹 범위 세션은 없다. 세션은 이 기기에서 실제 SDK로 만든 것이라 resume이 실제로 된다.
async function ownerDesktopHistory() {
  await writeFile(join(p.chats, 'x.json'), JSON.stringify({ sessionId: null, messages: [] }));
  const desk = await chat(ws, 'x', `${PRIVATE} 내 연봉 협상 메모 기억해`, null, {});
  await appendTurn(ws, 'x', { userMsg: `${PRIVATE} 내 연봉 협상 메모 기억해`, reply: desk.reply, sessionId: desk.sessionId });
  const t = await loadThread(ws, 'x');
  assert.equal(t.sessionId, desk.sessionId, '전제: 전역 세션 = 주인의 데스크톱 대화');
  assert.equal(t.sessionDevice, await getDeviceId(), '전제: 이 기기의 세션(같은 기기 resume 갈래)');
  return desk.sessionId;
}
const slack = (channel, text) => S.makeSlackHandler(ws, () => ({ token: 'xoxb-fake', channel, ownerId: 'U1' }))({ text });
const posted = (channel) => tgSent.some((c) => c.url.endsWith('/chat.postMessage') && c.body.channel === channel);

test('실제 SDK 슬랙 공유 채널 턴: 업그레이드 뒤 첫 턴이 주인의 옛 전역 세션을 잇지 않는다 — 요청에 주인 대화가 실리지 않는다', async () => {
  S.slackKinds.clear();
  const deskSid = await ownerDesktopHistory();
  bodies = []; tgSent.length = 0;
  await slack('C0SHARED', '팀 채널에서 오늘 일정 정리해 줘');
  assert.ok(bodies.length >= 1, '실제 SDK가 가짜 엔드포인트로 요청했다');
  assert.ok(posted('C0SHARED'), '답이 그 채널로 나갔다(실제 핸들러 경로)');
  assert.doesNotMatch(sent(), new RegExp(PRIVATE), '슬랙 채널 턴이 주인의 데스크톱 대화를 모델에 실었다');
  assert.equal((await loadThread(ws, 'x')).sessionId, deskSid, '슬랙 채널 턴이 전역 세션을 덮어쓰지 않는다');
});

test('실제 SDK 슬랙: 같은 채널은 채널 세션을 잇고, 다른 채널은 잇지 않는다', async () => {
  S.slackKinds.clear();
  await ownerDesktopHistory();
  await slack('C0SHARED', 'SLACK-SHARED-FIRST-2222 안건 정리');
  bodies = [];
  await slack('C0SHARED', '방금 안건 이어서');
  assert.match(sent(), /SLACK-SHARED-FIRST-2222/, '같은 채널의 다음 턴은 그 채널 대화를 잇는다');
  bodies = [];
  await slack('C0OTHER', '여기는 다른 채널');
  assert.doesNotMatch(sent(), /SLACK-SHARED-FIRST-2222/, '다른 채널의 대화가 실렸다');
  assert.doesNotMatch(sent(), new RegExp(PRIVATE), '다른 채널에도 주인 대화가 실리지 않는다');
});

test('실제 SDK 슬랙: 채널 종류 조회가 실패하면(권한 없음) 공유 채널로 처리한다 — fail-closed', async () => {
  S.slackKinds.clear();
  await ownerDesktopHistory();
  bodies = [];
  await slack('C0NOSCOPE', '권한 없는 봇 토큰의 채널');
  assert.doesNotMatch(sent(), new RegExp(PRIVATE), '판정 실패를 1:1로 취급해 주인 대화를 실었다');
});

test('실제 SDK 슬랙 1:1(is_im): 설계대로 전역 세션(주인 대화)을 잇는다 — 회귀 대조군', async () => {
  S.slackKinds.clear();
  await ownerDesktopHistory();
  bodies = [];
  await slack('D0OWNER', '1:1에서 이어서');
  assert.match(sent(), new RegExp(PRIVATE), '주인 1:1은 데스크톱 대화를 잇는다');
});

test('슬랙 채널 종류 캐시: 같은 채널 두 턴 = 조회 1회, 실패는 1분만 캐시하고 곧 다시 조회한다', async () => {
  S.slackKinds.clear();
  let calls = 0; let fail = true; let t = 1_000;
  const api = async () => { calls += 1; if (fail) throw new Error('slack conversations.info: ratelimited'); return { ok: true, channel: { is_im: true } }; };
  const now = () => t;
  assert.equal(await S.slackIsIm('xoxb', 'D1', { api, now }), false, '실패 = 공유(fail-closed)');
  assert.equal(await S.slackIsIm('xoxb', 'D1', { api, now }), false); assert.equal(calls, 1, '실패도 짧게 캐시(레이트 리밋에 매 턴 재조회하지 않게)');
  fail = false; t += 60_001;
  assert.equal(await S.slackIsIm('xoxb', 'D1', { api, now }), true, '1분 뒤 다시 조회해 1:1을 되찾는다'); assert.equal(calls, 2);
  t += 10 * 86_400_000;
  assert.equal(await S.slackIsIm('xoxb', 'D1', { api, now }), true); assert.equal(calls, 2, '성공은 길게 캐시');
  S.slackKinds.clear(); infoCalls = 0; infoReqs.length = 0;
  await slack('C0SHARED', '첫 턴'); await slack('C0SHARED', '둘째 턴');
  assert.equal(infoCalls, 1, '실제 핸들러: 같은 채널 두 턴에 conversations.info는 한 번');
  assert.deepEqual(infoReqs[0], { method: 'GET', channel: 'C0SHARED', auth: 'Bearer xoxb-fake', body: undefined }, '읽기 메서드는 쿼리 문자열 GET + Bearer(JSON 본문 아님)');
});
