// 네이티브 압축(B2)이 실제 크루 턴(chat)에서 일어나면 크루 대화 기록에 작은 안내 줄("앞 대화를 요약해 이어 갑니다")이 남는다. 창 크기는 카탈로그 값(없으면 128,000토큰)을 쓴다. 실벤더 호출 0 — OpenRouter 엔드포인트를 로컬 가짜로.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-compact-chat-'));
const home = await mkdtemp(join(tmpdir(), 'argo-compact-chat-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off' });
delete process.env.ARGO_NATIVE_RUNNERS;
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

const calls = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const body = JSON.parse(b || '{}');
    const kind = (body.tools ?? []).length ? 'turn' : 'summary';
    calls.push({ kind, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: kind === 'summary' ? '요약-TOKEN' : '턴 답' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { loadThread, appendTurn } = await import('../src/thread.mjs');
const { sessionFile } = await import('../src/engine/session.mjs');

test('NCC1. 압축이 일어난 턴 — 스레드에 요약 안내 줄(src notice code summarized)이 남고, 다음 턴엔 안내 줄이 더 생기지 않는다', async () => {
  const ws = 'ncc'; await createCompany(ws, '압축', 'owner', null, 'ko');
  const p = paths(ws); await mkdir(p.agents, { recursive: true });
  await writeFile(join(p.agents, 'r.md'), '---\nname: 로라\nrole: 검증\nrunner: openrouter\n---\n검증 크루.\n');
  await saveRunnerCred(ws, 'openrouter', 'apikey', `sk-or-v1-${'f'.repeat(64)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜로만
  const first = await chat(ws, 'r', '첫 지시');
  assert.equal(first.reply, '턴 답');
  await appendTurn(ws, 'r', { userMsg: '첫 지시', reply: first.reply, handover: null, sessionId: first.sessionId });
  // 같은 세션 id로 긴 전사(100턴 × 3,000자 ≈ 100,000토큰 > 128,000의 75%)를 깔아 둔다
  const f = sessionFile(ws, 'r'); const saved = JSON.parse(await readFile(f, 'utf8'));
  const messages = [];
  for (let i = 0; i < 100; i++) messages.push({ role: 'user', content: `u${i}| ${'x'.repeat(3000)}` }, { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
  await mkdir(dirname(f), { recursive: true }); await writeFile(f, JSON.stringify({ ...saved, messages }));
  calls.length = 0;
  const second = await chat(ws, 'r', '이어서', first.sessionId);
  assert.equal(second.reply, '턴 답');
  assert.deepEqual(calls.map((c) => c.kind), ['summary', 'turn'], '같은 러너(OpenRouter) 원샷으로 요약 1회 뒤 턴');
  const t = await loadThread(ws, 'r');
  const notes = t.messages.filter((m) => m.src?.kind === 'session' && m.src.dir === 'notice' && m.src.code === 'summarized');
  assert.equal(notes.length, 1, '요약 안내 줄 1개');
  assert.match(notes[0].text, /앞 대화를 요약해 이어 갑니다/);
  calls.length = 0;
  await chat(ws, 'r', '하나 더', second.sessionId);
  assert.deepEqual(calls.map((c) => c.kind), ['turn'], '다음 턴은 요약 없이');
  const t2 = await loadThread(ws, 'r');
  assert.equal(t2.messages.filter((m) => m.src?.code === 'summarized').length, 1, '안내 줄이 더 생기지 않는다');
});

// 검수 changes_needed #1(HIGH) — 최근 20턴만으로 창의 95%를 넘는 대화(기본 창 128,000토큰)에서 5턴 연속: 요약 원샷은 1회 이하, 크루 대화 기록의 안내 줄은 1개.
// 종전에는 긴급 경로가 턴마다 요약 + 안내 줄 + 스레드 쓰기(동기화 업로드)를 냈다. 한글 1자 = 3바이트 = 1토큰(추정)이라 글자 수 상한(40만 자) 안에서 재현된다.
test('NCC2. 최근 20턴만으로 95% 초과 — 5턴 연속 요약 1회 이하·안내 줄 1개', async () => {
  const ws = 'ncc2'; await createCompany(ws, '압축', 'owner', null, 'ko');
  const p = paths(ws); await mkdir(p.agents, { recursive: true });
  await writeFile(join(p.agents, 'r.md'), '---\nname: 로라\nrole: 검증\nrunner: openrouter\n---\n검증 크루.\n');
  await saveRunnerCred(ws, 'openrouter', 'apikey', `sk-or-v1-${'f'.repeat(64)}`);
  calls.length = 0;
  const first = await chat(ws, 'r', '첫 지시');
  await appendTurn(ws, 'r', { userMsg: '첫 지시', reply: first.reply, handover: null, sessionId: first.sessionId });
  const f = sessionFile(ws, 'r'); const saved = JSON.parse(await readFile(f, 'utf8'));
  const messages = [];
  // 지시 1개 ≈ 8,000토큰 — 새 짧은 지시 4개가 최근 20턴에 들어와도(5턴째) 남은 큰 지시 15개 ≈ 120,000 + 도구·지시문으로 계속 95%(121,600)를 넘는다
  for (let i = 0; i < 25; i++) messages.push({ role: 'user', content: `u${i}| ${'가'.repeat(8000)}` }, { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
  await writeFile(f, JSON.stringify({ ...saved, messages }));
  calls.length = 0;
  let sid = first.sessionId;
  for (let i = 0; i < 5; i++) { const r = await chat(ws, 'r', `이어서 ${i}`, sid); assert.equal(r.reply, '턴 답'); sid = r.sessionId; }
  const summaries = calls.filter((c) => c.kind === 'summary').length;
  assert.ok(summaries <= 1, `요약 호출 ${summaries}회(1회 이하)`);
  const notes = (await loadThread(ws, 'r')).messages.filter((m) => m.src?.code === 'summarized');
  assert.equal(notes.length, 1, `안내 줄 ${notes.length}개(1개)`);
});
