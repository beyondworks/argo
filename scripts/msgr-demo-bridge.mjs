// 데모 브리지(개발 전용) — 시드된 소유자 계정으로 로그인한 임시 아르고(가짜 러너)가 조직 채널의 @서윤·@준 멘션에 답한다. 실 AI·실자격 0.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
const SP = process.env.SP;
const seed = JSON.parse(readFileSync(`${SP}/seed.json`, 'utf8'));
const env = Object.fromEntries(readFileSync(`${process.env.APP_DIR}/.env.local`, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const ROOT = await mkdtemp(join(tmpdir(), 'argo-demo-msgr-')); const HOME = join(ROOT, 'home'); await mkdir(HOME, { recursive: true, mode: 0o700 });
process.env.ARGO_ROOT = ROOT; process.env.HOME = HOME;
for (const k of Object.keys(process.env)) if (/^NEXT_PUBLIC_SUPABASE|SUPABASE_SERVICE_ROLE_KEY|ARGO_TENANT|ARGO_SYNC/i.test(k)) delete process.env[k];
// 가짜 Anthropic SSE — 요청 본문에서 채널 발화를 뽑아 되짚는 고정형 답변(정직하게 데모임을 표시)
const sse = createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (!/\/v1\/messages/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    let ask = '';
    try { const j = JSON.parse(body); const last = [...(j.messages ?? [])].reverse().find((m) => m.role === 'user'); const t = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((c) => c.text ?? '').join('\n'); ask = (t.match(/\n([^\n]+?): ([^\n]+)/)?.[2] ?? '').slice(0, 120); } catch { /* 무시 */ }
    const reply = `요청 확인했습니다${ask ? ` — "${ask}"` : ''}. 정리해서 바로 공유하겠습니다.\n\n_(데모 러너 — 실제 AI 연결 전 고정 답변)_`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', { message: { id: 'msg_demo', type: 'message', role: 'assistant', model: 'demo', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
    ev('message_stop', {}); res.end();
  });
});
await new Promise((r) => sse.listen(0, '127.0.0.1', r));
process.env.ARGO_CLAUDE_BASE_URL = `http://127.0.0.1:${sse.address().port}`;
const owner = seed.users.find((u) => u.tag === 'owner');
const c = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const s = await c.auth.signInWithPassword({ email: owner.email, password: owner.password }); if (s.error) throw s.error;
const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const { saveDeviceSession } = await import('../src/devicesession.mjs');
const ws = 'lean-ax-dev'; // 시드의 msgr_crews.ws_id와 같아야 브리지가 자기 크루로 인식한다
await createCompany(ws, '린 컴퍼니', '유건', owner.id, 'ko');
await writeFile(join(paths(ws).agents, 'seoyun.md'), '---\nname: 서윤\nrole: 마케터\nrunner: claude\n---\n마케팅 담당.\n');
await writeFile(join(paths(ws).agents, 'jun.md'), '---\nname: 준\nrole: 데이터 분석\nrunner: claude\n---\n데이터 분석 담당.\n');
await saveRunnerCred(ws, 'claude', 'apikey', 'demo-fake-not-a-real-key');
await saveDeviceSession({ url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY, session: s.data.session });
await updateCompany(ws, { msgr: { enabled: true } });
const M = await import('../src/gateway/msgr.mjs');
const { startQueueWorker } = await import('../src/gateway/queue.mjs');
startQueueWorker(ws, M.MSGR_KEY, M.makeMsgrHandler(ws));
M.startMsgrBridge(ws, { pollMs: 5000 });
console.log(`[demo-bridge] ready — ws=${ws} root=${ROOT} owner=${owner.email}`);
setInterval(() => {}, 60_000);
