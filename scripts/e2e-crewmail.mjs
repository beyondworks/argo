// 크루 쪽지·interval 루프 E2E — 격리 서버(임시 ARGO_ROOT·별도 포트·Supabase 미접속)에서
// 실 러너(claude host)로 풀 플로우를 실측한다. #122(OpenRouter 풀 플로우)와 같은 검증 계급.
//
//   ① 회사 생성(온보딩 — 실 LLM) ② 크루 2명 ③ A에게 "send_to_crew로 B에게 보내라" 실턴
//   ④ 우편함에 메시지 파일 실존 확인 ⑤ 스케줄러 틱(60s 폴) 대기 → B 스레드에 쪽지 턴 실존
//   ⑥ interval 루틴 등록(API) → 다음 틱에 1회 발화(lastRun 갱신) 실측
//
// 사용: node scripts/e2e-crewmail.mjs   (이 맥에 claude 호스트 로그인 필요. 실패 시 exit 1)
// ⚠ E2E 주의(핸드오버): ARGO_ROOT만 갈라도 클라우드는 격리되지 않는다 — Supabase env를 지운다.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PORT = 3161;
const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-mail-'));
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
// 선행 빌드 — "직전에 빌드했겠지"는 가정이라 낡은 .next면 옛 코드로 가짜 통과한다(분리 검수).
// 반복 실행 시에만 E2E_SKIP_BUILD=1로 생략(직전 실행이 방금 빌드했음을 아는 경우).
if (!process.env.E2E_SKIP_BUILD) {
  console.log('[e2e] next build (E2E_SKIP_BUILD=1로 생략 가능)…');
  const b = spawnSync('npx', ['next', 'build'], { stdio: 'inherit' });
  if (b.status !== 0) fail('next build 실패 — 낡은 .next로는 E2E를 신뢰할 수 없다');
}
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

// 러너: 이 컴퓨터의 호스트 로그인 옵트인(로컬 무인증 모드 — 계정 스코프).
// E2E_RUNNER로 선택(기본 codex — 2026-07-27 이 맥의 claude OAuth 만료 실측, codex auth.json 유효).
// 2026-07-28 재확인: claude 여전히 미로그인(`claude -p` → "Not logged in") — E2E_RUNNER=claude
// 발신 도구 실호출 완주는 claude /login 갱신 후 확인 항목으로 유지.
{
  const runner = process.env.E2E_RUNNER || 'codex';
  const r = await api('/api/account/keys', { method: 'PUT', body: { runner, type: 'host' } });
  if (r.status !== 200) fail(`${runner} host 옵트인 실패(${r.status}): ${r.text.slice(0, 120)}`);
  console.log(`[e2e] ${runner} host 옵트인`);
}

// ① 회사 생성 — 온보딩(실 LLM 페르소나 생성)
let WS = null;
{
  const r = await api('/api/companies', { method: 'POST', body: { name: 'e2e-mail', lang: 'ko' } });
  if (r.status !== 200 || !r.json?.company?.id) fail(`회사 생성 실패(${r.status}): ${r.text.slice(0, 200)}`);
  WS = r.json.company.id;
  console.log(`[e2e] 회사 생성 ${WS}`);
}

// 기본 크루 확인 + 2호 크루 확보
const listAgents = async () => { const r = await api(`/api/companies/${WS}/agents`); return r.json?.agents ?? r.json ?? []; };
let A = null; let B = null;
{
  // 회사 생성은 크루를 만들지 않는다(프리셋 경로만 첫 크루 힌트) — A·B를 직접 영입(실 LLM 페르소나 턴)
  const hire = async (prompt, name) => {
    const r = await api(`/api/companies/${WS}/agents`, { method: 'POST', body: { prompt, name } });
    if (r.status !== 200 || !r.json?.agent?.slug) fail(`크루 영입 실패(${r.status}): ${r.text.slice(0, 200)}`);
    return r.json.agent.slug;
  };
  A = await hire('연락 담당. 지시를 정확히 따르고 한 줄로 답한다.', '알파');
  B = await hire('자료 정리 담당. 한 줄로 답한다.', '베타');
  if (A === B) fail('A와 B가 동일 slug');
  console.log(`[e2e] 크루 A=${A}, B=${B}`);
}

// ③ A 실턴 — send_to_crew 사용 지시
{
  const r = await api(`/api/companies/${WS}/chat`, {
    method: 'POST',
    body: { slug: A, message: `send_to_crew 도구로 동료 "${B}"에게 "E2E 점검 쪽지 — 받으면 한 줄로 확인만"이라고 보내라. 다른 일은 하지 마라.` },
  });
  if (r.status !== 200) fail(`A 턴 실패(${r.status}): ${r.text.slice(0, 200)}`);
  console.log(`[e2e] A 턴 완료: ${(r.json?.reply ?? '').slice(0, 80)}`);
}

// ④ 우편함 파일 실존 — A 턴이 도구를 실제로 불렀는가.
// ⚠ 한계: send_to_crew는 SDK 러너 전용 도구(MCP)라 CLI 러너(codex/gemini)는 못 부른다.
// 이 맥의 claude OAuth가 만료라(2026-07-27 실측) codex로 돌면 A는 결재 문구로 답한다 —
// 그 경우 sendCrewMail을 직접 호출해 적재하고(단위 테스트가 도구 배선을 잠근다),
// 배달→수신 실턴→interval 실턴을 계속 실측한다. 발신 도구 실턴은 SDK 러너 로그인 후 확인 항목.
{
  let files = [];
  for (let i = 0; i < 10 && !files.length; i++) {
    try { files = await readdir(join(ROOT, WS, 'mail', B)); } catch { /* 아직 */ }
    if (!files.length) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!files.length) {
    console.log('[e2e] (주의) 발신 도구 실턴 미확인(CLI 러너 — 도구 없음) — 파일 직접 적재로 배달 경로 검증 계속');
    process.env.ARGO_ROOT = ROOT; // in-process 적재 — 서버와 같은 루트
    const { sendCrewMail } = await import('../src/crewmail.mjs');
    await sendCrewMail(WS, { from: A, fromName: '알파', to: B, message: 'E2E 점검 쪽지 — 받으면 한 줄로 확인만' });
    files = await readdir(join(ROOT, WS, 'mail', B));
  }
  if (!files.length) fail('우편함 적재 실패');
  console.log(`[e2e] 우편함 적재 확인: ${files.join(', ')}`);
}

// ⑥-등록 interval 루틴(다음 틱 1회 발화 기대 — lastRun null은 즉시 due)
let ROUTINE = null;
{
  const r = await api(`/api/companies/${WS}/routines`, {
    method: 'POST',
    body: { agentSlug: B, title: 'E2E 루프', prompt: '한 단어로 "loop-ok"라고만 답하라.', schedule: { type: 'interval', everyMinutes: 30 } },
  });
  if (r.status !== 200 || !r.json?.routine?.id) fail(`interval 루틴 등록 실패(${r.status}): ${r.text.slice(0, 200)}`);
  ROUTINE = r.json.routine.id;
  console.log(`[e2e] interval 루틴 등록 ${ROUTINE}`);
}

// ⑤⑥ 스케줄러 틱 대기(60s 폴 + 턴 시간) — B 스레드에 쪽지 턴 + 루틴 lastRun 갱신
{
  const t0 = Date.now();
  let mailSeen = false; let loopSeen = false;
  while (Date.now() - t0 < 240_000 && !(mailSeen && loopSeen)) {
    await new Promise((r) => setTimeout(r, 5000));
    if (!mailSeen) {
      const th = await api(`/api/companies/${WS}/chat?slug=${B}`);
      if (JSON.stringify(th.json ?? {}).includes('E2E 점검 쪽지')) { mailSeen = true; console.log(`[e2e] B 스레드에 쪽지 턴 확인 (+${Math.round((Date.now() - t0) / 1000)}s)`); }
    }
    if (!loopSeen) {
      const rt = await api(`/api/companies/${WS}/routines`);
      const r = (rt.json?.routines ?? rt.json ?? []).find((x) => x.id === ROUTINE);
      if (r?.lastRun) { loopSeen = true; console.log(`[e2e] interval 루틴 발화 확인 lastRun=${r.lastRun} (+${Math.round((Date.now() - t0) / 1000)}s)`); }
    }
  }
  if (!mailSeen) fail('240s 내 B 스레드에 쪽지 턴이 없다 — 배달 배선 또는 chat 경로 실패');
  if (!loopSeen) fail('240s 내 interval 루틴 미발화 — isDue/스케줄러 배선 실패');
}

console.log('E2E OK: 쪽지 적재→배달→수신 턴 + interval 루프 1회 발화 실측');
cleanup(0);
