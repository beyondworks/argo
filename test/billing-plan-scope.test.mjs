// 플랜은 **계정별**이다 — 기기별이 아니다.
//
// 실측 2026-08-05: 설정의 결제 카드가 `sync.plan`(이 기기의 동기화 주체 = 기기 연동 계정)을 보고
// 있었다. 한 컴퓨터를 두 사람이 쓰면 무료 계정으로 로그인해도 기기 주인이 Pro면 **Pro 배지가 뜨고
// 업그레이드 버튼이 숨겨진다** — 낼 방법이 사라진다. ARGO_ENFORCE_PLAN을 켜면 반대 방향(엉뚱한
// 사람 차단)으로도 터진다. 그래서 유료 전환 전에 닫아야 하는 자리다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { proRowActive } from '../src/entitlement.mjs';

const page = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');

test('결제 분기는 sync.plan(기기값)을 쓰지 않는다', async () => {
  // 슬라이스로 범위를 좁혔더니 경계가 뒤집혀 빈 문자열이 됐고, 변이를 넣어도 초록이었다(2026-08-05).
  // 파일 전체에서 센다 — 이 화면의 plan 비교는 전부 계정 기준이어야 하므로 예외가 없다.
  assert.doesNotMatch(page, /sync\??\.plan === /, '결제 분기가 기기 플랜으로 되돌아갔다 — 남의 플랜이 보인다');
  assert.match(page, /const acctPlan = bill/, '계정 기준 플랜 계산이 없다');
  // 기기값 폴백은 **계정이 없는 모드에서만**. 문장 리터럴이 아니라 그 문장이 지켜야 할 두 성질을
  // 잠근다 — 리터럴을 박으면 정당한 정정에도 거짓 red가 난다(실제로 났다: 2026-08-19 MED-A 수정).
  const planStmt = page.match(/const plan = [^;]+;/)?.[0] ?? '';
  assert.match(planStmt, /acctPlan/, '계정 기준 값이 우선이어야 한다');
  assert.match(planStmt, /billLost/, '조회 실패(unavailable)에는 기기값으로 메우지 않는다 — 남의 플랜이 표시·판정에 쓰인다');
  // 조회 실패와 "계정 없음"이 구분되지 않으면 위 가드가 성립할 수 없다(라우트의 reason 계약).
  const route = await readFile(new URL('../app/api/me/billing/route.js', import.meta.url), 'utf8');
  for (const r of ['no-cloud', 'unauthenticated', 'unavailable']) {
    assert.ok(route.includes(`reason: '${r}'`), `billing=null의 원인 ${r}이 응답에서 사라졌다`);
  }
});

test('판정은 서버 is_pro와 같은 공유 술어를 쓴다 — 네 번째 판정을 만들지 않는다', () => {
  assert.match(page, /proRowActive\(\{ plan: bill\.plan, ends_at: bill\.endsAt \}\)/);
  // 공유 술어 자체의 계약(해지 예약·만료 반영)
  assert.equal(proRowActive({ plan: 'pro', ends_at: null }), true);
  assert.equal(proRowActive({ plan: 'pro', ends_at: new Date(Date.now() - 1000).toISOString() }), false, '만료된 pro는 pro가 아니다');
  assert.equal(proRowActive({ plan: 'pro', ends_at: new Date(Date.now() + 86_400_000).toISOString() }), true, '해지 예약은 종료일까지 유지');
  assert.equal(proRowActive(null), false, '행 없음은 pro가 아니다');
});
