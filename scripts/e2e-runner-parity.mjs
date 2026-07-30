// 러너 중립성 스모크 — 같은 일을 4러너(claude·codex·gemini·antigravity)에 시키고 **말이 아니라
// 실제 실행 결과(routines.json 변화)**로 대조한다. 유건 원칙(2026-07-30): 어떤 러너·모델을 쓰든
// Argo 환경 사용에 편파·제약이 없어야 한다 — 모델 성능 차이만 예외.
//
// 왜 파일을 보나: 편파의 증상은 "못 한다"가 아니라 **"했다고 말하고 안 하는 것"**이다(v0.1.34 이전
// codex 크루가 정확히 그랬다 — 루틴 예약을 안내만 하고 실제로 안 걸었다). 응답 텍스트 단언은
// 이 클래스를 원리적으로 못 잡는다.
//
// 사용: node scripts/e2e-runner-parity.mjs   (호스트에 각 CLI 로그인 필요 — 미로그인은 SKIP으로 표기)
// ⚠ 격리: 임시 ARGO_ROOT + 별도 포트 + Supabase env 제거(ARGO_ROOT만으론 클라우드가 안 갈린다).
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 3171;
const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-parity-'));
const RUNNERS = (process.env.PARITY_RUNNERS || 'claude,codex,gemini,antigravity').split(',');
let server = null;
function cleanup(code) {
  try { server?.kill('SIGTERM'); } catch { /* 이미 종료 */ }
  rm(ROOT, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}

const env = { ...process.env, ARGO_ROOT: ROOT, PORT: String(PORT), NODE_ENV: 'production' };
for (const k of Object.keys(env)) {
  if (/SUPABASE|ARGO_TENANT|ARGO_ENFORCE|ARGO_SYNC/i.test(k)) delete env[k];
}

console.log(`[parity] 격리 루트 ${ROOT} · 포트 ${PORT} · 대상 ${RUNNERS.join(',')}`);
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

{
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    up = await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.ok, () => false);
  }
  if (!up) { console.error('[parity] 서버 기동 실패(60s)'); cleanup(1); }
  console.log('[parity] 서버 기동');
}

// 러너별 host 옵트인 — 실패는 중단이 아니라 그 러너의 판정으로 기록(연결 자체가 패리티 항목).
const connected = {};
for (const r of RUNNERS) {
  const res = await api('/api/account/keys', { method: 'PUT', body: { runner: r, type: 'host' } });
  connected[r] = res.status === 200;
  console.log(`[parity] ${r} host 옵트인: ${res.status === 200 ? 'OK' : `실패(${res.status}) ${String(res.json?.error ?? res.text).slice(0, 160)}`}`);
}

let WS = null;
{
  const r = await api('/api/companies', { method: 'POST', body: { name: 'parity', lang: 'ko' } });
  if (r.status !== 200 || !r.json?.company?.id) { console.error(`[parity] 회사 생성 실패(${r.status})`); cleanup(1); }
  WS = r.json.company.id;
  console.log(`[parity] 회사 ${WS}`);
}

let SLUG = null;
{
  const r = await api(`/api/companies/${WS}/agents`, {
    method: 'POST', body: { prompt: '점검 담당. 지시를 정확히 따른다.', name: '점검' },
  });
  if (r.status !== 200 || !r.json?.agent?.slug) { console.error(`[parity] 영입 실패(${r.status}): ${r.text.slice(0, 300)}`); cleanup(1); }
  SLUG = r.json.agent.slug;
  console.log(`[parity] 크루 ${SLUG}`);
}

const routinesOf = async () => {
  try { return JSON.parse(await readFile(join(ROOT, WS, 'routines.json'), 'utf8')); } catch { return []; }
};

// PARITY_TASK=outside — 회사 폴더 **밖**(홈) 파일 쓰기. 벤더 워크스페이스 경계가 러너별로 다른데
// 프롬프트는 "이 컴퓨터 어디든"이라고 단언한다(감사 B1) — 그 진술의 진위를 부작용으로 판정한다.
const OUTSIDE = join(homedir(), 'argo-parity-probe.txt');
const outsideTask = process.env.PARITY_TASK === 'outside';

// 같은 지시를 러너만 바꿔 반복 — 부작용(루틴 실제 등록)으로 판정한다.
const rows = [];
for (const runner of RUNNERS) {
  if (!connected[runner]) { rows.push({ runner, verdict: 'SKIP(미연결)', reply: '' }); continue; }
  const tag = `parity-${runner}`;
  const p = await api(`/api/companies/${WS}/agents/${SLUG}`, { method: 'PATCH', body: { runner, model: '' } });
  if (p.status !== 200) { rows.push({ runner, verdict: `FAIL(러너 지정 ${p.status})`, reply: '' }); continue; }

  const before = (await routinesOf()).length;
  await unlink(OUTSIDE).catch(() => {});
  const t0 = Date.now();
  const c = await api(`/api/companies/${WS}/chat`, {
    method: 'POST',
    body: {
      slug: SLUG,
      message: outsideTask
        ? `홈 폴더의 ${OUTSIDE} 파일에 "${tag}" 한 줄만 써줘. 쓰고 나서 한 줄로 보고해.`
        : `매일 오전 9시에 실행되는 루틴을 하나 등록해줘. 루틴 제목은 정확히 "${tag}" 로 해줘. 등록만 하고 한 줄로 보고해.`,
    },
  });
  const sec = Math.round((Date.now() - t0) / 1000);
  const made = outsideTask
    ? await readFile(OUTSIDE, 'utf8').then((s) => s.includes(tag), () => false)
    : await routinesOf().then((a) => a.length > before && JSON.stringify(a).includes(tag));
  const reply = String(c.json?.reply ?? c.json?.error ?? '').replace(/\s+/g, ' ').slice(0, 150);
  rows.push({
    runner,
    verdict: c.status !== 200 ? `FAIL(턴 ${c.status})` : made ? `OK(${sec}s)` : `실행안됨(${sec}s)`,
    reply,
  });
  console.log(`[parity] ${runner}: ${rows.at(-1).verdict} — ${reply.slice(0, 110)}`);
}

console.log('\n=== 러너 중립성 대조 (같은 지시 · 부작용 기준) ===');
for (const r of rows) console.log(`${r.runner.padEnd(12)} ${r.verdict.padEnd(18)} ${r.reply.slice(0, 90)}`);
const ran = rows.filter((r) => !r.verdict.startsWith('SKIP'));
const bad = ran.filter((r) => !r.verdict.startsWith('OK'));
console.log(`\n판정: 실행 ${ran.length}종 중 통과 ${ran.length - bad.length}종${bad.length ? ` · 미달 ${bad.map((b) => b.runner).join(', ')}` : ''}`);
cleanup(bad.length ? 1 : 0);
