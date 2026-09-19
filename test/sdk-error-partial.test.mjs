// 크루 턴이 모델 오류(529 과부하 등)로 끝날 때, 턴 도중 상태 파일의 부분 답(partial)에 오류 원문이 실리지 않는다(D26 재확인 — 정비사).
// 실측: 실행 카드 "지금까지 말한 것"에 "API Error: Repeated 529 … inference gateway (127.0.0.1:5291)"가 약 10초 손님 화면으로 방송됐다.
// 원인: SDK는 API 오류를 `error` 필드가 붙은 합성 assistant 메시지로 내보내고, chat()은 그 텍스트를 부분 답에 이어 붙였다.
// **실제 SDK(claude-agent-sdk)를 돌린다** — 모델만 로컬 가짜 Messages 엔드포인트(ARGO_CLAUDE_BASE_URL)가 529를 돌려준다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-sdk-error-partial-'));
const home = await mkdtemp(join(tmpdir(), 'argo-sdk-error-partial-home-'));
Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off', CLAUDE_CODE_MAX_RETRIES: '0' });
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[key];

let hits = 0;
const srv = http.createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => {
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      hits += 1;
      res.writeHead(529, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded — check your inference gateway (127.0.0.1:5291)' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const { createCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const turnStatus = await import('../src/turn-status.mjs');
const { chat } = await import('../src/chat.mjs');
const ws = 'sdk-error-partial';
await createCompany(ws, 'SDK 오류 부분 답', 'owner', null, 'ko');
const p = paths(ws);
await mkdir(p.agents, { recursive: true });
await writeFile(join(p.agents, 'x.md'), '---\nname: 엑스\nrole: 검증\nrunner: claude\n---\n검증용.\n');
await saveRunnerCred(ws, 'claude', 'apikey', `sk-ant-api03-${'x'.repeat(80)}`); // 형식만 맞춘 가짜 — 요청은 로컬 가짜 엔드포인트로만 간다

test('SDK 턴이 529로 끝나도 턴 도중 부분 답(partial)에 오류 원문·주소가 없다', { timeout: 180_000 }, async () => {
  const seen = []; // 턴 도중 상태 파일에 쓰인 부분 답을 전부 모은다(메신저 pump가 1.5초마다 읽어 방송하는 값)
  const poll = setInterval(async () => { const s = await turnStatus.getTurnStatus(ws, 'x').catch(() => null); if (s?.partial) seen.push(String(s.partial)); }, 50);
  let err = null;
  try { await chat(ws, 'x', '안녕', null, { source: 'messenger' }); } catch (e) { err = e; } finally { clearInterval(poll); }
  assert.ok(hits >= 1, `실제 SDK가 가짜 엔드포인트를 불렀다 — hits=${hits}`);
  assert.ok(err, '턴은 실패로 끝난다(오류 원문은 활동 로그·예외로만)');
  for (const partial of seen) {
    for (const leak of [/127\.0\.0\.1/, /5291/, /inference gateway/, /API Error/, /Overloaded/i]) assert.doesNotMatch(partial, leak, `부분 답에 오류 원문이 실렸다: ${partial.slice(0, 160)}`);
  }
});
