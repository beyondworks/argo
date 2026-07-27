// 허용 폴더(fsRoots) E2E — 격리 서버 + codex 실 LLM으로 "fs ON + 허용 폴더 등록 → 홈 밖 쓰기 성공"을
// 실측한다(P0-1 (B) 갈래의 수용 기준). 대조군: 등록 **전**에는 같은 지시가 실패해야 한다(홈 밖 차단 유지).
// 사용: node scripts/e2e-fs-roots.mjs   (E2E_RUNNER 기본 codex)
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 3181;
const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-fsroots-'));
// 홈 밖이면서 **tmp도 아닌** 경로 — codex 샌드박스는 시스템 tmp($TMPDIR·/var/folders)를 기본
// 허용해서(1차 실행 실측: 등록 전 대조군이 tmp에 써짐) tmp로는 경계를 검증할 수 없다.
// /Users/Shared = macOS 표준 공유 폴더(사용자 쓰기 가능, 홈 밖, tmp 아님).
const { mkdir: mkdirP } = await import('node:fs/promises');
const OUTSIDE = join('/Users/Shared', `argo-e2e-fsroots-${Date.now().toString(36)}`);
await mkdirP(OUTSIDE, { recursive: true });
let server = null;
const fail = (msg) => { console.error(`E2E FAIL: ${msg}`); cleanup(1); throw new Error('E2E-ABORT'); }; // throw — fail 후 흐름 계속(1차 실행 결함) 차단
function cleanup(code) {
  try { server?.kill('SIGTERM'); } catch { /* 종료됨 */ }
  Promise.all([rm(ROOT, { recursive: true, force: true }), rm(OUTSIDE, { recursive: true, force: true })])
    .finally(() => process.exit(code));
}
const env = { ...process.env, ARGO_ROOT: ROOT, PORT: String(PORT), NODE_ENV: 'production' };
for (const k of Object.keys(env)) if (/SUPABASE|ARGO_TENANT|ARGO_ENFORCE|ARGO_SYNC/i.test(k)) delete env[k];

server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const api = async (path, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...opts, ...(opts.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) } : {}),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 비JSON */ }
  return { status: r.status, json: j, text };
};

{
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 1000)); up = await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.ok, () => false); }
  if (!up) fail('서버 기동 실패');
  console.log(`[e2e] 서버 기동 · 홈 밖 대상 ${OUTSIDE}`);
}
{
  const runner = process.env.E2E_RUNNER || 'codex';
  const r = await api('/api/account/keys', { method: 'PUT', body: { runner, type: 'host' } });
  if (r.status !== 200) fail(`${runner} host 옵트인 실패(${r.status})`);
}
let WS = null; let CREW = null;
{
  const r = await api('/api/companies', { method: 'POST', body: { name: 'e2e-roots', lang: 'ko' } });
  if (!r.json?.company?.id) fail(`회사 생성 실패: ${r.text.slice(0, 150)}`);
  WS = r.json.company.id;
  const a = await api(`/api/companies/${WS}/agents`, { method: 'POST', body: { prompt: '파일 작업 담당. 지시를 정확히 실행하고 한 줄로 보고한다.', name: '델타' } });
  if (!a.json?.agent?.slug) fail(`크루 영입 실패: ${a.text.slice(0, 200)}`);
  CREW = a.json.agent.slug;
  console.log(`[e2e] 회사 ${WS} · 크루 ${CREW}`);
}
const TARGET = join(OUTSIDE, 'proof.txt');
const ask = () => api(`/api/companies/${WS}/chat`, {
  method: 'POST',
  body: { slug: CREW, message: `쓰기 테스트다. 파일 ${TARGET} 에 내용 "fsroots-ok"를 저장하라. 성공/실패만 한 줄로 보고하라.` },
});
// ① 대조군 — fs ON, 허용 폴더 미등록: 홈 밖이므로 실패해야 한다(경계 유지 확인)
{
  const c = await api(`/api/companies/${WS}/capabilities`, { method: 'POST', body: { fs: true } });
  if (!c.json?.capabilities?.fs) fail('fs 능력 켜기 실패');
  await ask();
  const written = await readFile(TARGET, 'utf8').catch(() => null);
  if (written !== null) fail('허용 폴더 등록 전인데 홈 밖 쓰기가 성공 — 경계가 사라졌다(회귀)');
  console.log('[e2e] 대조군 통과 — 등록 전 홈 밖 쓰기 차단 유지');
}
// ② 허용 폴더 등록 후 — 같은 지시가 성공해야 한다
{
  const c = await api(`/api/companies/${WS}/capabilities`, { method: 'POST', body: { fsRoots: [OUTSIDE] } });
  if (!(c.json?.capabilities?.fsRoots ?? []).length) fail(`fsRoots 등록 실패: ${c.text.slice(0, 150)}`);
  console.log(`[e2e] 허용 폴더 등록: ${c.json.capabilities.fsRoots.join(', ')}`);
  const r = await ask();
  const written = await readFile(TARGET, 'utf8').catch(() => null);
  if (written === null || !written.includes('fsroots-ok')) {
    fail(`등록 후에도 홈 밖 쓰기 실패 — 크루 답변: ${(r.json?.reply ?? r.text).slice(0, 200)}`);
  }
  console.log(`[e2e] 홈 밖 쓰기 실측 성공: ${TARGET} → "${written.trim()}"`);
}
console.log('E2E OK: fs ON 단독=차단 유지, 허용 폴더 등록=홈 밖 쓰기 성공 (codex writable_roots 반영 실측)');
cleanup(0);
