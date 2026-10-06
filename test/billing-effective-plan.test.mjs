// 설정 카드의 요금제 표시 = 서버 판정(my_plan().plan) — 실측 2026-10-06.
//
// 운영자가 부여한 Pro(entitlements.granted=true → entitled_pro_for → my_plan().plan='pro')인데
// 원시 행은 ls_status='expired'·ends_at 경과였다. /api/me/billing은 원시 plan·ends_at만 내렸고 화면은
// 그걸로 Free/Pro를 다시 계산해 'Free · 여러 기기 동기화는 Pro'와 업그레이드 버튼을 보였다. 동기화
// 엔진(fetchPlan)은 my_plan()으로 Pro 동작 — 화면만 어긋났다. 응답에 effectivePlan을 추가하고
// 화면은 accountPlan으로 그것을 먼저 쓴다. 원시 필드(구독 관리·대사용)는 그대로, 필드는 추가만.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accountPlan, billingCta, effectivePlanOf, trialBadgeState } from '../src/entitlement.mjs';

const NOW = Date.now();
const day = (n) => new Date(NOW + n * 86_400_000).toISOString();
// 화면이 하는 그대로 — 배지 판정 입력(page.jsx SyncCard)
const view = (bill) => {
  const plan = accountPlan(bill, NOW);
  const trial = trialBadgeState(bill?.trialEndsAt, plan === 'pro' ? 'pro' : bill?.plan, NOW);
  return { plan, trial: trial.active };
};

test('부여 Pro(granted) — 원시 행이 만료여도 Pro로 보이고 업그레이드 대상이 아니다', () => {
  // 유건 주 계정 모양: plan=pro, ls_status=expired, ends_at=2026-10-01(경과), 구독 식별자 있음
  const granted = { plan: 'pro', status: 'expired', hasSub: true, endsAt: day(-5), trialEndsAt: null, effectivePlan: 'pro' };
  assert.deepEqual(view(granted), { plan: 'pro', trial: false });
  assert.notEqual(billingCta(granted, { now: NOW }), 'upgrade');
  // 원시 plan이 free여도 granted면 서버는 pro다 — 화면도 pro
  const grantedFreeRow = { plan: 'free', status: null, hasSub: false, endsAt: null, effectivePlan: 'pro' };
  assert.equal(view(grantedFreeRow).plan, 'pro');
  assert.equal(billingCta(grantedFreeRow, { now: NOW }), 'granted', '구독 없는 부여 Pro는 미리 결제 진입로(기존 결정)');
});

test('LS 구독 active — Pro, 구독 관리', () => {
  const active = { plan: 'pro', status: 'active', hasSub: true, endsAt: null, effectivePlan: 'pro' };
  assert.deepEqual(view(active), { plan: 'pro', trial: false });
  assert.equal(billingCta(active, { now: NOW }), 'manage');
});

test('LS 만료(부여 없음) — 서버가 free면 Free, 업그레이드', () => {
  const expired = { plan: 'pro', status: 'expired', hasSub: true, endsAt: day(-5), effectivePlan: 'free' };
  assert.deepEqual(view(expired), { plan: 'free', trial: false });
  // 원시 plan이 아직 pro로 남은 만료 행 — 서버 판정 free가 이긴다(원시 plan으로 Pro를 보이지 않는다)
  const rawProButFree = { plan: 'pro', status: 'expired', hasSub: false, endsAt: null, effectivePlan: 'free' };
  assert.equal(view(rawProButFree).plan, 'free');
  assert.equal(billingCta(rawProButFree, { now: NOW }), 'upgrade');
});

test('체험(T 이전 가입자) — 체험 배지', () => {
  const trial = { plan: null, status: null, hasSub: false, endsAt: null, trialEndsAt: day(10), effectivePlan: 'trial' };
  assert.deepEqual(view(trial), { plan: 'trial', trial: true });
  assert.equal(billingCta(trial, { now: NOW }), 'trial');
});

test('free — Free, 업그레이드', () => {
  const free = { plan: 'free', status: null, hasSub: false, endsAt: null, trialEndsAt: null, effectivePlan: 'free' };
  assert.deepEqual(view(free), { plan: 'free', trial: false });
  assert.equal(billingCta(free, { now: NOW }), 'upgrade');
});

test('my_plan 실패·옛 서버(effectivePlan 없음) — 원시 행으로 예전 판정', () => {
  for (const eff of [null, undefined]) {
    assert.equal(accountPlan({ plan: 'pro', endsAt: null, effectivePlan: eff }, NOW), 'pro', '활성 pro');
    assert.equal(accountPlan({ plan: 'pro', endsAt: day(3), effectivePlan: eff }, NOW), 'pro', '해지 예약은 종료일까지');
    assert.equal(accountPlan({ plan: 'pro', endsAt: day(-1), effectivePlan: eff }, NOW), 'free', '만료 pro');
    assert.equal(accountPlan({ plan: 'free', trialEndsAt: day(5), effectivePlan: eff }, NOW), 'trial', '체험');
    assert.equal(accountPlan({ plan: 'free', effectivePlan: eff }, NOW), 'free');
  }
  assert.equal(accountPlan(null, NOW), null, 'billing 없음(로컬·게스트) — 계정 없음, 기기값 폴백은 화면 몫');
  // 모르는 값은 판정으로 쓰지 않는다(폴백)
  assert.equal(accountPlan({ plan: 'pro', endsAt: null, effectivePlan: 'enterprise' }, NOW), 'pro');
});

test('effectivePlanOf — my_plan 응답의 plan만, 모르는 값·없음은 null', () => {
  assert.equal(effectivePlanOf({ plan: 'pro' }), 'pro');
  assert.equal(effectivePlanOf({ plan: 'trial' }), 'trial');
  assert.equal(effectivePlanOf({ plan: 'free' }), 'free');
  assert.equal(effectivePlanOf({ plan: 'PRO' }), null);
  assert.equal(effectivePlanOf(null), null);
  assert.equal(effectivePlanOf({}), null);
});

// 배선(소스 앵커 — 라우트는 next 의존이라 임포트 불가, 화면은 JSX라 DOM 하네스 없음).
test('라우트가 my_plan 판정을 effectivePlan으로 싣고, 원시 필드는 그대로 둔다', async () => {
  const route = await readFile(new URL('../app/api/me/billing/route.js', import.meta.url), 'utf8');
  assert.match(route, /plan: effectivePlanOf\(data\)/, 'planExtras가 my_plan의 plan을 꺼내지 않는다');
  assert.match(route, /return \{ plan: null, trialEndsAt: null, purgeAfter: null \}/, 'my_plan 실패 시 plan=null(폴백)');
  assert.match(route, /effectivePlan: extras\.plan \?\? null/, '응답에 effectivePlan이 없다');
  // 옛 앱(0.1.95 이하)이 읽는 필드 — 추가만, 이름·의미 유지
  for (const f of ["plan: data?.plan ?? null", "status: data?.ls_status ?? null", "hasSub: !!data?.ls_subscription_id", "endsAt: data?.ends_at ?? null"]) {
    assert.ok(route.includes(f), `원시 필드가 바뀌었다: ${f}`);
  }
});

test('설정 카드가 accountPlan(서버 판정 우선)으로 표시·결제 분기를 정한다', async () => {
  const page = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /const acctPlan = accountPlan\(bill\);/);
  assert.match(page, /trialBadgeState\(bill\?\.trialEndsAt, acctPlan === 'pro' \? 'pro' : bill\?\.plan\)/,
    '서버가 Pro로 판정한 계정에 체험 배지가 뜬다');
});
