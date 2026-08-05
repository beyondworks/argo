// 결제 표면 — **어떤 상태에서도 낼 방법이 있어야 한다**를 잠근다.
//
// 실사용 확인 2026-08-05: 신규 계정은 가입 14일 이내라 plan='trial'인데, 업그레이드 버튼은
// paywalled·free·임박(D-3) 셋에서만 렌더됐다. 그래서 **가입 1~11일차에는 결제 수단이 화면에
// 아예 없었다** — 지금 내겠다는 사람이 낼 수 없는 상태였다. 가장 큰 신규 코호트가 그 구간이다.
//
// 렌더 조건은 JSX라 노드 테스트로 못 돌린다 → 조건 골격을 소스에서 확인하는 트립와이어다.
// 실제 화면은 브라우저 확인이 정본(설정 → 기기 간 동기화 카드).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { trialBadgeState } from '../src/entitlement.mjs';

const page = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');

test('체험 중(임박 전)에도 업그레이드 경로가 있다 — 이 구간이 비면 결제할 방법이 없다', () => {
  assert.match(page, /trialActive && !trialImminent \?/, '동기화 켠 상태의 체험 구간 분기가 없다');
  assert.match(page, /\) : trialActive \? \(/, '동기화 끈 상태의 체험 구간 분기가 없다');
  // 두 자리 모두 버튼까지 실제로 붙어야 한다(문구만 있고 버튼이 없으면 같은 결함이다)
  const occurrences = page.split('<UpgradeButtons />').length - 1;
  assert.ok(occurrences >= 6, `UpgradeButtons 렌더 지점이 ${occurrences}곳 — 체험 구간 2곳이 빠졌다`);
});

test('체험 문구는 "끝났다"고 말하지 않는다 — 임박 전에는 거짓이다', async () => {
  const i18n = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const line = i18n.split('\n').find((l) => l.includes("'billing.trialUpgradeHint'"));
  assert.ok(line, 'billing.trialUpgradeHint 미등재');
  assert.match(line, /\[.+,.+\]/, 'ko·en 둘 다 있어야 한다(다국어 상시 규칙)');
  assert.doesNotMatch(line, /끝났|ended|expired/i, '임박 전 문구가 종료를 단정한다');
});

test('체험 판정 경계 — D-3부터 임박, 만료 후에는 active가 아니다', () => {
  const now = Date.UTC(2026, 7, 5);
  const at = (days) => new Date(now + days * 86_400_000).toISOString();
  assert.deepEqual(trialBadgeState(at(10), 'trial', now), { active: true, imminent: false, daysLeft: 10 });
  assert.equal(trialBadgeState(at(2), 'trial', now).imminent, true);
  assert.equal(trialBadgeState(at(-1), 'trial', now).active, false, '만료 후에도 체험으로 보이면 안 된다');
  assert.equal(trialBadgeState(at(10), 'pro', now).active, false, 'pro는 체험 배지 대상이 아니다');
});
