// 텔레그램 그룹 턴의 세션 격리를 **실제 SDK로** 돌린다. 모델만 로컬 가짜 Messages 엔드포인트(ARGO_CLAUDE_BASE_URL — 실자격·비용 0)이고,
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

const root = await mkdtemp(join(tmpdir(), 'argo-tg-group-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-tg-group-sdk-home-'));
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
const tgSent = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('api.telegram.org')) return origFetch(url, opts);
  tgSent.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
  return new Response('{"ok":true,"result":{}}', { headers: { 'content-type': 'application/json' } });
};
after(() => { srv.close(); globalThis.fetch = origFetch; });

const { createCompany, paths, getDeviceId } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { appendTurn, loadThread } = await import('../src/thread.mjs');
const { _tgHandlersForTest: H } = await import('../src/gateway.mjs');
const ws = 'tg-group-sdk';
await createCompany(ws, '텔레그램 그룹', 'owner', null, 'ko');
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
const crewBot = (chatId, chatType, text) => H.makeTgAgentHandler(ws, 'x', () => ({ token: 'bot-x', ownerId: 1, ownerChat: '200' }))({ text, atts: [], ctx: { chatId, chatType } });
const companyBot = (chatId, chatType, text) => H.makeTgGatewayHandler(ws, () => ({ token: 'bot-co', chatId: String(chatId), ownerId: 1 }))({ text, atts: [], ctx: { chatId, chatType } });

for (const [name, run] of [['크루 봇', crewBot], ['회사 봇', companyBot]]) {
  test(`실제 SDK ${name} 그룹 턴: 업그레이드 뒤 첫 그룹 턴이 주인의 옛 전역 세션을 잇지 않는다 — 그룹 답 요청에 주인 대화가 실리지 않는다`, async () => {
    const deskSid = await ownerDesktopHistory();
    bodies = []; tgSent.length = 0;
    await run(GROUP_A, 'supergroup', '다들 안녕, 오늘 일정 정리해 줘');
    assert.ok(bodies.length >= 1, '실제 SDK가 가짜 엔드포인트로 요청했다');
    assert.ok(tgSent.some((c) => c.url.includes('/sendMessage') && String(c.body.chat_id) === String(GROUP_A)), '답이 그룹으로 나갔다(실제 핸들러 경로)');
    assert.doesNotMatch(sent(), new RegExp(PRIVATE), '그룹 턴이 주인의 데스크톱 대화를 모델에 실었다');
    assert.equal((await loadThread(ws, 'x')).sessionId, deskSid, '그룹 턴이 주인의 전역 세션을 덮어쓰지 않는다');
  });

  test(`실제 SDK ${name} 그룹 턴: 같은 그룹은 그룹 세션을 잇고, 다른 그룹은 잇지 않는다`, async () => {
    await ownerDesktopHistory();
    await run(GROUP_A, 'group', 'GROUP-A-FIRST-2222 회의 안건 정리');
    bodies = [];
    await run(GROUP_A, 'group', '방금 안건 이어서');
    assert.match(sent(), /GROUP-A-FIRST-2222/, '같은 그룹의 다음 턴은 그 그룹 대화를 잇는다');
    bodies = [];
    await run(GROUP_B, 'group', '여기는 다른 방');
    assert.doesNotMatch(sent(), /GROUP-A-FIRST-2222/, '다른 그룹의 대화가 실렸다');
    assert.doesNotMatch(sent(), new RegExp(PRIVATE), '다른 그룹에도 주인 대화가 실리지 않는다');
  });
}

test('실제 SDK 크루 봇 그룹 턴: 그룹 세션이 다른 기기 것일 때(붙여넣기 갈래) 그 그룹 기록만 붙인다 — 주인 대화는 붙이지 않는다', async () => {
  await ownerDesktopHistory();
  await crewBot(GROUP_A, 'supergroup', 'GROUP-A-LINE-6666 그룹 안건');
  const t = await loadThread(ws, 'x');
  const key = `tg:${GROUP_A}`;
  assert.ok(t.scopedSessions?.[key]?.sessionId, '전제: 그룹 범위 세션이 저장됐다');
  await writeFile(join(p.chats, 'x.json'), JSON.stringify({ ...t, scopedSessions: { ...t.scopedSessions, [key]: { ...t.scopedSessions[key], sessionDevice: 'other-device' } } }));
  bodies = [];
  await crewBot(GROUP_A, 'supergroup', '그룹에서 이어서');
  assert.match(sent(), /다른 기기에서 이어짐/, '전제: 붙여넣기 갈래를 탔다');
  assert.match(sent(), /GROUP-A-LINE-6666/, '같은 그룹 기록은 붙인다');
  assert.doesNotMatch(sent(), new RegExp(PRIVATE), '붙여넣기 갈래에서 주인 대화가 실렸다');
});

test('실제 SDK 1:1(private) 턴: 설계대로 전역 세션(웹과 같은 스레드)을 잇는다 — 회귀 대조군', async () => {
  const deskSid = await ownerDesktopHistory();
  bodies = [];
  await crewBot(200, 'private', '1:1에서 이어서');
  assert.match(sent(), new RegExp(PRIVATE), '1:1은 데스크톱 대화를 잇는다(폰↔데스크톱 이어 말하기)');
  assert.notEqual((await loadThread(ws, 'x')).sessionId, null, '1:1 턴은 전역 세션을 갱신한다');
  assert.ok(deskSid);
});

// 텔레그램 결재 후속(Argo Dev 검토) — 후속 답은 카드가 실린 방(item.tg.chatId)으로 나간다. 그 방이 그룹이면 그룹 범위 세션, 1:1이면 전역 세션.
test('실제 SDK 텔레그램 결재 후속: 그룹에 실린 결재의 후속 턴은 주인의 전역 세션을 잇지 않는다 — 1:1 카드는 잇는다(대조군)', async () => {
  const { addApproval, setApprovalMeta, loadApprovals } = await import('../src/approvals.mjs');
  const { _followUpForTest } = await import('../src/approval-actions.mjs'); // resolveWithFollowUp이 백그라운드로 부르는 실제 후속 함수 — 끝날 때까지 기다린다
  const followUp = async (chatId) => {
    const deskSid = await ownerDesktopHistory();
    const it = await addApproval(ws, { slug: 'x', action: '메일 발송', reason: '그룹에서 요청', kind: 'action' }); // tool 결재는 후속 턴이 없다(턴 안에서 재개)
    await setApprovalMeta(ws, it.id, { tg: { chatId: String(chatId), messageId: 7 } });
    bodies = [];
    await _followUpForTest(ws, (await loadApprovals(ws)).find((a) => a.id === it.id), true);
    assert.ok(bodies.length >= 1, '실제 SDK 후속 턴이 돌았다');
    return { leaked: new RegExp(PRIVATE).test(sent()), globalKept: (await loadThread(ws, 'x')).sessionId === deskSid };
  };
  const group = await followUp(GROUP_A);
  assert.equal(group.leaked, false, '그룹 결재 후속이 주인의 데스크톱 대화를 모델에 실었다');
  assert.equal(group.globalKept, true, '그룹 결재 후속이 전역 세션을 덮어쓰지 않는다');
  assert.equal((await followUp(200)).leaked, true, '1:1 카드의 후속은 설계대로 전역 세션(주인 대화)을 잇는다');
});
