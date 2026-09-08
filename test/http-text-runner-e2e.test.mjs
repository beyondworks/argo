// HTTP 텍스트 러너 E2E(부록 N) — 실제 chat() 턴이 카드 `runner: http` + `endpoint:`로 가짜 엔드포인트를 두드리고 답을 스레드에 싣는다.
// 실벤더 0, 임시 ARGO_ROOT(실데이터 미접촉). 회사 자격(http apikey)이 Bearer로 도달하는지·401이면 턴이 정직하게 실패하는지까지.
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-http-e2e-'));
process.env.ARGO_ROOT = ROOT; delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
process.env.ARGO_MODEL_CATALOG = 'off'; process.env.ARGO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'argo-http-e2e-cache-')); // 실 ~/.argo/cache 미접촉(readCache는 off 게이트보다 먼저)
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { chat } = await import('../src/chat.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');

const seen = [];
const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
  seen.push({ auth: req.headers.authorization, body: JSON.parse(b) });
  if (req.headers.authorization !== 'Bearer hermes-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: `외부 엔진 답: ${JSON.parse(b).prompt.slice(-12)}` }));
}); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${srv.address().port}/v1/turn`;

async function mkws(ws) {
  for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) await mkdir(join(ROOT, ws, ...d), { recursive: true });
  await writeFile(join(ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: '린', owner: 'me', lang: 'ko', created: new Date().toISOString() }));
  await writeFile(join(ROOT, ws, 'agents', 'hermes.md'), `---\nname: 헤르메스\nrole: 외부 에이전트\nrunner: http\nendpoint: ${ENDPOINT}\n---\n외부 HTTP 엔진으로 답한다.\n`);
}

test('chat() — runner http 크루가 카드 endpoint로 턴을 돌리고 답을 반환한다(Bearer = 회사 http 자격)', async () => {
  const WS = 'e2e-http'; await mkws(WS);
  await saveRunnerCred(WS, 'http', 'apikey', 'hermes-key');
  const r = await chat(WS, 'hermes', '오늘 할 일 알려줘');
  assert.match(r.reply, /^외부 엔진 답: /, `답이 엔드포인트에서 왔다: ${r.reply?.slice(0, 80)}`);
  assert.equal(seen.at(-1).auth, 'Bearer hermes-key'); assert.equal(seen.at(-1).body.kind, 'chat'); assert.ok(seen.at(-1).body.prompt.includes('오늘 할 일 알려줘'));
});

test('chat() — 자격이 틀리면 401이 정직한 실패로 표면화된다(조용한 폴백 없음)', async () => {
  const WS = 'e2e-http-bad'; await mkws(WS);
  await saveRunnerCred(WS, 'http', 'apikey', 'wrong');
  const r = await chat(WS, 'hermes', '안녕').catch((e) => ({ reply: String(e.message) }));
  assert.match(String(r.reply), /401|인증|자격|API Error/, `401이 삼켜지지 않는다: ${String(r.reply).slice(0, 120)}`);
  assert.equal(seen.at(-1).auth, 'Bearer wrong');
  // 불변식 A(분리 검수 HIGH-1): 벤더 401이 각인돼 **다음 턴은 엔드포인트를 두드리지 않고** 실행 전에 끊긴다
  const before = seen.length;
  const r2 = await chat(WS, 'hermes', '다시').catch((e) => ({ reply: String(e.message), authExpired: e.authExpired }));
  assert.equal(seen.length, before, '게이트가 실행 전에 끊는다 — 틀린 키로 외부 엔드포인트를 계속 두드리지 않는다');
  assert.match(String(r2.reply), /401|인증|자격|known-invalid|API Error|재연결/, String(r2.reply).slice(0, 120));
});

test('chat() — 다른 러너(claude)가 연결돼 있어도 http 크루는 폴백하지 않고(2차 검수 HIGH-A) 401을 각인해 다음 턴을 끊는다', async () => {
  const WS = 'e2e-http-nofb'; await mkws(WS);
  await saveRunnerCred(WS, 'http', 'apikey', 'wrong');
  await saveRunnerCred(WS, 'claude', 'apikey', 'sk-ant-fake-not-real-000000');
  process.env.ARGO_CLAUDE_BASE_URL = 'http://127.0.0.1:9'; // 폴백이 일어나면 여기로 나가 status 0 — 답에 흔적이 남는다
  try {
    const before = seen.length;
    const r = await chat(WS, 'hermes', '안녕').catch((e2) => ({ reply: String(e2.message) }));
    assert.equal(seen.length, before + 1, '엔드포인트 1회');
    assert.doesNotMatch(String(r.reply), /Claude|claude/, `외부 두뇌 크루가 Claude로 대체 답변하지 않는다: ${String(r.reply).slice(0, 120)}`);
    const r2 = await chat(WS, 'hermes', '다시').catch((e2) => ({ reply: String(e2.message) }));
    assert.equal(seen.length, before + 1, '401 각인 → 두 번째 턴은 실행 전에 끊긴다(다른 러너가 있어도)');
    assert.match(String(r2.reply), /401|인증|자격|known-invalid|API Error|재연결/, String(r2.reply).slice(0, 120));
  } finally { delete process.env.ARGO_CLAUDE_BASE_URL; }
});

test('chat() — 회사 http 자격이 없어도(무인증 엔드포인트) 카드만으로 그 엔드포인트에 간다 — claude가 연결돼 있어도 대체하지 않는다', async () => {
  const WS = 'e2e-http-nocred'; await mkws(WS);
  await saveRunnerCred(WS, 'claude', 'apikey', 'sk-ant-fake-not-real-000000');
  process.env.ARGO_CLAUDE_BASE_URL = 'http://127.0.0.1:9';
  try {
    const before = seen.length;
    const r = await chat(WS, 'hermes', '자격 없이').catch((e2) => ({ reply: String(e2.message) }));
    assert.equal(seen.length, before + 1, '엔드포인트 1회(대체 없음)');
    assert.equal(seen.at(-1).auth, undefined, 'Bearer 없음');
    assert.doesNotMatch(String(r.reply), /Claude|claude|대체/, String(r.reply).slice(0, 120));
  } finally { delete process.env.ARGO_CLAUDE_BASE_URL; }
});

test.after(() => new Promise((r) => srv.close(r)));
