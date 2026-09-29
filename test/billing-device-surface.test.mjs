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

test('체험 배지·삭제예정(trialEndsAt·purgeAfter)도 서비스키 없이 얻는다(my_plan RPC, 2026-09-29)', () => {
  // 이전엔 GoTrue /user로 created_at을 받아 클라에서 +14일을 계산했다 — 14일 무료 체험 폐지(R1)로
  // "T 이전 가입자만 남은 체험"은 서버만 안다. userClient 경로는 자기 JWT로 my_plan()을 그대로
  // 부른다(서비스키 불요 불변식 유지) — 서비스 롤 경로만 uid를 명시해 부른다.
  assert.ok(route.includes('planExtras(sb)'), '사용자 스코프(userClient) 경로가 uid 없이 self로 my_plan을 부른다');
  assert.ok(route.includes("planExtras(sb, userClient ? undefined : user.id)"), '서비스 롤 경로만 uid를 명시');
  assert.ok(route.includes("sb.rpc('my_plan')"), 'my_plan RPC 호출이 있다');
});
