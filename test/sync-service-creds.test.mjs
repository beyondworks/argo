// C(서비스롤 클라이언트 제거 완주) 회귀 테스트 — serviceCredsAllowed 판별 불변식.
// service-mode(RLS 우회) 동기화는 자가호스트(AUTH off)·워커(TENANT 바인딩)에서만 정당하고,
// 호스티드 클라이언트(공개키 빌드, 워커 아님)에선 크라운주얼이 오설정으로 새어들어도 금지돼야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceCredsAllowed } from '../src/sync.mjs';

test('serviceCredsAllowed: 자가호스트(AUTH off) → 허용', () => {
  assert.equal(serviceCredsAllowed({}), true);
});

test('serviceCredsAllowed: 워커(공개키 + ARGO_TENANT_OWNER 바인딩) → 허용', () => {
  assert.equal(serviceCredsAllowed({
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    ARGO_TENANT_OWNER: 'owner-uid',
  }), true);
});

test('serviceCredsAllowed: 호스티드 클라이언트(공개키, 워커 아님) → 금지(세션/RLS만)', () => {
  assert.equal(serviceCredsAllowed({
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  }), false);
});

test('serviceCredsAllowed: 공백뿐인 TENANT는 워커로 인정 안 함 → 호스티드로 금지', () => {
  assert.equal(serviceCredsAllowed({
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    ARGO_TENANT_OWNER: '   ',
  }), false);
});
