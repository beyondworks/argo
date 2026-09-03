// 미들웨어 실호출 — 무인증 모드(Supabase env 없음). 휴대폰 분기가 **비루프백 Host에서만** 갈리고,
// 루프백은 종전과 같이 전부 통과함을 잠근다(데스크톱 무간섭 핀). 리바인딩 차단(421)은 마커 없으면 그대로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.ARGO_TENANT_OWNER;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
const { NextRequest } = await import('next/server');
const { middleware } = await import('../middleware.js');
// NextRequest는 URL에서 Host 헤더를 채우지 않는다(실측) — 미들웨어가 보는 host를 명시해 넣는다.
const call = (url, headers = {}) => middleware(new NextRequest(url, { headers: { host: new URL(url).host, ...headers } }));
const isNext = (r) => r.status === 200 && r.headers.get('x-middleware-next') === '1';

test('루프백 — 쿠키 유무·경로 무관 전부 통과(종전 동일)', async () => {
  for (const u of ['http://127.0.0.1:3001/api/companies', 'http://localhost:3001/c/x', 'http://[::1]:3001/m/pair']) {
    assert.ok(isNext(await call(u)), u);
    assert.ok(isNext(await call(u, { cookie: 'argo-mobile=bogus' })), `${u} + 마커도 통과(라우트가 무시)`);
  }
});

test('비루프백 — 마커 없으면 421, 마커 있으면 통과(권한은 라우트), 페어링 진입점·ping은 공개', async () => {
  const r = await call('http://192.168.0.5:3031/api/companies');
  assert.equal(r.status, 421);
  assert.equal((await r.json()).error, 'invalid host');
  assert.equal((await call('http://192.168.0.5:3031/c/ws')).status, 421, '페이지도 421');
  assert.ok(isNext(await call('http://192.168.0.5:3031/api/companies', { cookie: `a=b; argo-mobile=${'0'.repeat(64)}` })));
  assert.ok(isNext(await call('http://100.101.1.2:3031/m/pair')));
  assert.ok(isNext(await call('http://100.101.1.2:3031/api/mobile/pair')));
  assert.ok(isNext(await call('http://100.101.1.2:3031/api/ping')));
  assert.equal((await call('http://100.101.1.2:3031/api/mobile')).status, 421, '관리 API는 공개 아님');
  assert.equal((await call('http://192.168.0.5:3031/api/companies', { cookie: 'argo-mobile=' })).status, 421, '빈 마커는 마커 아님');
  assert.equal((await call('http://192.168.0.5:3031/api/companies', { cookie: 'argo-mobile=tok' })).status, 421, '형태 밖 마커(짧은 값)는 마커 아님');
  assert.equal((await call('http://192.168.0.5:3031/api/companies', { cookie: `argo-mobile=${'A'.repeat(64)}` })).status, 421, '대문자 hex 아님');
  assert.ok(isNext(await call('http://192.168.0.5:3031/api/companies', { cookie: `argo-mobile=${'0'.repeat(64)}` })), '64자리 hex 형태면 마커(진위는 라우트)');
});
