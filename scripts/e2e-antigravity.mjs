// Antigravity 러너 실계정 실턴 E2E — 격리 서버(임시 ARGO_ROOT·별도 포트·Supabase 미접속)에서
// host 옵트인 → 크루 영입(실 LLM 페르소나 턴) → 채팅 실턴 1회를 실측한다.
// docs/antigravity-runner-design.md "미검증 1번(실계정 실턴 0회)"을 지우는 관문 스크립트.
//
// 사용: node scripts/e2e-antigravity.mjs   (이 맥에 agy Google 로그인 필요. 실패 시 exit 1)
//   카탈로그 모델 스모크는 서버 무관 — E2E_AGY_SMOKE=1 이면 8종 id를 agy -p로 직접 실턴한다.
// ⚠ E2E 주의(핸드오버): ARGO_ROOT만 갈라도 클라우드는 격리되지 않는다 — Supabase env를 지운다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const PORT = 3162;
const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-agy-'));
const fail = (msg) => { console.error(`E2E FAIL: ${msg}`); cleanup(1); };
let server = null;
function cleanup(code) {
  try { server?.kill('SIGTERM'); } catch { /* 이미 종료 */ }
  rm(ROOT, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}

// 격리 env — Supabase·테넌트 계열 전부 제거(동기화·요금제·게이트웨이가 실환경을 건드리지 않게)
const env = { ...process.env, ARGO_ROOT: ROOT, PORT: String(PORT), NODE_ENV: 'production' };
for (const k of Object.keys(env)) {
  if (/SUPABASE|ARGO_TENANT|ARGO_ENFORCE|ARGO_SYNC/i.test(k)) delete env[k];
}

console.log(`[e2e] 격리 루트 ${ROOT} · 포트 ${PORT}`);
server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stdout.write(d); });
server.stderr.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stderr.write(d); });

const api = async (path, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 비JSON */ }
  return { status: r.status, json: j, text };
};

// 기동 대기
{
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    up = await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.ok, () => false);
  }
  if (!up) fail('서버 기동 실패(60s)');
  console.log('[e2e] 서버 기동');
}

// antigravity host 옵트인 — 자격이 OS 키링이라 이 경로뿐(설계 문서 "host 옵트인 전용")
{
  const r = await api('/api/account/keys', { method: 'PUT', body: { runner: 'antigravity', type: 'host' } });
  if (r.status !== 200) fail(`antigravity host 옵트인 실패(${r.status}): ${r.text.slice(0, 200)}`);
  console.log('[e2e] antigravity host 옵트인');
}

// 회사 생성
let WS = null;
{
  const r = await api('/api/companies', { method: 'POST', body: { name: 'e2e-agy', lang: 'ko' } });
  if (r.status !== 200 || !r.json?.company?.id) fail(`회사 생성 실패(${r.status}): ${r.text.slice(0, 200)}`);
  WS = r.json.company.id;
  console.log(`[e2e] 회사 생성 ${WS}`);
}

// 크루 영입 — 실 LLM 페르소나 생성 턴(= antigravity 실계정 실턴 1회째)
let A = null;
{
  const r = await api(`/api/companies/${WS}/agents`, {
    method: 'POST', body: { prompt: '점검 담당. 지시를 정확히 따르고 한 줄로 답한다.', name: '감마' },
  });
  if (r.status !== 200 || !r.json?.agent?.slug) fail(`크루 영입 실패(${r.status}): ${r.text.slice(0, 300)}`);
  A = r.json.agent.slug;
  console.log(`[e2e] 크루 영입 ${A}`);
}

// 채팅 실턴 — 대화 경로(chat)에서도 antigravity 디스패치가 실제로 돈다
{
  const r = await api(`/api/companies/${WS}/chat`, {
    method: 'POST', body: { slug: A, message: '한 단어로 "agy-ok"라고만 답하라.' },
  });
  if (r.status !== 200) fail(`채팅 턴 실패(${r.status}): ${r.text.slice(0, 300)}`);
  const reply = String(r.json?.reply ?? '');
  if (!reply.trim()) fail('채팅 턴 응답이 비어 있다');
  console.log(`[e2e] 채팅 턴 완료: ${reply.slice(0, 120)}`);
}

console.log('E2E OK: antigravity host 옵트인 → 영입 턴 → 채팅 턴 실측');

// 카탈로그 모델 스모크(옵션) — RUNNERS.antigravity.models 8종을 agy -p로 직접 실턴.
// 카탈로그 규칙("실행 경로 실턴 통과 id만")의 실측 근거를 만든다. 서버 격리와 무관해 순차 직호출.
if (process.env.E2E_AGY_SMOKE === '1') {
  const { RUNNERS } = await import('../src/runners.mjs');
  const results = [];
  for (const m of RUNNERS.antigravity.models) {
    const t0 = Date.now();
    try {
      const { stdout } = await execFileP('agy', ['-p', 'Reply with exactly: OK', '--model', m.id, '--print-timeout', '3m'], { timeout: 200_000 });
      results.push({ id: m.id, ok: true, sec: Math.round((Date.now() - t0) / 1000), out: stdout.trim().slice(0, 40) });
    } catch (e) {
      results.push({ id: m.id, ok: false, sec: Math.round((Date.now() - t0) / 1000), out: String(e.stderr || e.stdout || e.message).trim().slice(0, 120) });
    }
    console.log(`[smoke] ${m.id}: ${results.at(-1).ok ? 'OK' : 'FAIL'} (${results.at(-1).sec}s) ${results.at(-1).out}`);
  }
  const bad = results.filter((r) => !r.ok);
  if (bad.length) console.log(`[smoke] 실패 ${bad.length}/${results.length} — 카탈로그 재검 필요: ${bad.map((b) => b.id).join(', ')}`);
}

cleanup(0);
