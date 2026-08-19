// 결제 CTA 결정 — 플랜 상태 전수. 실사고 2026-08-19: 구독 없는 Pro(그랜드파더링 44계정)가
// 설정 화면 두 체인(동기화 ON/OFF) 모두에서 null로 떨어져 결제 진입로가 아예 없었다.
// "낼 의사가 있는 사용자가 낼 수 없는 상태"는 매출 결함이라 상태별로 못 박는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingCta } from '../src/entitlement.mjs';

const day = (n) => new Date(Date.now() + n * 86400000).toISOString();

test('플랜 상태 전수 → CTA', () => {
  assert.equal(billingCta({ plan: 'free', hasSub: false }), 'upgrade', 'free는 업그레이드 안내');
  assert.equal(billingCta({ plan: 'trial', hasSub: false, trialEndsAt: day(10) }), 'trial', '체험 중');
  assert.equal(billingCta({ plan: 'trial', hasSub: false, trialEndsAt: day(2) }), 'trial-soon', '체험 임박');
  assert.equal(billingCta({ plan: 'pro', hasSub: true, status: 'active' }), 'manage', '유료 구독자는 관리');
  assert.equal(billingCta({ plan: 'pro', hasSub: true, status: 'past_due' }), 'past-due', '연체 유예');
  assert.equal(billingCta(null), null, '정보 없음이면 아무것도 안 보인다');
});

test('구독 없는 Pro는 반드시 결제 진입로가 있다 (핵심 회귀)', () => {
  assert.equal(billingCta({ plan: 'pro', hasSub: false }), 'granted',
    '부여 Pro가 null로 떨어지면 그 사용자는 영구히 결제할 수 없다');
  assert.equal(billingCta({ plan: 'pro', hasSub: false, endsAt: day(30) }), 'granted',
    '종료일이 있어도 결제 진입로는 열려 있어야 한다');
});

test('페이월은 다른 무엇보다 먼저, 연체는 페이월보다 먼저', () => {
  assert.equal(billingCta({ plan: 'free', hasSub: false }, { paywalled: true }), 'paywalled');
  assert.equal(billingCta({ plan: 'trial', hasSub: false, trialEndsAt: day(10) }, { paywalled: true }), 'paywalled',
    '막힌 사용자에겐 체험 안내보다 결제가 먼저다');
  assert.equal(billingCta({ plan: 'pro', hasSub: true, status: 'past_due' }, { paywalled: true }), 'past-due',
    '연체 유예 안내는 페이월 문구보다 구체적이라 우선한다');
});

// 구조 검사(행동 아님 — DOM 하네스가 없어 이 축은 소스로만 잠근다):
// 설정 결제 카드는 동기화 ON/OFF 두 체인으로 갈리고, 둘 다 부여 Pro를 처리해야 한다.
// 한쪽만 고치면 그 절반의 사용자는 계속 결제를 못 한다(실사고 2026-08-19).
test('설정 결제 카드: 동기화 ON·OFF 두 체인 모두 부여 Pro를 처리한다', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  // 다음 최상위 function 선언까지로 **끊는다** — 안 끊으면 OFF 갈래 조각에 파일 뒷부분
  // (UpgradeButtons 정의 자체)이 딸려 들어와 아래 버튼 단언이 항상 참이 된다(재검수 MED-D).
  const card = (src.split('function SyncCard')[1] ?? '').split('\nfunction ')[0];
  assert.ok(card, 'SyncCard 컴포넌트를 찾지 못했다');
  assert.doesNotMatch(card, /function UpgradeButtons/, 'SyncCard 범위가 안 끊겼다 — 아래 단언이 무의미해진다');
  // 외곽 조건(mine ? … : …)의 두 갈래로 쪼갠다 — offHelp가 OFF 갈래의 고유 표식이다
  const i = card.indexOf("settings.sync.offHelp");
  assert.ok(i > 0, 'OFF 갈래 표식(settings.sync.offHelp)을 찾지 못했다');
  const on = card.slice(0, i), off = card.slice(i);
  // `bill &&` 필수 — bill=null이면 plan이 기기 스코프 sync.plan으로 폴백해 실구독자에게도
  // 결제 CTA가 뜬다(분리 검수 MED-1). 계정 정보가 없으면 결제 표면도 없어야 한다.
  const granted = /bill && plan === 'pro' && !bill\.hasSub/;
  assert.ok(granted.test(on), '동기화 ON 갈래에 부여 Pro 분기가 없다');
  assert.ok(granted.test(off), '동기화 OFF 갈래에 부여 Pro 분기가 없다');
  for (const half of [on, off]) {
    assert.ok(/UpgradeButtons/.test(half), '각 갈래에 결제 버튼 경로가 있어야 한다');
  }
});
