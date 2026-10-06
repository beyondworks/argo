// 스레드 맥락 토큰 예산(B3') — Claude SDK 다른 기기 이어받기 축. 실제 SDK 턴(claude-agent-sdk)을 로컬 가짜 Messages 엔드포인트로 돌린다
// (ARGO_CLAUDE_BASE_URL — 실자격·비용 0). 다른 기기의 세션은 resume하지 않고 새 세션에 스레드 맥락을 붙인다 — 종전 최근 6개 → 예산 + 누적 요약.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-ctxb-sdk-'));
const home = await mkdtemp(join(tmpdir(), 'argo-ctxb-sdk-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];
// 호스트 Claude Code가 심은 변수(CLAUDE_CODE_ENTRYPOINT 등)가 SDK 자식에 새면 SDK의 곁가지 요청이 달라진다 — 맥 개발 셸에서는 상태 분류 요청,
// 깨끗한 환경(CI·env -i·데스크톱 앱)에서는 자동 제목 생성 요청이 나갔다(2026-10-06 실측). 어느 셸에서 돌려도 CI와 같은 결과가 되게 지운다.
for (const key of Object.keys(process.env)) if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|ANTHROPIC_)/.test(key)) delete process.env[key];

const reqs = [];
let slowSummary = false;
const sse = (res, text, usage = { input_tokens: 1, output_tokens: 1 }) => {
  if (res.destroyed) return;
  const ev = [['message_start', { type: 'message_start', message: { id: `m${reqs.length}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } }], ['message_stop', { type: 'message_stop' }]];
  res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [e, d] of ev) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end();
};
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const body = JSON.parse(b || '{}'); const all = JSON.stringify(body.messages ?? []);
      // SDK 자동 제목 생성은 첫 글 전체(요약 지시면 <conversation>까지)를 감싸 보낸다 — 요약으로 세지 않고 따로 센다(Argo는 title을 줘서 끈다)
      const title = JSON.stringify(body.system ?? '').includes('naming a coding session');
      const kind = title ? 'title' : all.includes('<conversation>') ? 'summary' : (body.tools ?? []).length ? 'turn' : 'other';
      reqs.push({ kind, messages: all });
      if (kind === 'summary' && slowSummary) return setTimeout(() => sse(res, '늦은 요약'), 15_000);
      return sse(res, kind === 'summary' ? '요약-SDK 결정은 금요일 마감' : kind === 'turn' ? '턴 답' : 'title', kind === 'summary' ? { input_tokens: 4321, output_tokens: 765 } : undefined);
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { chat } = await import('../src/chat.mjs');
const { loadThread, threadSummary } = await import('../src/thread.mjs');
const ws = 'ctxb-sdk';
await createCompany(ws, '예산', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'a.md'), '---\nname: 알파\nrole: 검증\nrunner: claude\n---\n검증 크루.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜로만
const T0 = 1_700_000_000_000;
const msgs = (n, len) => Array.from({ length: n }, (_, i) => ({ who: i % 2 ? 'crew' : 'user', text: `m${i}| ${'가'.repeat(len)}`, ts: T0 + i * 1000 }));
const otherDevice = (messages) => writeFile(join(p.chats, 'a.json'), JSON.stringify({ sessionId: 'old-sess', sessionDevice: 'other-device', messages }));

test('TBS1. 다른 기기 세션 — 6개 넘는 최근 대화를 새 세션 첫 글에 붙인다(요약 호출 없음)', async () => {
  await otherDevice(msgs(30, 20)); reqs.length = 0;
  const r = await chat(ws, 'a', '이어서', 'old-sess');
  assert.equal(r.reply, '턴 답');
  const turn = reqs.find((q) => q.kind === 'turn');
  for (const i of [0, 7, 29]) assert.ok(turn.messages.includes(`m${i}|`), `m${i} 줄`);
  assert.equal(reqs.filter((q) => q.kind === 'summary').length, 0);
});

test('TBS2. 다른 기기 세션 + 긴 스레드 — 같은 러너(Claude SDK) 원샷으로 요약 1회, 첫 글에 요약과 최근 대화, 스레드에 저장', async () => {
  await otherDevice(msgs(300, 400)); reqs.length = 0;
  const r = await chat(ws, 'a', '보고서 이어서', 'old-sess');
  assert.equal(r.reply, '턴 답');
  assert.equal(reqs.filter((q) => q.kind === 'summary').length, 1, '요약 1회');
  assert.equal(reqs.filter((q) => q.kind === 'title').length, 0, 'SDK 자동 제목 생성 요청 없음(요약 원샷·턴 둘 다 title 옵션)');
  const turn = reqs.find((q) => q.kind === 'turn');
  assert.ok(turn.messages.includes('요약-SDK 결정은 금요일 마감'), '첫 글에 요약');
  assert.ok(turn.messages.includes('m299|'), '최근 대화');
  assert.ok(!turn.messages.includes('m0|'), '예산 밖 원문은 싣지 않는다');
  const s = threadSummary(await loadThread(ws, 'a'), null);
  assert.equal(s?.text, '요약-SDK 결정은 금요일 마감');
});

// 검수 changes_needed #4(MEDIUM) — 요약 원샷의 사용량·비용을 버리면(.then(r => r.text)) API 키 러너의 요약 비용이 사용량 원장·월 지출 한도에 안 잡힌다.
test('TBS3. 요약 원샷 비용 — 사용량 원장에 요약 행(kind summary, 그 크루, 청구 여부, 토큰·금액)이 남아 월 지출에 들어간다', async (t) => {
  const { readFile } = await import('node:fs/promises');
  await otherDevice(msgs(300, 400)); reqs.length = 0;
  const before = (await readFile(p.usage, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const r = await chat(ws, 'a', '보고서 이어서', 'old-sess');
  assert.equal(r.reply, '턴 답');
  assert.equal(reqs.filter((q) => q.kind === 'summary').length, 1, '요약 1회');
  const rows = (await readFile(p.usage, 'utf8')).split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
  const row = rows.find((x) => x.kind === 'summary');
  assert.ok(row, `요약 행(${rows.map((x) => x.kind).join(',')})`);
  assert.equal(row.slug, 'a'); assert.equal(row.runner, 'claude'); assert.equal(row.billed, true, 'API 키 러너 — 청구');
  assert.equal(row.input, 4321); assert.equal(row.output, 765);
  assert.equal(typeof row.costUsd, 'number', `SDK가 낸 금액을 싣는다(${row.costUsd})`);
  assert.ok(row.costUsd > 0, `금액 > 0(${row.costUsd})`);
  const { monthCost } = await import('../src/usage.mjs');
  const turnRow = rows.find((x) => x.kind === 'chat');
  const m = (await monthCost(ws)).costUsd;
  assert.ok(m >= row.costUsd + (turnRow?.costUsd ?? 0) - 1e-9, `월 지출(${m})에 요약 금액이 들어간다`);
  assert.ok(Math.abs((r.costUsd ?? 0) - (row.costUsd + (turnRow?.costUsd ?? 0))) < 1e-9, `턴 금액(루프 루틴 예산) = 턴 + 요약(${r.costUsd})`);
  t.diagnostic(`요약 행 ${row.input}/${row.output}토큰 $${row.costUsd}, 턴 행 $${turnRow?.costUsd}`);
});

test('TBS4. 요약 중 정지 — SDK 요약 원샷이 바로 끊기고(15초 늦은 응답을 기다리지 않는다) 턴은 중단으로 끝난다', async () => {
  const { interruptTurn } = await import('../src/turn-abort.mjs');
  const { readFile } = await import('node:fs/promises');
  await otherDevice(msgs(300, 400)); reqs.length = 0; slowSummary = true;
  try {
    const turn = chat(ws, 'a', '보고서 이어서', 'old-sess');
    turn.catch(() => {});
    const statusFile = join(p.chats, 'a.status.json');
    let stage = null;
    for (let i = 0; i < 150 && stage !== 'summarize'; i++) { await new Promise((r) => setTimeout(r, 100)); stage = JSON.parse(await readFile(statusFile, 'utf8').catch(() => '{}')).stage ?? null; }
    assert.equal(stage, 'summarize', '요약 중 상태');
    for (let i = 0; i < 100 && !reqs.some((q) => q.kind === 'summary'); i++) await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    assert.equal(await interruptTurn(ws, 'a'), true);
    await assert.rejects(turn, (e) => e?.aborted === true);
    assert.ok(Date.now() - t0 < 8000, `정지 뒤 ${Date.now() - t0}ms`);
    assert.equal(reqs.filter((q) => q.kind === 'turn').length, 0, '턴 요청은 나가지 않는다');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await readFile(statusFile, 'utf8').catch(() => null), null, '상태 파일 정리');
  } finally { slowSummary = false; }
});
