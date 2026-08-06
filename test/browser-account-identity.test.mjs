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
  const cookieAt = body.indexOf("startsWith('sb-')");
  const deviceAt = body.indexOf('loadDeviceSession()');
  assert.ok(cookieAt >= 0, '쿠키 세션 검사(sb-* 게이트)가 존재해야 한다');
  assert.ok(deviceAt >= 0, '기기 세션 폴백이 존재해야 한다');
  // 기기 세션이 앞서면 브라우저 로그인 계정이 무시되고 신원이 기기 주인으로 고정된다(결함 재현 조건)
  assert.ok(cookieAt < deviceAt, '쿠키 세션 검사가 기기 세션보다 앞서야 한다 — 순서가 곧 결함');
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
  assert.ok(mw.includes("if (user && p === '/login') return NextResponse.redirect"),
    '실세션의 /login 홈 리다이렉트는 유지(정당한 UX)');
});
