// 휴대폰 페어링 E2E — 격리 서버에서 토글 → 코드 → "폰"(비루프백 Host, 별도 리스너 포트) 페어링 → 회사 API 접근 →
// 해제 → 거절 → 토글 off → 리스너 정지까지 실측. 상주 :3001·실데이터 미접촉(임시 ARGO_ROOT·별도 포트·Supabase env 제거).
// 사용: node scripts/e2e-mobile-pair.mjs   (반복 실행 E2E_SKIP_BUILD=1, KEEP_SERVER=1이면 서버 유지)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const PORT = 3191;          // Next 서버(루프백)
const LISTEN = 3192;        // LAN 리스너(0.0.0.0) — 폰이 붙는 포트
const PHONE_HOST = `192.168.77.5:${LISTEN}`; // 폰이 보낼 Host(비루프백) — 접속 자체는 127.0.0.1:LISTEN
const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2e-mobile-'));
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

if (!process.env.E2E_SKIP_BUILD) {
  console.log('[e2e] next build (E2E_SKIP_BUILD=1로 생략 가능)…');
  const b = spawnSync('npx', ['next', 'build'], { stdio: 'inherit' });
  if (b.status !== 0) fail('next build 실패');
}
server = spawn('npx', ['next', 'start', '-p', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
// PC 측(루프백) — 관리 API
const pc = async (path, method = 'GET', body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* 비JSON */ }
  return { status: r.status, json, text, headers: r.headers };
};
// 폰 측 — 리스너 포트로 접속하되 Host는 비루프백(fetch는 Host를 못 바꾸므로 http.request)
const phone = (path, { method = 'GET', body, cookie } = {}) => new Promise((resolve, reject) => {
  const headers = { host: PHONE_HOST, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  const req = http.request({ host: '127.0.0.1', port: LISTEN, method, path, headers }, (res) => {
    let data = ''; res.on('data', (c) => { data += c; });
    res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* 비JSON */ } resolve({ status: res.statusCode, json, text: data, headers: res.headers }); });
  });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

{
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 1000)); up = await fetch(`http://127.0.0.1:${PORT}/api/ping`).then((r) => r.ok, () => false); }
  if (!up) fail('서버 기동 실패');
  console.log('[e2e] 서버 기동');
}
// 0. 토글 off 상태 — 리스너 포트에 아무것도 없다(데스크톱 기본 = 관측 변화 0)
await phone('/api/ping').then(() => fail('토글 off인데 리스너가 열려 있다'), () => {});
// 1. PC: 켜기 → 코드 발급 + 리스너
let code;
{
  const r = await pc('/api/mobile', 'PUT', { enabled: true, port: LISTEN });
  if (r.status !== 200 || !r.json?.enabled || !r.json?.listener?.listening || r.json.listener.port !== LISTEN) fail(`토글 on 실패(${r.status}): ${r.text.slice(0, 200)}`);
  if (!r.json.pending?.code) fail('코드 미발급');
  code = r.json.pending.code;
  if (r.json.upstreamPort !== PORT) fail(`upstreamPort 오판 ${r.json.upstreamPort}`);
  console.log(`[e2e] 토글 on · 리스너 ${r.json.listener.port} → ${r.json.upstreamPort} · 코드 ${code}`);
}
// 2. 폰(쿠키 없음): ping은 공개, 그 외는 421(무인증 모드 리바인딩 차단 유지)
{
  const a = await phone('/api/ping'); if (a.status !== 200 || !a.json?.argo) fail(`ping 비공개(${a.status})`);
  const b = await phone('/api/companies'); if (b.status !== 421) fail(`무쿠키 비루프백이 421이 아니다(${b.status})`);
  const c = await phone('/c'); if (c.status !== 421) fail(`페이지도 421이어야 한다(${c.status})`);
}
// 3. 폰: 틀린 코드 → 400, 옳은 코드 → 쿠키
let cookie;
{
  const w = await phone('/api/mobile/pair', { method: 'POST', body: { code: 'ZZZZZZ', name: 'e2e', lang: 'en' } });
  if (w.status !== 400 || w.json?.errorCode !== 'mobile_code_wrong' || !/incorrect/.test(w.json.error)) fail(`틀린 코드 응답 이상(${w.status}): ${w.text}`);
  const r = await phone('/api/mobile/pair', { method: 'POST', body: { code, name: 'e2e-phone', lang: 'ko' } });
  if (r.status !== 200) fail(`페어링 실패(${r.status}): ${r.text}`);
  const sc = r.headers['set-cookie']?.[0] || '';
  const m = sc.match(/argo-mobile=([0-9a-f]{64})/); if (!m || !/HttpOnly/.test(sc)) fail(`토큰 쿠키 이상: ${sc}`);
  cookie = `argo-mobile=${m[1]}`;
  const again = await phone('/api/mobile/pair', { method: 'POST', body: { code } });
  if (again.status !== 410) fail(`코드 1회 소비 위반(${again.status})`);
  console.log('[e2e] 페어링 완료(1회 소비 확인)');
}
// 4. 폰(쿠키): 회사 목록·생성 회사의 결재함 접근, 관리 API는 403
let WS;
{
  const r = await phone('/api/companies', { cookie }); if (r.status !== 200) fail(`쿠키 폰 회사 목록 ${r.status}: ${r.text.slice(0, 120)}`);
  const c = await pc('/api/companies', 'POST', { name: 'e2e-mobile', lang: 'ko' }); WS = c.json?.company?.id; if (!WS) fail('회사 생성 실패');
  const a = await phone(`/api/companies/${WS}/approvals`, { cookie }); if (a.status !== 200 || !Array.isArray(a.json?.approvals)) fail(`결재함 ${a.status}`);
  const tk = await phone(`/api/companies/${WS}/tasks`, { cookie }); if (tk.status !== 200) fail(`tasks ${tk.status}`);
  const adm = await phone('/api/mobile', { cookie }); if (adm.status !== 403 || adm.json?.errorCode !== 'mobile_loopback_only') fail(`폰이 관리 API에 닿는다(${adm.status})`);
  const page = await phone(`/c/${WS}`, { cookie }); if (page.status !== 200) fail(`페이지 ${page.status}`);
  const bogus = await phone('/api/companies', { cookie: 'argo-mobile=' + '0'.repeat(64) }); if (bogus.status !== 401) fail(`위조 토큰이 거절되지 않는다(${bogus.status})`);
  // 폰 셸 마커 — 폰의 /api/me는 mobile:true, 데스크톱(루프백)의 /api/me엔 필드 자체가 없다(무간섭 게이트 ③)
  const meP = await phone('/api/me', { cookie }); if (meP.json?.mobile !== true) fail(`폰 /api/me에 mobile:true 없음: ${meP.text.slice(0, 120)}`);
  const meD = await pc('/api/me'); if ('mobile' in (meD.json ?? {})) fail('데스크톱 /api/me에 mobile 필드가 실렸다');
  const crewPage = await phone(`/c/${WS}/crew`, { cookie }); if (crewPage.status !== 200) fail(`크루 목록 페이지 ${crewPage.status}`);
  console.log('[e2e] 폰 접근: 회사·결재·tasks·페이지 200 / 관리 403 / 위조 401 / me.mobile 폰만');
}
// 5. PC: 연결 해제 → 폰 401 / 다시 페어링 → 200 / 토글 off → 리스너 정지·토큰 거절
{
  const st = await pc('/api/mobile'); const id = st.json?.pairs?.[0]?.id; if (!id || st.json.pairs[0].name !== 'e2e-phone') fail('연결 목록에 폰이 없다');
  const d = await pc('/api/mobile', 'DELETE', { id }); if (d.status !== 200) fail(`해제 실패 ${d.status}`);
  const r = await phone('/api/companies', { cookie }); if (r.status !== 401) fail(`해제 후에도 통과(${r.status})`);
  const nc = await pc('/api/mobile', 'POST', {}); const r2 = await phone('/api/mobile/pair', { method: 'POST', body: { code: nc.json.code, name: 'again' } });
  if (r2.status !== 200) fail(`재페어링 실패 ${r2.status}`);
  const cookie2 = `argo-mobile=${r2.headers['set-cookie'][0].match(/argo-mobile=([0-9a-f]{64})/)[1]}`;
  if ((await phone('/api/companies', { cookie: cookie2 })).status !== 200) fail('재페어링 토큰 거절');
  const off = await pc('/api/mobile', 'PUT', { enabled: false }); if (off.json?.enabled || off.json?.listener?.listening) fail('토글 off 실패');
  await phone('/api/ping').then(() => fail('토글 off 후에도 리스너가 살아 있다'), () => {});
  console.log('[e2e] 해제 401 · 재페어링 200 · 토글 off 리스너 정지');
}
console.log('E2E OK: 휴대폰 페어링 — 토글·코드·페어링·접근·해제·정지');
cleanup(0);
