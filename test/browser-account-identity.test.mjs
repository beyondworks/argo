// 브라우저 계정 신원 계약 — 기기 주인의 플랜·회사가 다른 로그인 계정에게 보이던 결함(2026-08-05~06)의
// 두 뿌리를 소스 앵커로 잠근다. auth.mjs는 next/headers 의존이라 노드 테스트에서 import 불가 —
// 실행 검증은 상주/격리 서버 라이브 확인이 담당하고, 여기는 순서·배선의 회귀만 막는다(집 관례:
// runners-facade의 externalExec 앵커와 같은 패턴).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const auth = await readFile(new URL('../app/auth.mjs', import.meta.url), 'utf8');
const mw = await readFile(new URL('../middleware.js', import.meta.url), 'utf8');

test('currentUser 순서: 쿠키 세션이 기기 세션보다 먼저다', () => {
  const body = auth.split('export async function currentUser()')[1]?.split('\n}')[0] ?? '';
  assert.ok(body, 'currentUser 함수 앵커');
  // 골격 앵커 — sb- 게이트가 헬퍼로 추출돼도 살아남게 GoTrue 검증 호출을 기준으로 잡는다
  // (검수 변이 M5: 문자열 인스턴스 앵커는 정당한 리팩터에 거짓 red)
  const cookieAt = body.indexOf('.auth.getUser()');
  const deviceAt = body.indexOf('loadDeviceSession()');
  assert.ok(cookieAt >= 0, '쿠키 세션 검증(GoTrue getUser)이 존재해야 한다');
  assert.ok(deviceAt >= 0, '기기 세션 폴백이 존재해야 한다');
  // 기기 세션이 앞서면 브라우저 로그인 계정이 무시되고 신원이 기기 주인으로 고정된다(결함 재현 조건)
  assert.ok(cookieAt < deviceAt, '쿠키 세션 검증이 기기 세션보다 앞서야 한다 — 순서가 곧 결함');
});

test('포털 토큰 조달: currentUser와 같은 순서(쿠키 먼저) + 신원=토큰 소유자 대조', async () => {
  // 분리 검수 HIGH: 기기 세션을 먼저 보면 쿠키 사용자 B에게 기기 주인 A의 포털 링크가 발급된다.
  const portal = await readFile(new URL('../app/api/me/billing/portal/route.js', import.meta.url), 'utf8');
  const fn = portal.split('async function accessToken()')[1] ?? '';
  assert.ok(fn, 'accessToken 앵커');
  const cookieAt = fn.indexOf('.auth.getSession()');
  const deviceAt = fn.indexOf('getFreshDeviceSession()');
  assert.ok(cookieAt >= 0 && deviceAt >= 0, '두 조달 경로 존재');
  assert.ok(cookieAt < deviceAt, '쿠키 세션 토큰이 기기 세션보다 앞서야 한다');
  assert.ok(/uid\s*&&\s*[^)]*!==\s*user\.id/.test(portal), '신원=토큰 소유자 불일치 시 발급 중단(fail-closed)');
});

test('피드백 클라이언트 조달: currentUser와 같은 순서(쿠키 먼저)', async () => {
  const fb = await readFile(new URL('../app/api/feedback/route.js', import.meta.url), 'utf8');
  const body = fb.split('export async function POST')[1] ?? '';
  const cookieAt = body.indexOf('.auth.getUser()');
  const deviceAt = body.indexOf('getFreshDeviceSession()');
  assert.ok(cookieAt >= 0 && deviceAt >= 0, '두 조달 경로 존재');
  assert.ok(cookieAt < deviceAt, '쿠키 세션 검증이 기기 세션보다 앞서야 한다 — 갈리면 auth.uid()와 email 귀속이 섞인다');
});

test('middleware: argo-device 마커가 /login을 홈으로 가로채지 않는다(계정 전환 경로)', () => {
  // 마커 블록 안에서 /login을 리다이렉트하면 "로그인 버튼이 안 눌린다"가 재발한다.
  // 실세션의 /login 홈 리다이렉트(user && p === '/login')는 정당 — 그 한 곳만 남아야 한다.
  const deviceBlocks = mw.split("argo-device").slice(1);
  assert.ok(deviceBlocks.length >= 2, 'argo-device 마커 분기 2곳(지름길·세션후) 존재');
  for (const block of deviceBlocks) {
    const head = block.slice(0, 400); // 각 분기의 본문 반경
    assert.ok(!/'\/login'\)?\s*\)?\s*return NextResponse\.redirect/.test(head),
      'argo-device 분기 안에 /login 리다이렉트 잔존 금지');
  }
  // 골격 정규식 — 포맷(중괄호·줄바꿈) 변화에 둔감하게(검수 변이 M7: 문자 앵커는 거짓 red)
  assert.ok(/user\s*&&\s*p\s*===\s*'\/login'[\s\S]{0,80}?NextResponse\.redirect/.test(mw),
    '실세션의 /login 홈 리다이렉트는 유지(정당한 UX)');
});
