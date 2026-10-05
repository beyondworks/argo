// 네이티브 엔진 토큰 예산 + 요약 압축(B2) — 대화(system·도구·전사)가 모델 컨텍스트 창의 75%를 넘으면 최근 20턴은 그대로 두고
// 그 앞부분을 같은 러너의 원샷으로 요약해 요약 블록 하나로 바꾼다. 요약이 실패하면 앞부분을 잘라낸다(턴은 이어 간다).
// 잦은 요약 호출을 막는다: 한 번 요약한 세션은 앞부분에 새 턴이 10개 이상 쌓여야 다시 요약한다. 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-compact-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-compact-'));
process.env.ARGO_MODEL_CATALOG = 'off';

const { nativeQuery } = await import('../src/engine/native-query.mjs');
const { sessionFile } = await import('../src/engine/session.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');

/** 가짜 Messages 서버 — 도구 없는 요청(원샷 요약)과 도구 있는 요청(턴)을 나눠 기록한다. summary(body)가 요약 응답을 정한다. */
async function fake({ summary = () => ({ status: 200, text: 'SUMMARY-TOKEN 결정: 보고서는 금요일까지' }) } = {}) {
  const calls = [];
  const srv = createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => {
      const body = JSON.parse(d || '{}');
      const kind = (body.tools ?? []).length ? 'turn' : 'summary';
      calls.push({ kind, body });
      const s = kind === 'summary' ? summary(body) : { status: 200, text: '턴 답' };
      res.writeHead(s.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(s.status === 200
        ? { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: s.text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
        : { type: 'error', error: { type: 'invalid_request_error', message: 'bad summary request' } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}
const env = (base) => ({ ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'tok-fake-1234567890', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' });
async function collect(q) { const out = []; for await (const m of q) out.push(m); return out; }
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));
const isPrompt = (m) => m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'));

/** 이전 턴 n개(사장 지시 3,000자 + 크루 답)를 세션 파일로 깔아 둔다 — 지시 1개 ≈ 1,000토큰(utf-8 바이트/3) */
async function seed(ws, n, id = 'native-seed') {
  const messages = [];
  for (let i = 0; i < n; i++) messages.push({ role: 'user', content: `u${i}| ${'x'.repeat(3000)}` }, { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
  const f = sessionFile(ws, 'crew'); await mkdir(dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify({ id, at: Date.now(), messages }));
  return id;
}
const run = (ws, base, resume, opts = {}) => collect(nativeQuery({ wsId: ws, slug: 'crew', prompt: '새 지시', cwd: paths(ws).root, systemPrompt: 'SYS', env: env(base), model: 'm', resume, browser: false, contextTokens: 30_000, ...opts }));

test('NC1. 창의 75%를 넘으면 요약 1회 — 앞부분(u0~u10)만 요약에, 최근 20턴(u11~u29 + 새 지시)은 그대로, 요약은 첫 지시 앞 블록으로', async () => {
  const ws = 'nc1'; await createCompany(ws, '압축', '사장');
  const id = await seed(ws, 30);
  const srv = await fake();
  try {
    const out = await run(ws, srv.base, id);
    assert.equal(out.at(-1).subtype, 'success', '턴은 성공');
    assert.deepEqual(srv.calls.map((c) => c.kind), ['summary', 'turn'], '요약 1회 뒤 턴');
    const sumPrompt = textOf(srv.calls[0].body.messages[0]);
    assert.match(sumPrompt, /u0\|/); assert.match(sumPrompt, /u10\|/);
    assert.doesNotMatch(sumPrompt, /u11\|/, '최근 20턴은 요약에 넣지 않는다');
    const msgs = srv.calls[1].body.messages;
    assert.equal(msgs.filter(isPrompt).length, 20, '최근 20턴(새 지시 포함)');
    assert.match(textOf(msgs[0]), /SUMMARY-TOKEN/, '요약은 남은 첫 지시 앞에');
    assert.match(textOf(msgs[0]), /u11\| x{3000}/, '첫 지시 원문은 그대로');
    assert.ok(!msgs.some((m) => /u10\|/.test(textOf(m))), '요약한 앞부분 원문은 빠진다');
    assert.equal(textOf(msgs.at(-1)), '새 지시');
    for (let i = 1; i < msgs.length; i++) assert.notEqual(msgs[i].role, msgs[i - 1].role, '역할 교대 유지');
    const b = out.find((m) => m.type === 'system' && m.subtype === 'compact_boundary');
    assert.ok(b, '압축 경계 메시지(SDK와 같은 모양)를 낸다'); assert.equal(b.compact_metadata.trigger, 'auto');
    assert.equal(out.at(-1).usage.input_tokens, 20, '요약 호출 토큰도 턴 사용량에 합산');
    const saved = JSON.parse(await readFile(sessionFile(ws, 'crew'), 'utf8'));
    assert.match(textOf(saved.messages[0]), /SUMMARY-TOKEN/, '요약된 전사가 저장된다');
    // 바로 다음 턴 — 앞부분에 새 턴이 1개뿐이라 요약을 다시 부르지 않는다(턴마다 요약 금지)
    const out2 = await run(ws, srv.base, out[0].session_id);
    assert.equal(out2.at(-1).subtype, 'success');
    assert.deepEqual(srv.calls.map((c) => c.kind), ['summary', 'turn', 'turn'], '연속 턴에 요약 재호출 없음');
  } finally { await srv.close(); }
});

test('NC2. 요약이 실패하면 잘라내기로 대신한다 — 턴은 성공, 최근 20턴 보존, 앞부분 제거, 압축 경계는 내지 않는다', async () => {
  const ws = 'nc2'; await createCompany(ws, '압축', '사장');
  const id = await seed(ws, 30);
  const srv = await fake({ summary: () => ({ status: 400 }) });
  try {
    const out = await run(ws, srv.base, id);
    assert.equal(out.at(-1).subtype, 'success', '요약 실패가 턴을 죽이지 않는다');
    assert.deepEqual(srv.calls.map((c) => c.kind), ['summary', 'turn']);
    const msgs = srv.calls[1].body.messages;
    assert.ok(!msgs.some((m) => /u0\|/.test(textOf(m))), '가장 오래된 지시는 잘린다');
    assert.ok(msgs.filter(isPrompt).length >= 20, '최근 20턴은 남는다');
    assert.ok(isPrompt(msgs[0]), '머리는 지시');
    assert.ok(!out.some((m) => m.subtype === 'compact_boundary'), '요약하지 않았으면 경계 메시지 없음');
  } finally { await srv.close(); }
});

test('NC3. 창의 75% 이하면 요약하지 않는다(기본 창 128,000토큰 — 카탈로그 값이 없을 때)', async () => {
  const ws = 'nc3'; await createCompany(ws, '압축', '사장');
  const id = await seed(ws, 30);
  const srv = await fake();
  try {
    const out = await run(ws, srv.base, id, { contextTokens: undefined });
    assert.equal(out.at(-1).subtype, 'success');
    assert.deepEqual(srv.calls.map((c) => c.kind), ['turn'], '요약 호출 없음');
    assert.equal(srv.calls[0].body.messages.filter(isPrompt).length, 31, '전사 그대로');
  } finally { await srv.close(); }
});

test('NC4. 최근 20턴뿐이면(앞부분 없음) 넘어도 요약하지 않는다 — 최근 20턴 보존 규칙이 우선', async () => {
  const ws = 'nc4'; await createCompany(ws, '압축', '사장');
  const id = await seed(ws, 19);
  const srv = await fake();
  try {
    const out = await run(ws, srv.base, id, { contextTokens: 10_000 });
    assert.equal(out.at(-1).subtype, 'success');
    assert.deepEqual(srv.calls.map((c) => c.kind), ['turn']);
    assert.equal(srv.calls[0].body.messages.filter(isPrompt).length, 20);
  } finally { await srv.close(); }
});

// ── 검수 changes_needed #1(HIGH) — 추정이 이미지 base64까지 바이트/3으로 세어 스크린샷 1장 ≈ 60,000토큰이 됐다. 최근 20턴에 2장이면
// 95% 긴급 경로가 턴마다 요약 원샷 + 안내 줄 + 스레드 쓰기를 냈다. 이미지·문서 블록은 고정값(1,600토큰)으로 세고, 긴급 경로에도 최소 간격을 둔다.
/** 5턴 연속 실행 — 각 턴의 요약 호출 수·압축 경계 수를 모은다 */
async function fiveTurns(ws, srv, id, opts) {
  let resume = id; let boundaries = 0;
  for (let i = 0; i < 5; i++) {
    const out = await run(ws, srv.base, resume, opts);
    assert.equal(out.at(-1).subtype, 'success', `턴 ${i + 1} 성공`);
    boundaries += out.filter((m) => m.type === 'system' && m.subtype === 'compact_boundary').length;
    resume = out[0].session_id;
  }
  return { summaries: srv.calls.filter((c) => c.kind === 'summary').length, boundaries };
}
/** 이전 턴을 직접 깐다 — turns = [{ chars, image }] (image = base64 글자 수, 그 지시에 첨부 이미지 블록으로) */
async function seedTurns(ws, turns, id = 'native-seed2') {
  const messages = [];
  turns.forEach((t, i) => {
    const text = `u${i}| ${'x'.repeat(t.chars)}`;
    messages.push({ role: 'user', content: t.image ? [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(t.image) } }] : text },
      { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] });
  });
  const f = sessionFile(ws, 'crew'); await mkdir(dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify({ id, at: Date.now(), messages }));
  return id;
}

test('NC5. 최근 20턴에 스크린샷 2장(base64 15만 자씩) — 5턴 연속에서 요약 호출 1회 이하·압축 경계(안내 줄) 1개', async () => {
  const ws = 'nc5'; await createCompany(ws, '압축', '사장');
  // 앞부분 12턴 × 1,000토큰(정당한 압축 1회 몫) + 최근 20턴 짧은 지시, 그중 2턴에 스크린샷
  const turns = [...Array.from({ length: 12 }, () => ({ chars: 3000 })), ...Array.from({ length: 20 }, (_, k) => ({ chars: 300, ...(k === 5 || k === 15 ? { image: 150_000 } : {}) }))];
  const id = await seedTurns(ws, turns);
  const srv = await fake();
  try {
    const r = await fiveTurns(ws, srv, id, { contextTokens: 20_000 });
    assert.ok(r.summaries <= 1, `요약 호출 ${r.summaries}회(1회 이하)`);
    assert.equal(r.boundaries, 1, `압축 경계 ${r.boundaries}개(1개)`);
    const lastTurn = srv.calls.filter((c) => c.kind === 'turn').at(-1).body;
    assert.equal(JSON.stringify(lastTurn.messages).match(/"type":"image"/g)?.length, 2, '스크린샷 2장은 그대로 벤더에 간다');
  } finally { await srv.close(); }
});

test('NC6. 최근 20턴만으로 창의 95%를 넘는다 — 5턴 연속에서 요약 호출 1회 이하·압축 경계 1개(긴급 경로도 최소 간격·효과 있을 때만)', async () => {
  const ws = 'nc6'; await createCompany(ws, '압축', '사장');
  const id = await seedTurns(ws, Array.from({ length: 25 }, () => ({ chars: 5000 }))); // 지시 1개 ≈ 1,667토큰 → 최근 19개만 ≈ 31,700 > 30,000의 95%
  const srv = await fake();
  try {
    const r = await fiveTurns(ws, srv, id, { contextTokens: 30_000 });
    assert.ok(r.summaries <= 1, `요약 호출 ${r.summaries}회(1회 이하)`);
    assert.equal(r.boundaries, 1, `압축 경계 ${r.boundaries}개(1개)`);
  } finally { await srv.close(); }
});

test('NC7. 추정(순수) — 이미지·문서 블록은 base64 길이와 무관하게 고정값, 도구 결과 안의 이미지도 같다', async () => {
  const { estimateTokens, IMAGE_TOKENS } = await import('../src/engine/compact.mjs');
  const img = (n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(n) } });
  const small = estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }, img(10)] }]);
  const big = estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'hi' }, img(600_000)] }]);
  assert.equal(big, small, 'base64 길이는 추정에 들어가지 않는다');
  assert.ok(big >= IMAGE_TOKENS && big < IMAGE_TOKENS + 100, `이미지 1장 ≈ ${IMAGE_TOKENS}토큰(${big})`);
  const nested = estimateTokens([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'shot' }, img(400_000)] }] }]);
  assert.ok(nested < IMAGE_TOKENS + 100, `도구 결과 안 스크린샷도 고정값(${nested})`);
  const doc = estimateTokens([{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'B'.repeat(900_000) } }] }]);
  assert.ok(doc < IMAGE_TOKENS + 100, `문서 블록도 고정값(${doc})`);
  assert.equal(estimateTokens('가'.repeat(300)), 300, '글은 종전대로 utf-8 바이트/3');
});
