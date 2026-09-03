// 미들웨어 실호출 — 인증 모드(Supabase env를 닿지 않는 주소로 가짜 설정). 휴대폰 지름길은 세션 조회 없이
// 통과해야 하고(GoTrue 왕복 0), 루프백·워커 경로는 종전과 같이 세션 경로를 탄다(→ 미로그인 리다이렉트/401).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1'; // 연결 거부 = getUser 즉시 실패 → user null
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-test';
delete process.env.ARGO_TENANT_OWNER;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
const { NextRequest } = await import('next/server');
const { middleware } = await import('../middleware.js');
// NextRequest는 URL에서 Host 헤더를 채우지 않는다(실측) — 미들웨어가 보는 host를 명시해 넣는다.
const call = (url, headers = {}) => middleware(new NextRequest(url, { headers: { host: new URL(url).host, ...headers } }));
const isNext = (r) => r.status === 200 && r.headers.get('x-middleware-next') === '1';

test('비루프백 + 마커 → 세션 조회 없이 통과 / 페어링 진입점 공개 / 마커 없으면 종전(401·/login)', async () => {
  const t0 = Date.now();
  assert.ok(isNext(await call('http://192.168.0.5:3031/api/companies', { cookie: `argo-mobile=${'0'.repeat(64)}` })));
  assert.ok(isNext(await call('http://192.168.0.5:3031/c/ws', { cookie: `argo-mobile=${'0'.repeat(64)}` })));
  assert.ok(isNext(await call('http://192.168.0.5:3031/m/pair')));
  assert.ok(isNext(await call('http://192.168.0.5:3031/api/mobile/pair')));
  assert.ok(Date.now() - t0 < 1500, '지름길은 네트워크 왕복이 없다');
  const api = await call('http://192.168.0.5:3031/api/companies');
  assert.equal(api.status, 401);
  assert.equal((await api.json()).errorCode, 'auth_required');
  const page = await call('http://192.168.0.5:3031/c/ws');
  assert.equal(page.status, 307);
  assert.match(page.headers.get('location'), /\/login$/);
});

test('루프백 — 기기·게스트 마커 지름길 종전 동일, 휴대폰 마커는 지름길 아님(세션 경로 → /login)', async () => {
  assert.ok(isNext(await call('http://127.0.0.1:3001/c/ws', { cookie: 'argo-device=1' })));
  assert.ok(isNext(await call('http://127.0.0.1:3001/c/ws', { cookie: 'argo-guest=1' })));
  const r = await call('http://127.0.0.1:3001/c/ws', { cookie: `argo-mobile=${'0'.repeat(64)}` });
  assert.equal(r.status, 307, '루프백에서 휴대폰 마커는 아무 의미 없음');
  assert.ok(isNext(await call('http://127.0.0.1:3001/m/pair')), '/m/pair는 공개 경로');
});

test('워커(TENANT) — 휴대폰 지름길 없음(쿠키 세션 전용 유지)', async () => {
  process.env.ARGO_TENANT_OWNER = 'u-1';
  try {
    const r = await call('http://argo.fly.dev/api/companies', { cookie: `argo-mobile=${'0'.repeat(64)}` });
    assert.equal(r.status, 401);
    assert.equal((await call('http://argo.fly.dev/m/pair')).status, 307, '워커에선 /m/pair도 공개 아님');
    assert.equal((await call('http://argo.fly.dev/m/home')).status, 307, '워커에선 /m/home도 공개 아님');
  } finally { delete process.env.ARGO_TENANT_OWNER; }
});
