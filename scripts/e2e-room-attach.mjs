// 회의실 첨부 E2E — 격리 서버에서 업로드→회의 턴(첨부 전달)→크루가 파일 내용을 실제로 읽는지 실측.
// 사용: node scripts/e2e-room-attach.mjs   (E2E_RUNNER 기본 codex — 이 맥 claude OAuth 만료)
//       KEEP_SERVER=1이면 성공 후 서버를 유지(브라우저 시각 확인용) — ctrl-c로 종료.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PORT = 3171;
const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-room-'));
let server = null;
const fail = (msg) => { console.error(`E2E FAIL: ${msg}`); cleanup(1); };
function cleanup(code) {
  if (process.env.KEEP_SERVER && code === 0) { console.log(`[e2e] KEEP_SERVER — http://127.0.0.1:${PORT} 유지(루트 ${ROOT})`); return; }
  try { server?.kill('SIGTERM'); } catch { /* 종료됨 */ }
  rm(ROOT, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
const env = { ...process.env, ARGO_ROOT: ROOT, PORT: String(PORT), NODE_ENV: 'production' };
for (const k of Object.keys(env)) if (/SUPABASE|ARGO_TENANT|ARGO_ENFORCE|ARGO_SYNC/i.test(k)) delete env[k];

// 선행 빌드 — 낡은 .next로 옛 코드가 도는 가짜 통과 방지(분리 검수). 반복 실행은 E2E_SKIP_BUILD=1.
if (!process.env.E2E_SKIP_BUILD) {
  console.log('[e2e] next build (E2E_SKIP_BUILD=1로 생략 가능)…');
  const b = spawnSync('npx', ['next', 'build'], { stdio: 'inherit' });
  if (b.status !== 0) fail('next build 실패 — 낡은 .next로는 E2E를 신뢰할 수 없다');
}
server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const api = async (path, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...opts,
    ...(opts.body && !(opts.body instanceof FormData) ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) } : {}),
    ...(opts.body instanceof FormData ? { body: opts.body } : {}),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 비JSON */ }
  return { status: r.status, json: j, text };
};

{
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 1000)); up = await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.ok, () => false); }
  if (!up) fail('서버 기동 실패');
  console.log('[e2e] 서버 기동');
}
{
  const runner = process.env.E2E_RUNNER || 'codex';
  const r = await api('/api/account/keys', { method: 'PUT', body: { runner, type: 'host' } });
  if (r.status !== 200) fail(`${runner} host 옵트인 실패(${r.status})`);
}
let WS = null;
{
  const r = await api('/api/companies', { method: 'POST', body: { name: 'e2e-room', lang: 'ko' } });
  if (!r.json?.company?.id) fail(`회사 생성 실패: ${r.text.slice(0, 150)}`);
  WS = r.json.company.id;
}
let CREW = null;
{
  const r = await api(`/api/companies/${WS}/agents`, { method: 'POST', body: { prompt: '문서 확인 담당. 한 줄로 답한다.', name: '감마' } });
  if (!r.json?.agent?.slug) fail(`크루 영입 실패: ${r.text.slice(0, 200)}`);
  CREW = r.json.agent.slug;
  console.log(`[e2e] 회사 ${WS} · 크루 ${CREW}`);
}
// 업로드 — 크루 채팅과 같은 업로드 API 재사용(회사 스코프)
let ATT = null;
const TOKEN = 'ARGO-ROOM-E2E-7742';
{
  const fd = new FormData();
  fd.append('file', new Blob([`비밀 코드는 ${TOKEN} 이다.`], { type: 'text/plain' }), 'secret-note.txt');
  const r = await api(`/api/companies/${WS}/chat/upload`, { method: 'POST', body: fd });
  if (!r.json?.files?.length) fail(`업로드 실패(${r.status}): ${r.text.slice(0, 150)}`);
  ATT = r.json.files;
  console.log(`[e2e] 업로드: ${ATT.map((a) => a.rel).join(', ')}`);
}
// 회의 턴 — 첨부와 함께. 크루가 파일 내용을 실제로 읽어야 답할 수 있는 질문.
{
  const r = await api(`/api/companies/${WS}/room`, {
    method: 'POST',
    body: { message: `@감마 첨부한 파일에 적힌 비밀 코드를 정확히 한 줄로 알려줘.`, attachments: ATT },
  });
  if (r.status !== 200) fail(`회의 턴 실패(${r.status}): ${r.text.slice(0, 200)}`);
  const all = JSON.stringify(r.json ?? {});
  if (!all.includes(TOKEN)) fail(`크루가 첨부 내용을 읽지 못했다 — 응답에 토큰 없음: ${(r.json?.replies?.[0]?.reply ?? '').slice(0, 160)}`);
  console.log(`[e2e] 크루가 첨부 내용 인지: "${(r.json?.replies?.[0]?.reply ?? '').slice(0, 80)}"`);
}
// 방 기록에 사용자 메시지 첨부가 남았는가(UI 렌더 데이터)
{
  const r = await api(`/api/companies/${WS}/room`);
  const um = (r.json?.messages ?? []).find((m) => m.who === 'user');
  if (!um?.attachments?.length) fail('방 기록의 사용자 메시지에 attachments가 없다 — UI 칩이 안 뜬다');
  console.log('[e2e] 방 기록 attachments 확인');
}
console.log('E2E OK: 회의실 첨부 업로드→턴 전달→크루 실인지→기록 렌더 데이터');
cleanup(0);
