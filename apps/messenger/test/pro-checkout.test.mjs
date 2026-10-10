// 메신저 Pro 결제(2026-10-11) — 본체·랜딩과 같은 결제·같은 권한. 잠그는 것:
//  · 체크아웃 주소 = 본체 설정 버튼·랜딩과 같은 함수의 결과(custom user_id·email, 월간·연간), 이미 Pro·모름이면 null(이중 구독 방지)
//  · iOS는 구매 경로 없음(App Store 3.1.1) — 업그레이드 버튼·구독 관리 링크를 그리지 않는다
//  · 결제 뒤 재확인은 라운드당 최대 5회, 업그레이드를 누른 뒤 15분 안의 복귀에서만(DB 위생)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pro from '../src/pro-checkout.mjs';
import * as landing from '../../../landing/lib/checkout.js';
import { t as tr } from '../src/i18n.js';
import { checkoutUrl as appCheckoutUrl } from '../../../app/c/[ws]/settings/checkout-link.mjs';

const USER = { id: '0b8f2c1e-6d3a-4c1b-9b8e-2f7d1a3c5e90', email: 'pay@example.com' };

test('주소 — 본체 설정 버튼·랜딩과 같은 결과(월간·연간, user_id·email)', () => {
  for (const cadence of ['monthly', 'yearly']) {
    for (const user of [USER, { id: USER.id, email: '' }, { id: USER.id, email: 'undefined' }, { id: 'local', email: 'a@b.co' }, null]) {
      const base = cadence === 'yearly' ? landing.LS_YEARLY : landing.LS_MONTHLY;
      const got = pro.proCheckoutUrl({ plan: 'free', user, cadence });
      assert.equal(got, appCheckoutUrl(base, user), `${cadence} ${JSON.stringify(user)}`);
      assert.equal(got, landing.checkoutUrl(base, user));
    }
  }
  const m = new URL(pro.proCheckoutUrl({ plan: 'free', user: USER, cadence: 'monthly' }));
  assert.equal(m.searchParams.get('checkout[custom][user_id]'), USER.id);
  assert.equal(m.searchParams.get('checkout[email]'), USER.email);
  assert.match(m.pathname, /8ec2b79d-/, '월간 변형');
  const y = new URL(pro.proCheckoutUrl({ plan: 'trial', user: USER, cadence: 'yearly' }));
  assert.match(y.pathname, /a68219ba-/, '연간 변형');
  assert.equal(y.searchParams.get('checkout[custom][user_id]'), USER.id);
  assert.equal(pro.proCheckoutUrl({ plan: 'free', user: USER, cadence: 'weekly' }), pro.proCheckoutUrl({ plan: 'free', user: USER }), '모르는 주기는 월간');
});

test('이미 Pro이거나 판정을 모르면 체크아웃을 만들지 않는다(#934 이중 구독 방지)', () => {
  for (const plan of ['pro', null, undefined, '', 'team']) assert.equal(pro.proCheckoutUrl({ plan, user: USER }), null, String(plan));
  assert.equal(pro.planOf({ plan: 'pro' }), 'pro');
  assert.equal(pro.planOf({ plan: 'weird' }), null);
  assert.equal(pro.planOf(null), null);
});

test('구매 경로 — iOS는 없음, 나머지(맥·윈도우·Android·웹)는 web', () => {
  assert.equal(pro.purchaseChannel({ ios: true }), 'none');
  assert.equal(pro.purchaseChannel({ ios: false }), 'web');
  assert.equal(pro.purchaseChannel(), 'web');
});

test('카드 — iOS에서는 무료여도 업그레이드 버튼·구독 관리 링크가 없다', () => {
  for (const plan of ['free', 'trial']) {
    assert.deepEqual(pro.planView({ plan, channel: 'none' }), { kind: plan, buy: false, portal: false });
    assert.equal(pro.planView({ plan, channel: 'web' }).buy, true);
  }
  const sub = { plan: 'pro', ls_subscription_id: 'sub_1', ls_status: 'active', ends_at: null };
  assert.equal(pro.planView({ plan: 'pro', row: sub, channel: 'none' }).portal, false);
  assert.equal(pro.planView({ plan: 'pro', row: sub, channel: 'web' }).portal, true);
});

test('카드 — Pro 갈래(구독·해지 예약·결제 실패·부여) 어디에도 업그레이드 버튼이 없다', () => {
  const now = Date.parse('2026-10-11T00:00:00Z');
  const future = '2026-12-01T00:00:00Z'; const past = '2026-09-01T00:00:00Z';
  const v = (row) => pro.planView({ plan: 'pro', row, now });
  assert.equal(v({ plan: 'pro', ls_subscription_id: 's', ls_status: 'active' }).kind, 'pro-sub');
  assert.equal(v({ plan: 'pro', ls_subscription_id: 's', ls_status: 'cancelled', ends_at: future }).kind, 'pro-cancelled');
  assert.equal(v({ plan: 'pro', ls_subscription_id: 's', ls_status: 'past_due' }).kind, 'pro-pastdue');
  assert.equal(v(null).kind, 'pro-granted', '운영자 부여·조직 좌석 — 행이 없어도 서버가 Pro면 Pro');
  assert.equal(v({ plan: 'free', ls_status: 'expired', ends_at: past }).kind, 'pro-granted', '원시 행이 만료여도 서버 판정이 이긴다(10/6 실측)');
  for (const row of [null, { plan: 'pro', ls_subscription_id: 's' }, { plan: 'pro', ls_subscription_id: 's', ls_status: 'past_due' }]) assert.equal(v(row).buy, false);
  assert.deepEqual(pro.planView({ plan: null }), { kind: 'unavailable', buy: false, portal: false }, '판정을 못 읽으면 결제 표면 없음');
  assert.equal(pro.planView({ plan: 'free', loading: true }).kind, 'loading');
});

test('결제 뒤 재확인 — 라운드당 최대 5회, Pro가 되면 바로 멈춘다', async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  let n = 0;
  const never = await pro.recheckUntilPro(async () => { n += 1; return 'free'; }, { sleep });
  assert.equal(never.tries, 5); assert.equal(n, 5); assert.equal(never.plan, 'free');
  assert.deepEqual(slept, [3000, 5000, 10000, 20000], '첫 읽기는 바로, 그 뒤 3·5·10·20초');
  assert.equal(pro.RECHECK_DELAYS_MS.length, 5);
  assert.ok(pro.RECHECK_DELAYS_MS.reduce((a, b) => a + b, 0) <= 60_000, '한 라운드 1분 안');
  let k = 0;
  const got = await pro.recheckUntilPro(async () => (++k === 3 ? 'pro' : 'free'), { sleep: async () => {} });
  assert.deepEqual(got, { plan: 'pro', tries: 3 });
  const failing = await pro.recheckUntilPro(async () => { throw new Error('net'); }, { sleep: async () => {} });
  assert.deepEqual(failing, { plan: null, tries: 5 }, '읽기 실패도 횟수에 든다 — 무한 재시도 없음');
  let alive = true; let r = 0;
  const left = await pro.recheckUntilPro(async () => { r += 1; alive = false; return 'free'; }, { sleep: async () => {}, alive: () => alive });
  assert.equal(left.tries, 1, '화면을 떠나면 더 읽지 않는다'); assert.equal(r, 1);
});

test('복귀 재확인은 업그레이드를 누른 뒤 15분 안, 라운드가 돌고 있지 않을 때만', () => {
  const t0 = 1_000_000;
  assert.equal(pro.shouldRecheckOnReturn({ armedAt: null, now: t0 }), false, '누르지 않았으면 읽지 않는다');
  assert.equal(pro.shouldRecheckOnReturn({ armedAt: t0, now: t0 + 60_000 }), true);
  assert.equal(pro.shouldRecheckOnReturn({ armedAt: t0, now: t0 + 60_000, running: true }), false, '겹치지 않는다');
  assert.equal(pro.shouldRecheckOnReturn({ armedAt: t0, now: t0 + pro.ARM_MS }), false, '15분 뒤는 끝');
  assert.equal(pro.ARM_MS, 15 * 60 * 1000);
});

test('한도 안내 판정 — 코드 목록 한 곳, 원문 코드와 번역 문구 둘 다', () => {
  assert.deepEqual(pro.PRO_UPSELL, { msgr_pro_required: 'err.proRequired', msgr_room_limit: 'room.limit' });
  for (const lang of ['ko', 'en']) {
    const t = (k) => tr(k, lang);
    for (const key of Object.values(pro.PRO_UPSELL)) assert.notEqual(t(key), key, `${key} 사전 문구(${lang})`);
    assert.equal(pro.isProUpsell(t('err.proRequired'), t), true, lang);
    assert.equal(pro.isProUpsell(t('room.limit'), t), true, lang);
    assert.equal(pro.isProUpsell(t('seat.limit'), t), false, '조직 좌석은 개인 Pro로 풀리지 않는다');
  }
  assert.equal(pro.isProUpsell('msgr_pro_required'), true);
  assert.equal(pro.isProUpsell('ERROR: msgr_room_limit (22023)'), true);
  assert.equal(pro.isProUpsell('msgr_seat_limit'), false);
  assert.equal(pro.isProUpsell(''), false);
  assert.equal(pro.isProUpsell('msgr_pro_required_x'), false);
});

test('대체 포털은 상품과 같은 가게의 /billing', () => {
  assert.equal(pro.LS_BILLING, `${new URL(landing.LS_MONTHLY).origin}/billing`);
});

test('모듈은 새 가격 숫자·새 LS 주소를 두지 않는다(본체·랜딩 것을 가져온다)', () => {
  const src = readFileSync(new URL('../src/pro-checkout.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\$\d|lemonsqueezy\.com/, '가격·주소 사본 없음');
  assert.match(src, /from '\.\.\/\.\.\/\.\.\/app\/c\/\[ws\]\/settings\/checkout-link\.mjs'/);
});

test('화면 연결 — 카드는 iOS 판정으로 구매 경로를 고르고, 버튼·구독 관리는 planView가 허락할 때만 그린다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const card = app.slice(app.indexOf('function PlanCard('), app.indexOf('async function planRow('));
  assert.match(card, /purchaseChannel\(\{ ios: isIos \}\)/, '메신저의 iOS 판정(platform.js) 재사용');
  assert.match(card, /\{view\.buy && \(/, '업그레이드 버튼은 view.buy일 때만');
  assert.match(card, /\{view\.portal && /, '구독 관리는 view.portal일 때만');
  assert.match(card, /ta\('billing\.upgradeMonthly'\)/); assert.match(card, /ta\('billing\.upgradeYearly'\)/);
  assert.match(card, /supabase\.rpc\('my_plan'\)/, '판정은 my_plan');
  assert.doesNotMatch(card, /setInterval/, '폴링 없음');
  assert.match(app, /const proUpsell = !!err && purchaseChannel\(\{ ios: isIos \}\) === 'web' && isProUpsell\(err, t\);/, 'iOS는 안내를 플랜으로 잇지 않는다');
});
