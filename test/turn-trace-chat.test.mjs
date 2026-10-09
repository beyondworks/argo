// 작업 과정 보이기 — 실제 크루 턴(chat)을 네이티브 엔진(OpenRouter 와이어 → 로컬 가짜 엔드포인트)으로 돌려 끝까지 확인한다. 실벤더 호출 0.
//  ① 도구 45개 턴: 진행 중 기록이 쌓이고(상태 파일 traceId·등록부), 끝나면 이 기기에 저장(생각 1 + 도구 45, 결과까지), 비밀 모양은 가려지고,
//     활동 이벤트는 마지막 40개 + stepsTotal(옛 step()은 40번째에서 멈췄다)
//  ② 같은 크루의 1:1 턴과 루틴 턴이 겹쳐도 기록이 섞이지 않고, 루틴은 저장하지 않는다
//  ③ 라우트: 진행 폴은 늘어난 단계만(tr·rev), 끝난 대화는 이 기기 요약(traces), 펼치기는 /trace
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { register } from 'node:module';
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url)); // 라우트 실임포트(next/headers 확장자 해석)

const root = await mkdtemp(join(tmpdir(), 'argo-trace-chat-'));
const home = await mkdtemp(join(tmpdir(), 'argo-trace-chat-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off' });
delete process.env.ARGO_NATIVE_RUNNERS;
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

const T = await import('../src/turn-trace.mjs');
const { getTurnStatus } = await import('../src/turn-status.mjs');

const toolResults = (body) => (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b?.type === 'tool_result').length;
const turnOf = (body) => (JSON.stringify(body.messages?.[0] ?? '').includes('TURN-B') ? 'B' : 'A');
const mid = { seen: null, gate: null };
let releaseB = null;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    const body = JSON.parse(b || '{}');
    const reply = (content, stop = 'tool_use') => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } })); };
    if (!(body.tools ?? []).length) return reply([{ type: 'text', text: '요약' }], 'end_turn');
    const k = toolResults(body);
    if (turnOf(body) === 'B') {
      if (k === 1 && mid.gate) await mid.gate; // A 턴이 도는 사이에 B가 끼도록 잠깐 붙든다
      if (k < 3) return reply([{ type: 'tool_use', id: `tb${k}`, name: 'Read', input: { file_path: 'vault/notes/b.md' } }]);
      return reply([{ type: 'text', text: 'B 끝' }], 'end_turn');
    }
    if (k === 10 && !mid.seen) {
      const st = await getTurnStatus('trc', 'r');
      const live = T.pickLiveTrace('trc', 'r', { pointer: st?.traceId });
      mid.seen = { traceId: st?.traceId ?? null, liveId: live?.id ?? null, n: live?.view(0).n ?? 0 };
      releaseB?.();
    }
    if (k < 45) return reply([...(k === 0 ? [{ type: 'thinking', thinking: '계획: 노트를 차례로 읽는다', signature: 'sig' }] : []), { type: 'tool_use', id: `ta${k}`, name: 'Read', input: { file_path: `vault/notes/a${k % 3}.md` } }]);
    return reply([{ type: 'text', text: 'A 끝' }], 'end_turn');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { readEvents } = await import('../src/events.mjs');
const ws = 'trc';
await createCompany(ws, '작업 과정', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await mkdir(join(p.vault, 'notes'), { recursive: true });
await writeFile(join(p.agents, 'r.md'), '---\nname: 로라\nrole: 검증\nrunner: openrouter\n---\n검증 크루.\n');
for (let i = 0; i < 3; i++) await writeFile(join(p.vault, 'notes', `a${i}.md`), `${Array.from({ length: 30 }, (_, j) => `a${i} line ${j + 1}`).join('\n')}\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n`);
await writeFile(join(p.vault, 'notes', 'b.md'), 'only-b\n');
await saveRunnerCred(ws, 'openrouter', 'apikey', `sk-or-v1-${'f'.repeat(64)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜로만

test('도구 45개 턴 — 진행 중 기록·끝난 뒤 저장(결과·가림)·활동 이벤트 마지막 40개', { timeout: 120_000 }, async () => {
  const r = await chat(ws, 'r', 'TURN-A 노트를 읽어 줘');
  assert.equal(r.reply, 'A 끝');
  assert.match(String(r.traceId), T.TRACE_ID_RE, '1:1 턴은 기록 id를 돌려준다');
  assert.ok(mid.seen, '턴 도중 관찰');
  assert.equal(mid.seen.traceId, r.traceId, '상태 파일이 이 턴의 기록을 가리킨다');
  assert.equal(mid.seen.liveId, r.traceId, '진행 중 등록부에 있다');
  assert.ok(mid.seen.n >= 10, `턴 도중 단계가 이미 쌓여 있다: ${mid.seen.n}`);
  const saved = await T.readTrace(ws, 'r', r.traceId);
  assert.ok(saved, '이 기기에 저장');
  const tools = saved.steps.filter((s) => s.kind === 'tool');
  assert.equal(saved.steps.filter((s) => s.kind === 'think').length, 1);
  assert.equal(saved.steps[0].result, '계획: 노트를 차례로 읽는다');
  assert.equal(tools.length, 45, '45개 전부');
  assert.ok(tools.every((s) => s.status === 'ok' && s.name === 'Read'), '전부 결과가 짝지어 닫혔다');
  assert.match(tools[0].input, /file_path: vault\/notes\/a0\.md/);
  assert.match(tools[0].result, /a0 line 1/, '도구 결과(네이티브 엔진이 낸 tool_result)가 실린다');
  assert.ok(tools[0].lines >= 31, `원래 줄 수: ${tools[0].lines}`);
  assert.doesNotMatch(JSON.stringify(saved), /ghp_abcdef/, '비밀 모양은 저장본에 없다');
  assert.equal(saved.ok, true); assert.equal(saved.source, 'chat');
  const ev = (await readEvents(ws, 50)).filter((e) => e.type === 'turn' && e.slug === 'r').at(-1);
  assert.equal(ev.steps.length, 40); assert.equal(ev.stepsTotal, 45);
  assert.equal(ev.steps.at(-1).detail, 'a2.md', '마지막(45번째 = a2) 단계까지 — 40번째에서 멈추지 않는다');
  assert.equal(await getTurnStatus(ws, 'r'), null, '턴이 끝나면 상태 파일은 지워진다(종전 그대로)');
  assert.equal(T.liveTraces(ws, 'r').length, 0, '등록부에서도 빠진다');
});

test('같은 크루의 1:1 턴과 루틴 턴이 겹쳐도 기록이 섞이지 않는다 — 루틴은 저장하지 않는다', { timeout: 120_000 }, async () => {
  mid.seen = null;
  let release; mid.gate = new Promise((r) => { release = r; });
  releaseB = release;
  const [a, b] = await Promise.all([
    chat(ws, 'r', 'TURN-A 다시 읽어 줘'),
    chat(ws, 'r', 'TURN-B 루틴 점검', null, { source: 'routine' }),
  ]);
  mid.gate = null; releaseB = null;
  assert.equal(a.reply, 'A 끝'); assert.equal(b.reply, 'B 끝');
  assert.equal(b.traceId, undefined, '루틴 턴은 기록 id가 없다(저장 안 함)');
  const saved = await T.readTrace(ws, 'r', a.traceId);
  const inputs = saved.steps.filter((s) => s.kind === 'tool').map((s) => s.input);
  assert.equal(inputs.length, 45);
  assert.ok(inputs.every((x) => /notes\/a\d\.md/.test(x)), '1:1 기록에 루틴의 b.md가 섞이지 않는다');
  assert.ok(!JSON.stringify(saved).includes('only-b'), '루틴 결과도 섞이지 않는다');
});

test('라우트 — 진행 폴은 늘어난 단계만, 끝난 대화는 이 기기 요약, 펼치기는 /trace', { timeout: 120_000 }, async () => {
  const chatRoute = await import('../app/api/companies/[ws]/chat/route.js');
  const traceRoute = await import('../app/api/companies/[ws]/trace/route.js');
  const get = async (route, url) => { const r = await route.GET(new Request(`http://127.0.0.1${url}`), { params: Promise.resolve({ ws }) }); return { status: r.status, body: await r.json() }; };
  // 진행 중 폴 — 가짜 기록을 등록부에 두고 상태 파일 포인터로 고르게 한다
  const { setTurnStatus, clearTurnStatus } = await import('../src/turn-status.mjs');
  const { appendTurn } = await import('../src/thread.mjs');
  await appendTurn(ws, 'r', { userMsg: 'q0', reply: 'a0' }); // 스레드 파일이 있어야 mtime 폴(unchanged)이 선다
  const live = T.createTrace({ wsId: ws, slug: 'r', source: 'chat' });
  for (let i = 0; i < 5; i++) { live.toolStart({ id: `x${i}`, name: 'Bash', input: { command: `echo ${i}` } }); live.toolEnd(`x${i}`, { result: `${i}` }); }
  await setTurnStatus(ws, 'r', 'shell', 'echo', undefined, 'chat', undefined, live.compact(40), live.id);
  const first = await get(chatRoute, `/api/companies/${ws}/chat?slug=r`);
  assert.equal(first.body.status.trace.id, live.id);
  assert.equal(first.body.status.trace.steps.length, 5);
  assert.equal(first.body.status.steps, undefined, '옛 steps는 폴 응답에서 뺀다');
  const rev = first.body.status.trace.rev;
  live.toolStart({ id: 'x5', name: 'Bash', input: { command: 'echo 5' } });
  const next = await get(chatRoute, `/api/companies/${ws}/chat?slug=r&mtime=${first.body.mtime}&tr=${live.id}&rev=${rev}`);
  assert.equal(next.body.unchanged, true);
  assert.deepEqual(next.body.status.trace.steps.map((s) => s.i), [5], '늘어난 단계만');
  const full = await get(traceRoute, `/api/companies/${ws}/trace?slug=r&id=${live.id}`);
  assert.equal(full.body.live, true); assert.equal(full.body.trace.steps.length, 6);
  await live.finish({ ok: true }); await clearTurnStatus(ws, 'r');
  // 끝난 대화 — 대화 줄에 traceId가 있고 이 기기에 기록이 있으면 요약이 온다. 없는 id(다른 기기)는 빠진다.
  await appendTurn(ws, 'r', { userMsg: 'q1', reply: 'a1', traceId: live.id });
  await appendTurn(ws, 'r', { userMsg: 'q2', reply: 'a2', traceId: 'trzzzzzz0000aaaa' });
  const loaded = await get(chatRoute, `/api/companies/${ws}/chat?slug=r`);
  assert.deepEqual(Object.keys(loaded.body.traces), [live.id], '다른 기기에서 온 줄은 요약이 없다 = 답만 보인다');
  assert.equal(loaded.body.traces[live.id].n, 6);
  assert.equal(loaded.body.messages.find((m) => m.text === 'a1').traceId, live.id, '대화 줄에는 id만');
  const done = await get(traceRoute, `/api/companies/${ws}/trace?slug=r&id=${live.id}`);
  assert.equal(done.body.live, false); assert.equal(done.body.trace.steps.length, 6);
  assert.equal((await get(traceRoute, `/api/companies/${ws}/trace?slug=r&id=trzzzzzz0000aaaa`)).status, 404);
  assert.equal((await get(traceRoute, `/api/companies/${ws}/trace?slug=r&id=..%2F..%2Fcompany`)).status, 400);
});
