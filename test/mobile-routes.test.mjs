// 휴대폰 관리·페어링 라우트 실호출(무인증 모드, 리졸브 훅) — 분리 검수 M-1(관리 라우트 무핀) 해소.
// 잠그는 것: 관리 API 3중 게이트(루프백 한정 → 비루프백 403 / CSRF → cross-site 403 / 워커 403), 토글 on이 리스너를
// 실제로 열고 코드를 발급하며 off가 닫는다, 페어링 라우트는 코드 소비 → 64자리 hex HttpOnly 쿠키, 해제 → 404.
// 무인증 모드라 currentUser는 요청 스코프 밖에서도 local을 돌려준다(cookies()는 AUTH_ON에서만 열린다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-mobile-routes-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.ARGO_TENANT_OWNER;
delete process.env.PORT;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
const { NextRequest } = await import('next/server');
const admin = await import('../app/api/mobile/route.js');
const pairRoute = await import('../app/api/mobile/pair/route.js');
const { stopMobileListener, mobileListenerStatus } = await import('../src/mobile-listener.mjs');
after(() => stopMobileListener());

const req = (method, path, { host = '127.0.0.1:3001', headers = {}, body } = {}) =>
  new NextRequest(`http://${host}${path}`, { method, headers: { host, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const json = async (r) => ({ status: r.status, body: await r.json(), setCookie: r.headers.get('set-cookie') });

test('관리 API — 비루프백 Host·워커는 403 mobile_loopback_only, cross-site는 403 cross_origin', async () => {
  const a = await json(await admin.GET(req('GET', '/api/mobile', { host: '192.168.0.12:3031' })));
  assert.equal(a.status, 403); assert.equal(a.body.errorCode, 'mobile_loopback_only');
  const b = await json(await admin.PUT(req('PUT', '/api/mobile', { headers: { 'sec-fetch-site': 'cross-site' }, body: { enabled: true } })));
  assert.equal(b.status, 403); assert.equal(b.body.errorCode, 'cross_origin');
  process.env.ARGO_TENANT_OWNER = 'u-1';
  try {
    const c = await json(await admin.GET(req('GET', '/api/mobile')));
    assert.equal(c.status, 403); assert.equal(c.body.errorCode, 'mobile_loopback_only');
    const d = await json(await pairRoute.POST(req('POST', '/api/mobile/pair', { host: '192.168.0.12:3031', body: { code: 'ABC123' } })));
    assert.equal(d.status, 403, '워커에선 페어링도 없음');
    assert.equal(d.body.errorCode, 'mobile_loopback_only', '토글 off 403(mobile_disabled)과 구분 — 게이트 제거 변이가 같은 상태코드로 숨지 않게');
  } finally { delete process.env.ARGO_TENANT_OWNER; }
  assert.equal(mobileListenerStatus().listening, false, '거절된 호출은 리스너를 열지 않는다');
});

test('토글 on → 리스너 실제 개방 + 코드 발급 → 페어링 → 해제 → 토글 off', async () => {
  const off = await json(await admin.GET(req('GET', '/api/mobile')));
  assert.equal(off.status, 200); assert.equal(off.body.enabled, false); assert.equal(off.body.listener.listening, false);
  const on = await json(await admin.PUT(req('PUT', '/api/mobile', { headers: { 'sec-fetch-site': 'same-origin' }, body: { enabled: true, port: 0 } })));
  assert.equal(on.status, 200); assert.equal(on.body.enabled, true);
  assert.equal(on.body.listener.listening, true);
  assert.ok(on.body.listener.port > 0 && on.body.port === on.body.listener.port, 'OS 배정 포트가 상태에 기록');
  assert.equal(on.body.upstreamPort, 3001, '업스트림 = 요청 Host 포트(PORT env 부재)');
  assert.match(on.body.pending.code, /^[A-Z0-9]{6}$/);
  assert.ok(Array.isArray(on.body.addresses));
  // 페어링(비루프백 Host — 폰 경로)
  const wrong = await json(await pairRoute.POST(req('POST', '/api/mobile/pair', { host: '192.168.0.12:3031', body: { code: 'ZZZZZZ', lang: 'en' } })));
  assert.equal(wrong.status, 400); assert.equal(wrong.body.errorCode, 'mobile_code_wrong'); assert.match(wrong.body.error, /incorrect/);
  const ok = await json(await pairRoute.POST(req('POST', '/api/mobile/pair', { host: '192.168.0.12:3031', headers: { 'user-agent': 'iPhone-test' }, body: { code: on.body.pending.code, name: 'iPhone' } })));
  assert.equal(ok.status, 200); assert.equal(ok.body.pair.name, 'iPhone');
  assert.match(ok.setCookie, /^argo-mobile=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  const again = await json(await pairRoute.POST(req('POST', '/api/mobile/pair', { host: '192.168.0.12:3031', body: { code: on.body.pending.code } })));
  assert.equal(again.status, 410, '1회 소비');
  const list = await json(await admin.GET(req('GET', '/api/mobile')));
  assert.equal(list.body.pairs.length, 1); assert.ok(!('hash' in list.body.pairs[0]));
  const del = await json(await admin.DELETE(req('DELETE', '/api/mobile', { body: { id: list.body.pairs[0].id } })));
  assert.equal(del.status, 200);
  const del2 = await json(await admin.DELETE(req('DELETE', '/api/mobile', { body: { id: list.body.pairs[0].id } })));
  assert.equal(del2.status, 404); assert.equal(del2.body.errorCode, 'mobile_pair_not_found');
  const newCode = await json(await admin.POST(req('POST', '/api/mobile', { body: {} })));
  assert.match(newCode.body.code, /^[A-Z0-9]{6}$/);
  const off2 = await json(await admin.PUT(req('PUT', '/api/mobile', { body: { enabled: false } })));
  assert.equal(off2.body.enabled, false); assert.equal(off2.body.listener.listening, false);
  assert.equal(off2.body.pending, null, '끄면 발급 중 코드 폐기');
  assert.equal(mobileListenerStatus().listening, false);
});

// /m/home — 폰 진입 목적지: 회사 없음 → '/', 있음 → 첫 회사, 워커 → /m/pair. 리다이렉트는 요청 Host 기준(publicUrl).
test('/m/home — 첫 회사로 302, 회사 없으면 /, 워커는 /m/pair', async () => {
  const home = await import('../app/m/home/route.js');
  const { createCompany } = await import('../src/workspace.mjs');
  const r0 = await home.GET(req('GET', '/m/home', { host: '192.168.0.12:3031' }));
  assert.equal(r0.status, 302); assert.equal(r0.headers.get('location'), 'http://192.168.0.12:3031/');
  await createCompany('co-home', '홈', 'captain');
  const r1 = await home.GET(req('GET', '/m/home', { host: '192.168.0.12:3031' }));
  assert.equal(r1.headers.get('location'), 'http://192.168.0.12:3031/c/co-home');
  process.env.ARGO_TENANT_OWNER = 'u-1';
  try {
    const r2 = await home.GET(req('GET', '/m/home', { host: 'argo.fly.dev' }));
    assert.equal(r2.headers.get('location'), 'http://argo.fly.dev/m/pair');
  } finally { delete process.env.ARGO_TENANT_OWNER; }
});
