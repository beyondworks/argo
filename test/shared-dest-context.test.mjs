// 목적지 기준 붙여넣기(PR-2) — 붙일 맥락은 턴 종류가 아니라 **답이 나가는 곳**으로 정한다. 여러 사람이 보는 곳(텔레그램 그룹·슬랙 공유 채널·메신저 채널)으로
// 나가는 턴은 그 범위 기록만 쓰고 주인 대화(범위 없는 기록)는 붙이지 않는다. 주인만 보는 곳은 지금처럼 전역 맥락이다.
// 실행: 부른 쪽 크루 x = 실제 SDK(모델만 로컬 가짜 Messages 엔드포인트 — 도구 호출까지 낸다), 위임받은·루틴 크루 y = CLI(가짜 codex — 받은 프롬프트를
// 로그로 떨군다). CLI 러너는 세션이 없어도 최근 기록 6줄을 붙이므로(chat.mjs) 세션 인자만 봐서는 못 잡는다. 텔레그램·슬랙 API는 가짜 fetch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-shared-dest-')); const home = await mkdtemp(join(tmpdir(), 'argo-shared-dest-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off', ARGO_CODEX_PREFER_PATH: '1' });
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k];
const BIN = join(root, 'bin'); await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""; last=""
for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi; prev="$a"; last="$a"; done
[ "$last" = "-" ] && last="$(cat)" # 진짜 codex exec 계약: 프롬프트 자리가 - 면 stdin에서 읽는다(K01 — 러너가 프롬프트를 stdin으로 넘긴다)
printf '%s\\n=====\\n' "$last" >> "$PWD/.cli-prompts.log"
[ -n "$OUT" ] && printf 'y done' > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;

let bodies = []; let call = null;
const sse = (res, evs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of evs) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const start = () => ({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    bodies.push(b); const last = (JSON.parse(b || '{}').messages ?? []).at(-1);
    const hasResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
    // 그리고 그 턴의 요청(본문에 when 문구)에만 — 앞 턴의 늦은 요청이 호출을 가로채면 턴이 도구 없이 끝난다(Windows CI 실측: 채널 게시 "done")
    // 세션 변수(CLAUDECODE 등)가 없는 환경(CI)에서는 SDK가 본 요청 앞에 도구 0개의 세션 제목 생성 요청을 먼저 보낸다 — 도구가 실린 요청에만 호출을 준다(Argo Dev 재현)
    if (!hasResult && call && (JSON.parse(b || '{}').tools ?? []).length > 0 && (!call.when || b.includes(call.when))) { const c = call; call = null; return sse(res, [['message_start', start()],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: c.name, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]); }
    return sse(res, [['message_start', start()], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]]);
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
const kinds = { C0SHARED: { ok: true, channel: { id: 'C0SHARED', is_channel: true, is_im: false } }, D0OWNER: { ok: true, channel: { id: 'D0OWNER', is_im: true } } };
const origFetch = globalThis.fetch; const slackPosts = [];
globalThis.fetch = async (url, o) => {
  const u = new URL(String(url));
  const json = (x) => new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'api.telegram.org') return json({ ok: true, result: {} });
  if (u.hostname === 'slack.com') {
    if (u.pathname === '/api/conversations.info') return json(kinds[u.searchParams.get('channel')] ?? { ok: false, error: 'missing_scope' });
    if (u.pathname === '/api/chat.postMessage') slackPosts.push(JSON.parse(o?.body ?? '{}').text ?? ''); // 핸들러가 채널에 게시한 본문 — 실패하면 "처리 실패: …"가 여기 남는다(진단용)
    return json({ ok: true });
  }
  return origFetch(url, o);
};
after(() => { srv.close(); globalThis.fetch = origFetch; });

const { createCompany, paths, getDeviceId } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { appendTurn, loadThread } = await import('../src/thread.mjs');
const { updateConnection } = await import('../src/connections.mjs');
const G = await import('../src/gateway.mjs');
const ws = 'shared-dest'; await createCompany(ws, '목적지', 'owner', null, 'ko');
const p = paths(ws); await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await writeFile(join(p.agents, 'y.md'), '---\nname: 와이\nrole: 검증\nrunner: codex\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다
await saveRunnerCred(ws, 'codex', 'apikey', 'sk-fake-not-a-real-key');

// 가짜 codex는 POSIX 셸 스크립트 — Windows에서는 실행되지 않는다(test/artifacts-behavior.test.mjs 선례). 검증 대상(범위 판정·배선)은 플랫폼 무관 JS이고 macOS CI가 덮는다.
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX 셸 하네스(가짜 codex) — macOS CI가 담당' : false };
const PRIVATE_X = 'OWNER-PRIVATE-X-1111'; const PRIVATE_Y = 'OWNER-PRIVATE-Y-3333';
const cliLog = () => readFile(join(p.root, '.cli-prompts.log'), 'utf8').catch(() => '');
const connections = async ({ slack = false, telegramChat = null } = {}) => {
  await writeFile(p.connections, '{}');
  if (slack) await updateConnection(ws, 'slack', { token: 'xoxb-fake', channel: 'C0SHARED', enabled: true, ownerId: 'U1' });
  if (telegramChat) { await updateConnection(ws, 'telegram', { token: '1:fake-bot', enabled: true }); await updateConnection(ws, 'telegram', { chatId: String(telegramChat), ownerId: 1 }); }
};
// 주인이 데스크톱에서 나눈 대화 — x는 실제 SDK 세션(이 기기), y는 CLI라 스레드 기록만
async function reset() {
  G._slackForTest.slackKinds.clear();
  await writeFile(join(p.root, '.cli-prompts.log'), '');
  await writeFile(join(p.chats, 'y.json'), JSON.stringify({ sessionId: null, messages: [{ who: 'user', text: `${PRIVATE_Y} 와이에게 한 개인 부탁`, ts: 1 }, { who: 'crew', text: '네', ts: 2 }] }));
  await writeFile(join(p.chats, 'x.json'), JSON.stringify({ sessionId: null, messages: [] }));
  const desk = await chat(ws, 'x', `${PRIVATE_X} 내 연봉 협상 메모 기억해`, null, {});
  await appendTurn(ws, 'x', { userMsg: `${PRIVATE_X} 내 연봉 협상 메모 기억해`, reply: desk.reply, sessionId: desk.sessionId });
  assert.equal((await loadThread(ws, 'x')).sessionDevice, await getDeviceId(), '전제: x의 전역 세션 = 이 기기의 주인 대화');
  bodies = []; call = null;
  return desk.sessionId;
}
const DELEGATE = { name: 'mcp__crew__delegate', input: { to: 'y', task: '그룹 일정표를 정리해 줘' }, when: '맡겨' };
const crewBotGroup = (text) => G._tgHandlersForTest.makeTgAgentHandler(ws, 'x', () => ({ token: 'bot-x', ownerId: 1, ownerChat: '200' }))({ text, atts: [], ctx: { chatId: -100111, chatType: 'supergroup' } });

test('위임: 텔레그램 그룹 턴에서 위임받은 동료(CLI) 턴은 주인 대화를 붙이지 않는다 — 위임 기록도 그룹 범위', posixOnly, async () => {
  await connections();
  await reset(); call = DELEGATE;
  await crewBotGroup('와이한테 일정 정리 맡겨 줘');
  const l = await cliLog();
  assert.ok(l.length > 0, '전제: 위임받은 동료 턴이 실제로 돌았다(가짜 codex)');
  assert.ok(!l.includes(PRIVATE_Y), '그룹 턴의 위임 동료 프롬프트에 주인 대화가 실렸다');
  const trace = (await loadThread(ws, 'y')).messages.find((m) => m.via === 'delegate');
  assert.deepEqual(trace?.contextScope, { kind: 'tg-group', chatId: '-100111' }, '위임 기록은 그룹 범위(데스크톱 대화 맥락에 붙지 않는다)');
});

test('위임: 그룹에 실린 결재의 후속 턴에서 위임받은 동료(CLI) 턴도 주인 대화를 붙이지 않는다', posixOnly, async () => {
  await connections();
  await reset(); call = { ...DELEGATE, when: '일정 공유' }; // 후속 턴 문구는 결재 이름을 담는다
  const { addApproval, setApprovalMeta, loadApprovals } = await import('../src/approvals.mjs');
  const { _followUpForTest } = await import('../src/approval-actions.mjs');
  const it = await addApproval(ws, { slug: 'x', action: '일정 공유', reason: '그룹 요청', kind: 'action' });
  await setApprovalMeta(ws, it.id, { tg: { chatId: '-100111', messageId: 7 } });
  await _followUpForTest(ws, (await loadApprovals(ws)).find((a) => a.id === it.id), true);
  const l = await cliLog();
  assert.ok(l.length > 0, '전제: 위임받은 동료 턴이 실제로 돌았다');
  assert.ok(!l.includes(PRIVATE_Y), '그룹 결재 후속의 위임 동료 프롬프트에 주인 대화가 실렸다');
});

test('위임(핀): 메신저 채널 턴의 위임은 동료 턴을 돌리지 않고 넘김으로만 남긴다 — 넘김은 채널 범위 메신저 잡(#593)이 돈다', async () => {
  await reset(); call = DELEGATE;
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const ctx = { kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-x', threadRoot: 1, sourceMsgId: 1, uid: OWNER, wsId: ws, origin: OWNER, hop: 0, orgSlug: null, channelName: 'general',
    peers: [{ id: 'crew-x', slug: 'x', display_name: '엑스', owner_user_id: OWNER, ws_id: ws }, { id: 'crew-y', slug: 'y', display_name: '와이', owner_user_id: OWNER, ws_id: ws }], handoffs: [] };
  await chat(ws, 'x', '와이한테 맡겨 줘', null, { source: 'messenger', mirrorCtx: ctx });
  assert.equal(ctx.handoffs.length, 1, '넘김 1건이 준비됐다');
  assert.equal(await cliLog(), '', '메신저 위임은 이 턴 안에서 동료 턴을 돌리지 않는다');
});

test('슬랙 채널에서 올린 결재의 후속 턴은 주인의 전역 세션을 잇지 않는다 — 결재에 슬랙 범위가 실리고 후속은 그 범위로(검수 LOW)', async () => {
  await connections({ slack: true });
  const deskSid = await reset();
  call = { name: 'mcp__crew__request_approval', input: { action: '고객 메일 발송', reason: '채널에서 요청받음' }, when: '고객에게 메일' };
  slackPosts.length = 0;
  await G._slackForTest.makeSlackHandler(ws, () => ({ token: 'xoxb-fake', channel: 'C0SHARED', ownerId: 'U1' }))({ text: '고객에게 메일 보내 줘' });
  const { loadApprovals } = await import('../src/approvals.mjs');
  const item = (await loadApprovals(ws)).find((a) => a.action === '고객 메일 발송');
  assert.ok(item, `전제: 슬랙 채널 턴에서 결재가 올라갔다 — 채널 게시: ${JSON.stringify(slackPosts.slice(-2)).slice(0, 300)}, 모델 요청 ${bodies.length}건 중 턴 문구 포함 ${bodies.filter((b) => b.includes('고객에게 메일')).length}건, 남은 호출 ${call ? call.name : '없음'}`);
  const { _followUpForTest } = await import('../src/approval-actions.mjs');
  bodies = [];
  await _followUpForTest(ws, item, true);
  assert.ok(bodies.length >= 1, '전제: 실제 SDK 후속 턴이 돌았다');
  assert.ok(!bodies.join('\n').includes(PRIVATE_X), '슬랙 결재 후속이 주인의 데스크톱 대화(전역 세션)를 이어받았다');
  assert.equal((await loadThread(ws, 'x')).sessionId, deskSid, '후속이 전역 세션을 덮어쓰지 않는다(채널 내용이 주인 대화로 섞이지 않게)');
  assert.deepEqual(item.scope, { kind: 'slack', channelId: 'C0SHARED' }, '결재에 슬랙 채널 범위가 실렸다(후속이 그 범위로 도는 재료)');
});

test('루틴: 결과가 슬랙 공유 채널로 나가면(알림 대상 미지정 = 기존 브리핑) CLI 루틴 턴이 주인 대화를 붙이지 않는다 — 슬랙이 없으면 지금처럼 붙인다', posixOnly, async () => {
  const { addRoutine, runRoutine } = await import('../src/routines.mjs');
  await connections({ slack: true });
  await reset();
  const r = await addRoutine(ws, { agentSlug: 'y', title: '아침 보고', prompt: '오늘 일정 보고', schedule: { type: 'daily', time: '09:00' } });
  await runRoutine(ws, r.id);
  let l = await cliLog();
  assert.ok(l.length > 0, '전제: 루틴 턴이 CLI로 돌았다');
  assert.ok(!l.includes(PRIVATE_Y), '슬랙 채널로 나가는 루틴이 주인 대화를 붙였다');
  await connections(); // 대조군: 목적지가 주인 앱뿐
  await reset();
  await runRoutine(ws, r.id);
  l = await cliLog();
  assert.ok(l.includes(PRIVATE_Y), '주인만 보는 루틴은 지금처럼 전역 맥락(맥락 손실 없음)');
});

test('루틴: 알림 대상으로 텔레그램을 고르고 그 목적지가 그룹이면 주인 대화를 붙이지 않는다', posixOnly, async () => {
  const { addRoutine, runRoutine } = await import('../src/routines.mjs');
  await connections({ telegramChat: -100555 });
  await reset();
  const r = await addRoutine(ws, { agentSlug: 'y', title: '주간 보고', prompt: '주간 보고', schedule: { type: 'daily', time: '09:00' }, notifications: { channels: ['telegram'] } });
  await runRoutine(ws, r.id);
  const l = await cliLog();
  assert.ok(l.length > 0, '전제: 루틴 턴이 CLI로 돌았다');
  assert.ok(!l.includes(PRIVATE_Y), '텔레그램 그룹으로 알리는 루틴이 주인 대화를 붙였다');
});

test('장시간 작업: 완료 브리핑이 텔레그램 그룹으로 나가면 CLI 작업 턴이 주인 대화를 붙이지 않는다 — 실제 잡 핸들러', posixOnly, async () => {
  await connections({ telegramChat: -100555 });
  await reset();
  await G._makeJobHandlerForTest(ws)({ id: 'job-grp', slug: 'y', title: '정리', prompt: '자료 정리' });
  const l = await cliLog();
  assert.ok(l.length > 0, '전제: 작업 턴이 CLI로 돌았다');
  assert.ok(!l.includes(PRIVATE_Y), '그룹으로 보고하는 장시간 작업이 주인 대화를 붙였다');
});

test('루틴: 공유 목적지가 여럿이면(텔레그램 그룹 + 슬랙 채널) 어느 방의 기록도, 주인 대화도 붙이지 않는다', posixOnly, async () => {
  const { addRoutine, runRoutine } = await import('../src/routines.mjs');
  await connections({ slack: true, telegramChat: -100555 });
  await reset();
  await writeFile(join(p.chats, 'y.json'), JSON.stringify({ sessionId: null, messages: [
    { who: 'user', text: `${PRIVATE_Y} 와이에게 한 개인 부탁`, ts: 1 },
    { who: 'user', text: 'GROUP-ROOM-4444 그룹방 대화', ts: 2, contextScope: { kind: 'tg-group', chatId: '-100555' } },
    { who: 'user', text: 'SLACK-ROOM-5555 슬랙 채널 대화', ts: 3, contextScope: { kind: 'slack', channelId: 'C0SHARED' } }] }));
  const r = await addRoutine(ws, { agentSlug: 'y', title: '두 방 보고', prompt: '보고', schedule: { type: 'daily', time: '09:00' } });
  await runRoutine(ws, r.id);
  const l = await cliLog();
  assert.ok(l.length > 0, '전제: 루틴 턴이 CLI로 돌았다');
  for (const marker of [PRIVATE_Y, 'GROUP-ROOM-4444', 'SLACK-ROOM-5555']) assert.ok(!l.includes(marker), `공유 목적지가 여럿인 루틴이 ${marker}를 붙였다(한 방의 기록을 다른 방 답에 옮기면 안 된다)`);
});

test('루틴: 외부 알림을 모두 끈 루틴(channels: [])은 결과가 주인 앱에만 남으므로 지금처럼 전역 맥락 — 연결된 그룹이 있어도', posixOnly, async () => {
  const { addRoutine, runRoutine } = await import('../src/routines.mjs');
  await connections({ telegramChat: -100555 });
  await reset();
  const r = await addRoutine(ws, { agentSlug: 'y', title: '혼자 보는 보고', prompt: '보고', schedule: { type: 'daily', time: '09:00' }, notifications: { channels: [] } });
  await runRoutine(ws, r.id);
  assert.ok((await cliLog()).includes(PRIVATE_Y), '알림을 끈 루틴이 주인 맥락을 잃었다(기존 브리핑 갈래로 잘못 판정)');
});

test('받은 서류함: 보고가 텔레그램 그룹으로 나가면 서류함 턴(CLI)이 주인 대화를 붙이지 않는다 — 실제 감시기', { ...posixOnly, timeout: 60_000 }, async () => {
  const { utimes } = await import('node:fs/promises');
  await connections({ telegramChat: -100555 });
  await updateConnection(ws, 'telegram', { defaultCrew: 'y' }); // 서류함 담당 = 기본 크루(CLI 크루 y)
  await reset();
  const inbox = join(p.root, 'inbox'); await mkdir(inbox, { recursive: true });
  const file = join(inbox, 'memo.txt'); await writeFile(file, '회의 메모');
  const past = new Date(Date.now() - 60_000); await utimes(file, past, past); // 감시기는 5초 넘게 안정된 파일만 집는다
  const stop = G._inboxForTest(ws);
  try {
    const deadline = Date.now() + 45_000; // 감시 주기 15초 — 조건 대기
    while (Date.now() < deadline && !(await cliLog()).length) await new Promise((r) => setTimeout(r, 200));
  } finally { stop(); }
  const l = await cliLog();
  assert.ok(l.length > 0, '전제: 서류함 턴이 CLI로 돌았다');
  assert.ok(!l.includes(PRIVATE_Y), '그룹으로 보고하는 서류함 턴이 주인 대화를 붙였다');
});

test('쪽지(메신저 밖): 배달 브리핑이 텔레그램 그룹으로 나가면 수신 크루(CLI) 턴이 주인 대화를 붙이지 않는다 — 실제 sendCrewMail·deliverCrewMail·crewmailTurn', posixOnly, async () => {
  const { sendCrewMail, deliverCrewMail } = await import('../src/crewmail.mjs');
  const { crewmailTurn } = await import('../src/scheduler.mjs');
  await connections({ telegramChat: -100555 });
  await reset();
  await sendCrewMail(ws, { from: 'x', fromName: '엑스', to: 'y', message: '자료 정리해서 알려 줘' });
  await deliverCrewMail(ws, (slug, msg, opts) => crewmailTurn(ws, slug, msg, opts));
  const l = await cliLog();
  assert.ok(l.length > 0, '전제: 쪽지 배달 턴이 CLI로 돌았다');
  assert.ok(!l.includes(PRIVATE_Y), '그룹으로 브리핑되는 쪽지 배달 턴이 주인 대화를 붙였다');
  await connections(); // 대조군: 브리핑이 없으면(주인 앱뿐) 지금처럼 전역 맥락
  await reset();
  await sendCrewMail(ws, { from: 'x', fromName: '엑스', to: 'y', message: '자료 다시 정리해 줘' });
  await deliverCrewMail(ws, (slug, msg, opts) => crewmailTurn(ws, slug, msg, opts));
  assert.ok((await cliLog()).includes(PRIVATE_Y), '주인만 보는 쪽지 배달은 지금처럼 전역 맥락');
});

test('briefingCtx: 목적지 판정 — 그룹·슬랙 채널은 범위, 주인 1:1·연결 없음은 null, 공유 목적지 여럿은 shared', async () => {
  await connections({ telegramChat: -100555 });
  for (const type of ['job', 'crewmail', 'inbox']) assert.deepEqual(await G.briefingCtx(ws, type, 'y'), { kind: 'scope', scope: { kind: 'tg-group', chatId: '-100555' } }, `${type} → 텔레그램 그룹`);
  await connections({ telegramChat: 200 });
  assert.equal(await G.briefingCtx(ws, 'job', 'y'), null, '주인 1:1 = 전역 맥락');
  await connections();
  assert.equal(await G.briefingCtx(ws, 'routine', 'y'), null, '연결 없음 = 주인 앱뿐');
  await connections({ slack: true, telegramChat: -100555 }); G._slackForTest.slackKinds.clear();
  assert.deepEqual(await G.briefingCtx(ws, 'routine', 'y'), { kind: 'scope', scope: { kind: 'shared' } }, '그룹 + 슬랙 채널 = 가장 넓은 쪽(아무것도 붙이지 않음)');
  assert.deepEqual(await G.briefingCtx(ws, 'job', 'y'), { kind: 'scope', scope: { kind: 'tg-group', chatId: '-100555' } }, '슬랙은 루틴만 받는다(CHANNEL_EVENTS.slack)');
  await connections(); G._slackForTest.slackKinds.clear(); await updateConnection(ws, 'slack', { token: 'xoxb-fake', channel: 'D0OWNER', enabled: true, ownerId: 'U1' });
  assert.equal(await G.briefingCtx(ws, 'routine', 'y'), null, '슬랙 1:1(is_im) = 주인만');
});
