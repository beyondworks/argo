// 러너 로그인 브리지 결함 3종(감사 2026-09-22 K21·K30·K31) 행동 테스트.
//  K21: OAuth 취소(?error=access_denied)로 돌아오면 안내 없는 404, 앱 폴링은 영원히 대기했다.
//  K30: 옛 리스너의 10분 TTL이 새 리스너 참조까지 지워, 다음 재시작이 살아 있는 리스너를 못 닫고 포트 충돌.
//  K31: Grok 기기 코드 로그인이 verifyRunnerCred(등급·크레딧 프로브) 없이 저장 → API 불가 계정도 "연결됨".
// 콜백 리스너는 gemini(45289)로 잰다 — codex(1455)는 oauth-loopback.test가 같은 시각에 잡는다(node --test 병렬).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stubRunnerToolDirs } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { register } from 'node:module';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-wa-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-wa-root-')); // import보다 먼저
delete process.env.NEXT_PUBLIC_SUPABASE_URL; // AUTH off — 라우트 실호출이 가드를 지나게(crew-slug-reserved 관례)
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
await stubRunnerToolDirs(); // gemini 시작이 CLI 조달(네트워크)을 타지 않게
const wa = await import('../src/runners/webauth.mjs');
const { loadRunnerCred } = await import('../src/runners/creds.mjs');

const WS = 'co-webauth-k21';
const reg = () => globalThis.__argoWebAuthSrv?.gemini;
const bound = async (entry) => {
  for (let i = 0; i < 100 && !entry?.address?.(); i++) await new Promise((r) => setImmediate(r));
  return !!entry?.address?.();
};
// 요청마다 새 연결(agent:false) — 전역 fetch 연결 풀이 이전 테스트의 닫힌 리스너 소켓을 재사용하지 않게
const cb = (qs) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port: 45289, path: `/oauth2callback?${qs}`, agent: false, timeout: 5000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, text: async () => body }));
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
});
after(() => { reg()?.close?.(); });

test('K21: 취소 콜백(error=access_denied)은 안내 페이지를 띄우고, 폴링이 읽는 실패를 남긴다', async () => {
  const { url } = wa.startRunnerWebAuth('gemini', WS);
  const state = new URL(url).searchParams.get('state');
  assert.ok(await bound(reg()), '리스너가 안 떴다');
  const res = await cb(`error=access_denied&state=${state}`);
  assert.equal(res.status, 200, '취소 콜백이 안내 없는 응답으로 끝났다');
  assert.match(await res.text(), /취소/, '취소 안내 문구가 없다');
  assert.equal(wa.webAuthFailure('gemini', WS), 'access_denied', '폴링이 실패를 읽지 못한다 — 앱은 계속 기다린다');
  assert.equal(wa.webAuthDone('gemini', WS), false, '취소가 연결됨으로 보이면 안 된다');
  assert.equal(wa.webAuthFailure('gemini', 'other-ws'), null, '다른 스코프의 실패로 오판하지 않는다');
  reg()?.close?.();
});

test('K21 인접: state가 다른 error 콜백은 세션을 끊지 않고, code도 error도 없으면 기존처럼 404', async () => {
  const { url } = wa.startRunnerWebAuth('gemini', WS);
  const state = new URL(url).searchParams.get('state');
  assert.ok(await bound(reg()));
  assert.equal((await cb('error=access_denied&state=FORGED')).status, 404, '위조 state로 남의 로그인을 취소시킬 수 있다');
  assert.equal(wa.webAuthFailure('gemini', WS), null);
  assert.equal((await cb('')).status, 404, 'code 없는 요청 = 404(핸들러 계약)');
  assert.equal(globalThis.__argoWebAuth.gemini.state, state, '진행 중 세션이 보존돼야 한다');
  wa.startRunnerWebAuth('gemini', WS);
  assert.equal(wa.webAuthFailure('gemini', WS), null, '새 시작은 이전 실패를 지운다');
  reg()?.close?.();
});

test('K21 배선: 폴링 GET(회사·계정 두 라우트)이 취소 사유를 reason으로 돌려준다 — UI는 pending 아닌 reason에서 멈춘다', async () => {
  const { accountScope } = await import('../src/runners/creds.mjs');
  const co = await import('../app/api/companies/[ws]/keys/connect/route.js');
  const acct = await import('../app/api/account/keys/connect/route.js');
  // 상태 모양은 위 K21 리스너 테스트가 실제 콜백으로 만든 것과 같다(codex 포트는 oauth-loopback.test 몫이라 직접 심는다)
  globalThis.__argoWebAuth.codex = { failed: 'access_denied', failedWs: WS, ts: Date.now() };
  let d = await (await co.GET(new Request('http://x/api?runner=codex'), { params: Promise.resolve({ ws: WS }) })).json();
  assert.deepEqual(d, { supported: true, authed: false, reason: 'access_denied' });
  globalThis.__argoWebAuth.codex = { failed: 'access_denied', failedWs: accountScope('local'), ts: Date.now() };
  d = await (await acct.GET(new Request('http://x/api?runner=codex'))).json();
  assert.deepEqual(d, { supported: true, authed: false, reason: 'access_denied' });
  globalThis.__argoWebAuth.codex = { saved: true, savedWs: WS, ts: Date.now() };
  d = await (await co.GET(new Request('http://x/api?runner=codex'), { params: Promise.resolve({ ws: WS }) })).json();
  assert.deepEqual(d, { supported: true, authed: true }, '성공 응답 모양은 그대로(회귀 없음)');
});

test('K30: 옛 리스너의 TTL이 재시작한 새 리스너를 지우지 않는다 — 세 번째 시작도 포트를 잡는다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let first, second;
  try {
    wa.startRunnerWebAuth('gemini', 'ws-a');
    first = reg();
    mock.timers.tick(5 * 60_000);
    wa.startRunnerWebAuth('gemini', 'ws-b');
    second = reg();
    mock.timers.tick(5 * 60_000 + 1_000); // 첫 리스너의 10분 TTL 시각 — 두 번째는 아직 5분 남음
  } finally { mock.timers.reset(); }
  assert.ok(reg(), '옛 TTL이 새 리스너 참조를 지웠다 — 다음 재시작이 그것을 못 닫는다');
  assert.equal(reg(), second);
  first.close(); // 옛 리스너의 늦은 닫기(성공 콜백·TTL 모두 같은 함수) — 자기 것만 닫아야 한다
  assert.equal(reg(), second, '옛 리스너 닫기가 새 리스너 참조를 지웠다');
  assert.ok(await bound(second), '두 번째 리스너가 살아 있어야 한다');
  wa.startRunnerWebAuth('gemini', 'ws-c');
  assert.ok(await bound(reg()), '세 번째 시작이 포트를 못 잡았다(살아 있는 옛 리스너와 충돌)');
  reg()?.close?.();
  assert.equal(reg(), undefined, '자기 자신 닫기는 참조를 지운다');
});

// ── K31: 기기 코드(Grok) 저장 전 실검증 ──
const TOK = { access_token: 'at-test', refresh_token: 'rt-test', expires_in: 3600 };
function stubFetch(messagesRes) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u, init) => {
    const s = String(u);
    calls.push(s);
    if (s.startsWith('https://auth.x.ai/oauth2/token')) return new Response(JSON.stringify(TOK), { status: 200 });
    if (s.endsWith('/v1/messages')) return messagesRes();
    throw new Error(`unexpected ${s}`);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const seedDevice = (ws) => { globalThis.__argoWebAuth[`device:grok:${ws}`] = { deviceCode: 'dev-1', ws, ts: Date.now() }; };

test('K31: 등급 거절(403) 계정은 저장하지 않고 사유를 돌려준다', async () => {
  const ws = 'co-grok-tier';
  seedDevice(ws);
  const f = stubFetch(() => new Response(JSON.stringify({ error: 'Your plan does not include API access' }), { status: 403 }));
  let r;
  try { r = await wa.pollRunnerDeviceAuth('grok', ws); } finally { f.restore(); }
  assert.ok(f.calls.some((u) => u.endsWith('/v1/messages')), '저장 전 실검증 프로브가 없었다');
  assert.equal(r.ok, false, 'API 불가 계정이 연결됨이 됐다');
  assert.equal(r.reason, 'tier');
  assert.equal(await loadRunnerCred(ws, 'grok'), null, '거절된 자격이 저장됐다');
  const again = await wa.pollRunnerDeviceAuth('grok', ws);
  assert.deepEqual([again.ok, again.reason], [false, 'tier'], '다시 물어도 같은 사유(소비된 기기 코드로 재질의하지 않는다)');
});

test('K31 인접: 크레딧 소진은 credit, 정상·판정 불가(네트워크)는 기존대로 저장', async () => {
  seedDevice('co-grok-credit');
  // 사유 분류는 verifyRunnerCred 몫이다 — 여기선 그 사유가 그대로 폴링까지 오는지만 잰다(분류 정규식이 잡는 본문 사용)
  let f = stubFetch(() => new Response(JSON.stringify({ error: 'insufficient credits' }), { status: 403 }));
  let r;
  try { r = await wa.pollRunnerDeviceAuth('grok', 'co-grok-credit'); } finally { f.restore(); }
  assert.deepEqual([r.ok, r.reason], [false, 'credit']);

  seedDevice('co-grok-ok');
  f = stubFetch(() => new Response(JSON.stringify({ id: 'msg_1', type: 'message', content: [] }), { status: 200 }));
  try { r = await wa.pollRunnerDeviceAuth('grok', 'co-grok-ok'); } finally { f.restore(); }
  assert.equal(r.ok, true);
  assert.equal(JSON.parse((await loadRunnerCred('co-grok-ok', 'grok')).value).access_token, 'at-test');

  seedDevice('co-grok-offline');
  f = stubFetch(() => { throw new Error('ECONNRESET'); });
  try { r = await wa.pollRunnerDeviceAuth('grok', 'co-grok-offline'); } finally { f.restore(); }
  assert.equal(r.ok, true, '판정 불가(ok:null)는 기존 관용대로 저장');
  assert.ok(await loadRunnerCred('co-grok-offline', 'grok'));
});
