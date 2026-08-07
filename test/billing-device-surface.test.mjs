// 설치본(데스크톱) 결제 표면 회귀 — 발행 전 검수 HIGH-2(2026-08-07).
// 데스크톱 빌드에는 서비스키가 없다(release.yml). billing 조회가 서비스키를 요구하면 설치본에서
// billing이 항상 null이 되고, 설정 화면이 기기 스코프 sync.plan으로 폴백해 **체험 배지·업그레이드
// 버튼이 통째로 사라진다** — 가입 1~14일차(체험 중) 사용자에게 결제 수단이 없던 원인.
// 라우트는 next 의존이라 임포트 불가 → 소스 앵커로 계약을 잠근다(집 관례).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const route = await readFile(new URL('../app/api/me/billing/route.js', import.meta.url), 'utf8');

test('기기 세션 경로가 서비스키 없이도 조회한다(사용자 스코프 + RLS)', () => {
  assert.ok(route.includes('getFreshDeviceSession'), '기기 세션 토큰 사용');
  assert.ok(/Authorization: `Bearer \$\{sess\.access_token\}`/.test(route), '사용자 스코프 클라이언트');
  // 조기 반환이 serviceKey를 요구하면 설치본은 그 줄에서 죽는다 — 결함의 정확한 형태
  assert.ok(!/user\.id === 'guest' \|\| !serviceKey\) return Response\.json\(\{ billing: null \}\)/.test(route),
    '기기 경로 진입 조건에서 serviceKey 요구 금지');
  assert.ok(route.includes('!userClient && !serviceKey'), '둘 다 없을 때만 포기');
});

test('스코프 방어선: 사용자 스코프는 RLS, 서비스 롤일 때만 .eq 필터', () => {
  assert.ok(/userClient \? q\.maybeSingle\(\) : q\.eq\('user_id', user\.id\)/.test(route),
    '서비스 롤 경로에만 .eq — RLS 경로에서 .eq를 유일 방어선으로 착각하지 않는다');
});

test('체험 배지 created_at도 서비스키 없이 얻는다(GoTrue /user)', () => {
  assert.ok(route.includes('userClient.auth.getUser()'), '사용자 토큰으로 created_at');
  assert.ok(route.includes('/auth/v1/admin/users/'), '서비스 롤 경로는 admin 조회 유지');
});
