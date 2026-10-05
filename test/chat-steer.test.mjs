// 대기열에서 바로 보내기(끼워 넣기, 유건 요청 2026-09-29) — 답변을 멈추지 않고 작업 중인 크루에게 메시지를 전달한다.
// 요청의 핵심: "새로 보내면 기존 메시지가 중단" 되던 번개 버튼(중단 후 전송)을 없애고, 대기열에 둔 메시지를 멈춤 없이 끼워 넣는다.
// 엔진별 전달 방식이 달라 각각 실행으로 잠근다 — 등록부(turn-abort), 네이티브 루프, 스레드 저장 순서, codex app-server turn/steer,
// 한 번 실행하고 끝나는 CLI의 이어 실행 프롬프트, 화면 배선.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-steer-')); // import보다 먼저(레포 관례)
const { registerTurn, steerTurn } = await import('../src/turn-abort.mjs');
const { nativeQuery } = await import('../src/engine/native-query.mjs');
const { beginTurn, addSteer, removeSteer, appendTurn, loadThread } = await import('../src/thread.mjs');
const { runAppServerSession } = await import('../src/runners/codex-appserver.mjs');
const { cliSteerPrompt } = await import('../src/chat.mjs');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('등록부: 같은 크루의 최신 사장(chat) 실행에만 전달하고, 받을 실행이 없으면 false(대기열에 남는다)', async () => {
  assert.equal(await steerTurn('ws', 'none', { text: 'x' }), false, '실행 중인 턴이 없다');
  const got = [];
  const routine = registerTurn('ws', 'a', () => {}, { source: 'routine' });
  routine.setSteer(async (t) => { got.push(`routine:${t}`); return true; });
  const group = Symbol('turn');
  const setup = registerTurn('ws', 'a', () => {}, { group, source: 'chat' }); // withTurnControl 자리 — steer 없음
  const provider = registerTurn('ws', 'a', () => {}, { group, source: 'chat' });
  provider.setSteer(async (t) => { got.push(`chat:${t}`); return true; });
  assert.equal(await steerTurn('ws', 'a', { text: '끼워' }), true);
  assert.deepEqual(got, ['chat:끼워'], '루틴 실행에는 가지 않는다(source)');
  provider.setSteer(async () => false);
  assert.equal(await steerTurn('ws', 'a', { text: 'y' }), false, '엔진이 거절(실행 종료 중)하면 false');
  provider.release();
  assert.equal(await steerTurn('ws', 'a', { text: 'z' }), false, '엔진이 끝나고 마무리 중인 턴은 받지 않는다(답 뒤에 묻히지 않게)');
  setup.release(); routine.release();
});

test('등록부: 엔진이 통로를 달기 전(준비 단계)에 온 메시지는 보관했다가 통로가 달리는 순간 넘긴다', async () => {
  // 실측(2026-09-29 격리 서버): 턴 시작 3초 뒤 누른 바로 보내기가 SDK 부팅 중이라 거절돼, 턴이 끝난 뒤 새 턴으로 따로 나갔다.
  const got = [];
  const group = Symbol('turn');
  const setup = registerTurn('ws', 'b', () => {}, { group, source: 'chat' });
  assert.equal(await steerTurn('ws', 'b', { text: '일찍' }), true, '준비 중이면 받아 둔다');
  const provider = registerTurn('ws', 'b', () => {}, { group, source: 'chat' });
  provider.setSteer(async (t) => { got.push(t); return true; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['일찍'], '통로가 달리면 받아 둔 것을 넘긴다');
  provider.release(); setup.release();
  assert.equal(await steerTurn('ws', 'b', { text: '끝' }), false);
});

test('등록부: 시도가 실패해 재시도하면 받은 끼워 넣기가 다음 시도로 넘어간다 — 죽은 시도로 가지 않는다(검수 1)', async () => {
  const group = Symbol('turn');
  const setup = registerTurn('ws', 'r', () => {}, { group, source: 'chat' });
  const first = registerTurn('ws', 'r', () => {}, { group, source: 'chat' });
  const dead = [];
  first.setSteer(async (t) => { dead.push(t); return true; });
  assert.equal(await steerTurn('ws', 'r', { text: '실패 전' }), true);
  first.detachSteer(['실패 전']); // catch 머리 — 재시도 준비 시작
  assert.equal(await steerTurn('ws', 'r', { text: '재시도 준비 중' }), true, '그룹에 보관');
  first.release();
  const got = [];
  const retry = registerTurn('ws', 'r', () => {}, { group, source: 'chat' });
  retry.setSteer(async (t) => { got.push(t); return true; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['실패 전', '재시도 준비 중'], '재시도는 원 지시부터 다시 하므로 이미 실은 것도 다시');
  assert.deepEqual(dead, ['실패 전'], '죽은 시도는 이후 것을 받지 않는다');
  retry.release(); setup.release();
});

test('등록부: tag(사장 턴 id)가 있으면 그 실행만 — 뒤에 붙은 결재 후속 턴(같은 source)으로 새지 않는다(검수 6)', async () => {
  const got = [];
  const mine = registerTurn('ws', 't', () => {}, { source: 'chat', tag: 'turn-1' });
  mine.setSteer(async (t) => { got.push(`mine:${t}`); return true; });
  const followUp = registerTurn('ws', 't', () => {}, { source: 'chat' }); // approval-actions 후속 — 태그 없음
  followUp.setSteer(async (t) => { got.push(`follow:${t}`); return true; });
  assert.equal(await steerTurn('ws', 't', { tag: 'turn-1', text: 'x' }), true);
  assert.equal(await steerTurn('ws', 't', { tag: 'turn-2', text: 'y' }), false, '없는 턴이면 추측하지 않는다');
  assert.deepEqual(got, ['mine:x']);
  mine.release(); followUp.release();
});

test('네이티브 세션: 끼워 넣기가 실린 도구 결과 메시지는 지시로 보지 않는다 — 절단 뒤 짝 없는 tool_result가 머리에 남지 않는다(검수 4)', async () => {
  const { trimMessages, sanitizeTranscript } = await import('../src/engine/session.mjs');
  const big = 'x'.repeat(200);
  const msgs = [
    { role: 'user', content: '첫 지시' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'noop', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big }, { type: 'text', text: '사용자가 작업 중에 새 메시지를 보냈다:\n끼워' }] },
    { role: 'assistant', content: [{ type: 'text', text: '답' }] },
    { role: 'user', content: '둘째 지시' },
  ];
  const cut = trimMessages(msgs, 300, 250);
  assert.equal(cut[0].role, 'user');
  assert.ok(!(Array.isArray(cut[0].content) && cut[0].content.some((b) => b.type === 'tool_result')), '머리에 tool_result 금지');
  const head = sanitizeTranscript(msgs.slice(2));
  assert.ok(!head.length || !(Array.isArray(head[0].content) && head[0].content.some((b) => b.type === 'tool_result')));
});

// 네이티브 루프 — 가짜 Messages 응답(fetchImpl). 요청 본문은 복제해 둔다(sess.messages는 이후 계속 변한다).
function nativeHarness(script) {
  const bodies = [];
  let q;
  q = nativeQuery({
    wsId: 'steer-ws', slug: 'crew', prompt: '첫 지시', cwd: process.env.ARGO_ROOT, systemPrompt: '', model: 'fake', saveSession: false, browser: false,
    env: { ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(structuredClone(body.messages));
      const content = await script(bodies.length, q);
      return new Response(JSON.stringify({ id: 'm', role: 'assistant', type: 'message', model: 'fake', content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    },
  });
  return { q, bodies };
}
const lastUser = (msgs) => msgs.at(-1);

test('네이티브: 도구가 도는 사이 온 메시지는 멈추지 않고 다음 모델 호출에 도구 결과와 같이 실린다', async () => {
  const { q, bodies } = nativeHarness(async (n, q) => {
    if (n === 1) { assert.equal(await q.steer('방향 바꿔'), true); return [{ type: 'tool_use', id: 'tu1', name: 'noop_tool', input: {} }]; }
    return [{ type: 'text', text: '반영한 답' }];
  });
  const results = [];
  for await (const m of q) if (m.type === 'result') results.push(m);
  assert.equal(bodies.length, 2);
  const u = lastUser(bodies[1]);
  assert.equal(u.role, 'user');
  assert.equal(u.content[0].type, 'tool_result', '도구 결과가 먼저(벤더 규칙)');
  assert.match(u.content.at(-1).text, /사용자가 작업 중에 새 메시지를 보냈다:\n방향 바꿔/);
  assert.equal(results.length, 1, '같은 실행 안에서 소비 — result는 한 번');
  assert.equal(results[0].result, '반영한 답');
  assert.equal(await q.steer('늦음'), false, '끝난 실행은 받지 않는다 — 호출부가 대기열에 남긴다');
});

test('네이티브: 마지막 답을 쓰는 사이 온 메시지는 같은 실행에서 한 번 더 답한다(result 2회, 사용량은 나눠서)', async () => {
  const { q, bodies } = nativeHarness(async (n, q) => {
    if (n === 1) { assert.equal(await q.steer('하나 더'), true); return [{ type: 'text', text: '첫 답' }]; }
    return [{ type: 'text', text: '둘째 답' }];
  });
  const results = [];
  for await (const m of q) if (m.type === 'result') results.push(m);
  assert.deepEqual(results.map((r) => r.result), ['첫 답', '둘째 답']);
  assert.deepEqual(bodies[1].slice(-2).map((m) => m.role), ['assistant', 'user']);
  assert.match(lastUser(bodies[1]).content, /하나 더/);
  assert.equal(results[1].usage.input_tokens, 1, '둘째 result는 이어진 몫만 — 앞 result와 중복 집계 금지');
  assert.deepEqual(q.continuedTexts(), ['하나 더'], '이어진 실행에 실린 것 — 그 실행이 실패하면 chat()이 이것만 실패로 표시한다(M-1)');
});

test('스레드: 끼워 넣은 메시지는 원래 지시 뒤·답 앞에 저장되고, 실패하면 같이 실패로 표시된다', async () => {
  const ws = 'steer-thread';
  assert.equal(await addSteer(ws, 'c', { text: 'x' }), null, '답을 기다리는 사장 턴이 없으면 저장하지 않는다');
  const turnId = await beginTurn(ws, 'c', { userMsg: '원래 지시' });
  const s1 = await addSteer(ws, 'c', { text: '끼워 넣기' });
  assert.equal(s1.turnId, turnId, 'steer 라우트가 정확히 이 턴을 고르는 표지');
  const gone = await addSteer(ws, 'c', { text: '전달 실패분' });
  await removeSteer(ws, 'c', gone.steerId);
  await appendTurn(ws, 'c', { turnId, userMsg: '원래 지시', reply: '답' });
  const msgs = (await loadThread(ws, 'c')).messages;
  assert.deepEqual(msgs.map((m) => `${m.who}:${m.text}`), ['user:원래 지시', 'user:끼워 넣기', 'crew:답']);
  assert.ok(msgs.every((m) => !m.awaiting), '대기 표시가 남지 않는다(맥락에서 영영 빠진다)');
  assert.equal(await addSteer(ws, 'c', { text: 'y' }), null, '끝난 턴에는 끼워 넣지 않는다');

  const t2 = await beginTurn(ws, 'd', { userMsg: 'a' });
  await addSteer(ws, 'd', { text: 'b' });
  await appendTurn(ws, 'd', { turnId: t2, userMsg: 'a', failed: '중단됨', aborted: true });
  const m2 = (await loadThread(ws, 'd')).messages;
  assert.ok(m2.every((m) => m.failed && m.aborted && !m.awaiting), '실패 턴이면 끼워 넣은 메시지도 재전송할 수 있게 실패로');

  // 턴은 답했지만 이어진 실행이 실패(steerFailed) — 답은 저장하고, 그 실행에 실린 줄만 실패(총괄 검수 M-1). 엔진 글엔 첨부 안내가 뒤에 붙는다
  const t3 = await beginTurn(ws, 'e', { userMsg: '원 지시' });
  await addSteer(ws, 'e', { text: '앞서 전달된 것' });
  await addSteer(ws, 'e', { text: '이어진 실행에 실린 것' });
  await appendTurn(ws, 'e', { turnId: t3, userMsg: '원 지시', reply: '첫 답', steerFailed: { texts: ['이어진 실행에 실린 것\n\n(사장이 첨부한 파일 — …)'], reason: 'API Error: 500' } });
  const m3 = (await loadThread(ws, 'e')).messages;
  assert.deepEqual(m3.map((m) => `${m.who}:${m.text}:${m.failed ?? ''}`), ['user:원 지시:', 'user:앞서 전달된 것:', 'user:이어진 실행에 실린 것:API Error: 500', 'crew:첫 답:']);
});

// codex app-server — turn/steer(0.157.1 스키마: threadId·expectedTurnId·input 필수)
function fakeAppServer() {
  const input = new PassThrough(); const output = new PassThrough();
  const received = []; const emit = (m) => output.write(JSON.stringify(m) + '\n');
  let buf = '';
  input.on('data', (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      const m = JSON.parse(line); received.push(m);
      if (m.method === 'initialize') emit({ id: m.id, result: {} });
      else if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: 't1' } } });
      else if (m.method === 'turn/start') emit({ id: m.id, result: { turn: { id: 'u1', status: 'inProgress' } } });
      else if (m.method === 'turn/steer') {
        emit({ id: m.id, result: { turnId: 'u1' } });
        emit({ method: 'item/completed', params: { item: { id: 'a1', type: 'agentMessage', text: '반영했다' } } });
        emit({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } });
      }
    }
  });
  return { input, output, received };
}

test('codex app-server: 진행 중 턴에 turn/steer로 전달하고, 턴이 끝나면 통로를 거둔다', async () => {
  const srv = fakeAppServer();
  const seen = [];
  let steer = null;
  const session = runAppServerSession({ input: srv.input, output: srv.output, prompt: 'p', cwd: '/w', timeoutMs: 5000,
    onSteerable: (fn) => { seen.push(!!fn); if (fn) steer = fn; } });
  while (!steer) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await steer('끼워'), true);
  const { reply } = await session;
  const req = srv.received.find((m) => m.method === 'turn/steer');
  assert.deepEqual(req.params, { threadId: 't1', expectedTurnId: 'u1', input: [{ type: 'text', text: '끼워' }] });
  assert.equal(reply, '반영했다');
  assert.deepEqual(seen, [true, false], '종료 시 통로 해제 — 이후 끼워 넣기는 이어 실행으로 간다');
  assert.equal(await steer('늦음'), false);
});

test('CLI 이어 실행 프롬프트: 원 프롬프트 + 방금 답 + 새 메시지를 싣는다(ko/en)', () => {
  const ko = cliSteerPrompt('원 프롬프트', '방금 답', ['새1', '새2'], 'ko');
  assert.ok(ko.startsWith('원 프롬프트'));
  assert.match(ko, /## 너의 방금 답\n방금 답/);
  assert.match(ko, /## 사용자가 작업 중에 보낸 새 메시지\n새1\n\n새2/);
  assert.match(cliSteerPrompt('p', '', ['n'], 'en'), /## Your reply so far\n\(none yet\)[\s\S]*## New message the user sent while you were working\nn/);
});

test('CLI 경로: 받아 둔 끼워 넣기를 실행 직후 같은 턴에서 이어 실행하고, 확인 뒤 닫는다', () => {
  const src = readFileSync(join(ROOT, 'src/chat.mjs'), 'utf8');
  const cli = src.slice(src.indexOf('const cliInbox ='), src.indexOf('if (!reply) throw new Error(lang ==='));
  assert.match(cli, /while \(cliInbox\.items\.length\) \{[\s\S]*const texts = cliInbox\.items\.splice\(0\);[\s\S]*cliSteerPrompt\(withEarly\(ctx\), doneText, texts, lang\)[\s\S]*\}\n\s*cliInbox\.closed = true;/);
  assert.match(src, /abortReg\.setSteer\(async \(text\) => \{\s*if \(nativeOn \? !\(await q\.steer\(text\)\)/, 'SDK·네이티브 경로도 통로를 단다');
  assert.match(src, /abortReg\?\.detachSteer\(steerAccepted\); closeSdkInput\(\);/, 'SDK 실패 → 받은 끼워 넣기를 그룹에 되돌린다(재시도가 다시 받는다)');
  assert.match(src, /hooks: \[async \(input\) => \(sdkInbox\.items\.length && !input\?\.agent_id/, '서브에이전트 도구 뒤에는 싣지 않는다'); 
});

test('화면: 번개(중단 후 전송) 버튼은 없고, 대기열 줄의 바로 보내기가 끼워 넣기 API를 부른다', () => {
  const page = readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  assert.doesNotMatch(page, /sendImmediate|immediate: true|name="bolt"/, '중단 후 전송 경로가 남아 있다');
  const fn = page.slice(page.indexOf('async function steerQueued('), page.indexOf('// 메시지 복사'));
  assert.match(fn, /api\(`\/api\/companies\/\$\{ws\}\/chat\/steer`/);
  assert.match(fn, /if \(r\.steered\) \{\s*setQueue\(\(cur\) => cur\.filter\(\(x\) => x\.qid !== q\.qid\)\);/, '전달됐을 때만 대기열에서 뺀다');
  assert.match(page, /\{busy && \(\s*<button type="button" className="btn sm"[^>]*onClick=\{\(\) => steerQueued\(q\)\}/, '답변 중일 때 줄마다 버튼');
  assert.match(page, /if \(!message \|\| busyRef\.current \|\| uploading\) return false;/, 'sendMessage는 최신 busy로 판정(2026-09-24 HIGH)');
  const i18n = readFileSync(join(ROOT, 'app/i18n.jsx'), 'utf8');
  for (const k of ['chat.queue.steer', 'chat.queue.steerHint']) assert.match(i18n, new RegExp(`'${k.replace('.', '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});

test('화면: 첫 대화 로드 응답은 스레드를 교체하지 않고 병합한다 — 로드 전에 보낸 지시가 답변 내내 사라지지 않는다', () => {
  // 실측(2026-09-29 격리 서버, main에서도 재현): 페이지를 열자마자 보내면 늦게 온 첫 로드 응답이 낙관 사본을 덮어 지시가 화면에서 빠졌다.
  // 바로 보내기는 그 지시(mid) 뒤에 끼워 넣은 줄을 붙이므로 같은 흐름의 결함이다.
  const page = readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
  const load = page.slice(page.indexOf("api(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`)"), page.indexOf('return () => { alive = false; };'));
  assert.doesNotMatch(load, /setThread\(t\.messages \?\? \[\]\)/, '교체로 되돌아가면 로드 전 보낸 지시가 사라진다');
  assert.match(load, /setThread\(\(cur\) => \{ const server = t\.messages \?\? \[\]; const local = cur \?\? \[\]; return local\.length \? \[\.\.\.server\.filter\(\(s\) => !\(s\.awaiting && local\.some/);
});
