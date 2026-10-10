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
  assert.match(card, /purchaseChannel\(\{ ios: isIos, customServer \}\)/, '메신저의 iOS 판정(platform.js)·회사 서버 판정(supabase.js) 재사용');
  assert.match(card, /\{view\.buy && \(/, '업그레이드 버튼은 view.buy일 때만');
  assert.match(card, /\{view\.portal && /, '구독 관리는 view.portal일 때만');
  assert.match(card, /ta\('billing\.upgradeMonthly'\)/); assert.match(card, /ta\('billing\.upgradeYearly'\)/);
  assert.match(card, /supabase\.rpc\('my_plan'\)/, '판정은 my_plan');
  assert.doesNotMatch(card, /setInterval/, '폴링 없음');
  assert.match(app, /const proUpsell = !!err && purchaseChannel\(\{ ios: isIos, customServer \}\) === 'web' && isProUpsell\(err, t\);/, 'iOS·회사 서버는 안내를 플랜으로 잇지 않는다');
});

// ── 분리 검수 #944 반영(2026-10-11) ──
test('MEDIUM-1 회사 서버 — 구매 경로 없음(그 서버 uid로 클라우드 결제를 만들면 웹훅이 FK에서 실패해 돈만 나간다)', () => {
  assert.equal(pro.purchaseChannel({ customServer: true }), 'none');
  assert.equal(pro.purchaseChannel({ ios: false, customServer: true }), 'none');
  assert.equal(pro.purchaseChannel({ ios: false, customServer: false }), 'web');
  for (const plan of ['free', 'trial']) assert.deepEqual(pro.planView({ plan, channel: pro.purchaseChannel({ customServer: true }) }), { kind: plan, buy: false, portal: false });
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const card = app.slice(app.indexOf('function PlanCard('), app.indexOf('async function planRow('));
  assert.match(card, /purchaseChannel\(\{ ios: isIos, customServer \}\)/, '카드도 같은 판정');
  assert.match(card, /channel === 'none' && isIos && !isPro/, "'Pro면 자동 적용' 안내는 iOS에서만 — 회사 서버는 플랜 표시만");
});

test('LOW-1 구독 행이 살아 있을 때만 구독 갈래 — 옛 구독 행이 남은 부여·좌석 Pro는 pro-granted(구독 관리 없음)', () => {
  const now = Date.parse('2026-10-11T00:00:00Z');
  const past = '2026-09-01T00:00:00Z'; const future = '2026-12-01T00:00:00Z';
  const v = (row) => pro.planView({ plan: 'pro', row, now });
  for (const row of [
    { plan: 'free', ls_subscription_id: 'old', ls_status: 'expired', ends_at: past },
    { plan: 'pro', ls_subscription_id: 'old', ls_status: 'expired', ends_at: past },
    { plan: 'free', ls_subscription_id: 'old', ls_status: 'past_due', ends_at: null },
  ]) {
    const got = v(row);
    assert.equal(got.kind, 'pro-granted', JSON.stringify(row)); assert.equal(got.portal, false); assert.equal(got.buy, false);
  }
  assert.equal(v({ plan: 'pro', ls_subscription_id: 's', ls_status: 'active', ends_at: null }).kind, 'pro-sub');
  assert.equal(v({ plan: 'pro', ls_subscription_id: 's', ls_status: 'cancelled', ends_at: future }).kind, 'pro-cancelled');
  assert.equal(v({ plan: 'pro', ls_subscription_id: 's', ls_status: 'past_due', ends_at: null }).kind, 'pro-pastdue');
});

test('LOW-2 Pro 필요 거절은 내 에이전트일 때만 플랜으로 잇는다 — 남의 에이전트면 주인에게 알리라는 문구', () => {
  for (const lang of ['ko', 'en']) {
    const t = (k) => tr(k, lang);
    const msg = 'new row violates: msgr_pro_required';
    assert.equal(pro.proRequiredFor(msg, { ownerId: 'me', uid: 'me', t }), msg, '내 에이전트 — 원문 그대로(토스트가 플랜으로 잇는다)');
    const other = pro.proRequiredFor(msg, { ownerId: 'someone', uid: 'me', t });
    assert.equal(other, t('err.proRequired.owner'));
    assert.notEqual(t('err.proRequired.owner'), 'err.proRequired.owner', `사전 문구(${lang})`);
    assert.equal(pro.isProUpsell(other, t), false, '플랜 카드로 잇지 않는다');
    assert.equal(pro.proRequiredFor('msgr_room_limit', { ownerId: 'someone', uid: 'me', t }), 'msgr_room_limit', '다른 오류는 그대로');
  }
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /if \(up\.error\) up\.error\.message = proRequiredFor\(up\.error\.message, \{ ownerId: crew\.owner_user_id, uid, t \}\);[^\n]*\n\s*if \(up\.error\) throw new Error\(up\.error\.message\);/, '그 자리 파견(바꾼 문구를 다음 줄이 던진다 — #945와 같은 줄을 고치지 않는다)');
  assert.match(app, /if \(res\.error\) return onError\(proRequiredFor\(res\.error\.message, \{ ownerId: crew\.owner_user_id, uid, t \}\)\);/, '에이전트 카드 파견');
});

test('LOW-3 복귀 재확인 — 한 번 누르면 라운드 한 번(라운드가 시작되면 무장 해제), 겹치지 않음, 수동 1회는 언제나', () => {
  let clock = 1_000_000; const g = pro.returnRecheck({ now: () => clock });
  assert.equal(g.start(), false, '누르지 않았으면 시작하지 않는다');
  g.arm(); clock += 60_000;
  assert.equal(g.start(), true);
  assert.equal(g.start(), false, '돌고 있으면 겹치지 않는다');
  g.end(); clock += 1000;
  assert.equal(g.start(), false, '라운드가 끝나면 15분 안이어도 포커스마다 새 라운드를 시작하지 않는다');
  assert.equal(g.startManual(), true, "'다시 확인' 1회는 된다"); assert.equal(g.startManual(), false, '돌고 있으면 겹치지 않는다'); g.end();
  g.arm(); clock += pro.ARM_MS;
  assert.equal(g.start(), false, '15분 뒤는 끝');
});

// 가짜 타이머 — setTimer가 만든 타이머를 모아 두고 시험이 하나씩 터뜨린다
function fakeTimers() {
  const timers = new Map(); let next = 1; let cleared = 0;
  return {
    timers, get cleared() { return cleared; },
    setTimer: (fn, ms) => { timers.set(next, { fn, ms }); return next++; },
    clearTimer: (id) => { if (timers.delete(id)) cleared += 1; },
    async fire() { for (let i = 0; i < 50 && timers.size === 0; i += 1) await new Promise((r) => setImmediate(r)); const [id, t] = [...timers.entries()][0]; timers.delete(id); t.fn(); return t.ms; },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('M-3 업그레이드 버튼 — 확인 중에는 막고(웹훅이 늦는 구간의 이중 구독 방지), 미확인 표시가 뜬 뒤에는 다시 누를 수 있다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const card = app.slice(app.indexOf('function PlanCard('), app.indexOf('async function planRow('));
  assert.match(card, /disabled=\{checking\} onClick=\{\(\) => upgrade\('monthly'\)\}/, '월간: 확인 중에만 막는다');
  assert.match(card, /disabled=\{checking\} onClick=\{\(\) => upgrade\('yearly'\)\}/, '연간도');
  assert.doesNotMatch(card, /disabled=\{[^}]*notYet/, '"아직 결제가 확인되지 않았습니다" 뒤에는 막지 않는다(검수 화면 확인: 38초 뒤 설정을 닫았다 열어야 풀렸다)');
});

test('M-2 화면 연결 — 화면은 recheckFlow 하나로만 재확인한다(관문·라운드 따로 쥐지 않음), 클릭·이탈이 그 정리를 부른다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const card = app.slice(app.indexOf('function PlanCard('), app.indexOf('async function planRow('));
  assert.match(card, /recheckFlow\(\{ readPlan, alive: \(\) => live\.current, onChecking: setChecking, onNotYet: setNotYet, onPro: \(\) => latest\.current\.load\(\) \}\)/, '표시·Pro 반영을 흐름에 연결');
  assert.match(card, /const upgrade = [^\n]*flow\.current\.upgraded\(\); openExternal\(url\)/, '새 클릭 = 흐름 정리·무장(결제창은 그 뒤)');
  assert.match(card, /return \(\) => \{ flow\.current\.dispose\(\); live\.current = false; \}/, 'L-2 화면을 떠나면 라운드·타이머 정리(L-3: 살아 있을 때 불러 확인 중 표시도 되돌림)');
  assert.match(card, /flow\.current\.recheck\(once\)/, '복귀·다시 확인은 흐름의 recheck');
  assert.doesNotMatch(card, /returnRecheck\(|roundTracker\(|recheckUntilPro\(/, '화면이 관문·라운드를 직접 쥐지 않는다 — 한 곳(recheckFlow)');
});

test('L-1·정리 — roundTracker: 정리된 라운드가 읽기 중에 건 다음 대기는 타이머를 만들지 않고, cancel은 쉬는 타이머를 지운다', async () => {
  const f = fakeTimers(); const rounds = pro.roundTracker({ setTimer: f.setTimer, clearTimer: f.clearTimer });
  const a = rounds.begin(); const sleepA = rounds.sleepFor(a);
  const slept = sleepA(3000); assert.equal(f.timers.size, 1);
  rounds.cancel(); assert.equal(f.cleared, 1, 'cancel이 쉬는 타이머를 지웠다'); assert.equal(f.timers.size, 0); await slept;
  await sleepA(5000); assert.equal(f.timers.size, 0, '정리된 라운드의 뒤늦은 대기는 타이머 없이 바로 끝'); assert.equal(rounds.isCurrent(a), false);
  const b = rounds.begin(); const c = rounds.begin();
  assert.equal(rounds.isCurrent(b), false); assert.equal(rounds.isCurrent(c), true, 'begin은 이전 라운드를 정리');
  const sb = rounds.sleepFor(b)(1000); assert.equal(f.timers.size, 0, '옛 라운드 b는 타이머를 못 만든다'); await sb;
  const pending = rounds.sleepFor(c)(1000); rounds.begin(); assert.equal(f.timers.size, 0, 'begin이 현재 라운드 타이머도 지운다'); await pending;
});

test('M-1 라운드 결말 판정 — 정리된 라운드가 Pro를 읽었으면 버리지 않는다(이중 구독 방지), 미확인 표시는 현재 라운드만', () => {
  const v = pro.roundVerdict;
  assert.deepEqual(v({ current: true, alive: true, plan: 'free' }), { end: true, settle: true, load: false, notYet: true });
  assert.deepEqual(v({ current: true, alive: true, plan: 'pro' }), { end: true, settle: true, load: true, notYet: false });
  assert.deepEqual(v({ current: false, alive: true, plan: 'pro' }), { end: false, settle: false, load: true, notYet: false }, '정리된 라운드의 Pro는 반영, 관문·표시는 건드리지 않음');
  assert.deepEqual(v({ current: false, alive: true, plan: 'free' }), { end: false, settle: false, load: false, notYet: false });
  assert.deepEqual(v({ current: true, alive: false, plan: 'pro' }), { end: true, settle: false, load: false, notYet: false }, '화면을 떠났으면 아무것도 그리지 않는다');
});

function flowHarness(readPlan, opts = {}) {
  const f = fakeTimers(); let clock = 1_000_000; const log = []; let pros = 0;
  const flow = pro.recheckFlow({ readPlan, setTimer: f.setTimer, clearTimer: f.clearTimer, now: () => clock, alive: () => !opts.gone, onChecking: (x) => log.push(`checking:${x}`), onNotYet: (x) => log.push(`notYet:${x}`), onPro: async () => { pros += 1; } });
  return { f, flow, log, get pros() { return pros; }, advance: (ms) => { clock += ms; } };
}

test('M-2 재클릭 뒤 복귀하면 새 라운드가 시작되고(0·3·5·10·20초 5회), 재클릭 전 라운드는 더 읽지 않는다', async () => {
  let reads = 0; const h = flowHarness(async () => { reads += 1; return 'free'; });
  h.flow.upgraded(); h.advance(1000);
  const first = h.flow.recheck(); await tick();
  assert.equal(reads, 1, '복귀 = 첫 읽기'); assert.equal(h.f.timers.size, 1);
  assert.equal(h.flow.gate.running, true);
  h.flow.upgraded(); // 확인 중에 새로 누름(화면은 막지만, 흐름은 정리·무장이 확실해야 한다)
  assert.equal(h.f.timers.size, 0, '쉬던 타이머 정리'); assert.equal(h.flow.gate.running, false, 'upgraded가 관문을 해제(안 하면 새 복귀가 겹침으로 거절됨)');
  await first; assert.equal(reads, 1, '정리된 라운드는 더 읽지 않는다');
  assert.equal(h.log.at(-1), 'notYet:false', '재클릭이 표시를 초기화(확인 중·미확인 둘 다 끔)'); assert.ok(h.log.includes('checking:false'));
  assert.ok(!h.log.includes('notYet:true'), '정리된 라운드는 미확인을 띄우지 않는다');
  h.advance(5000); reads = 0; h.log.length = 0;
  const second = h.flow.recheck(); await tick();
  assert.equal(reads, 1, '재클릭 뒤 복귀 — 새 라운드 시작');
  const waits = []; for (let i = 0; i < 4; i += 1) waits.push(await h.f.fire());
  await second;
  assert.deepEqual(waits, [3000, 5000, 10000, 20000]); assert.equal(reads, 5, '읽기 횟수는 라운드당 5회 그대로');
  assert.deepEqual(h.log, ['checking:true', 'notYet:false', 'checking:false', 'notYet:true'], '끝나면 미확인 표시');
  assert.equal(h.flow.gate.running, false);
  h.advance(1000); assert.equal(await h.flow.recheck(), false, '라운드가 끝난 뒤 포커스마다 새 라운드가 돌지 않는다');
});

test('M-1 정리된 라운드가 읽던 중 Pro로 끝나면 반영한다(재현: 읽기 중 cancel → pro)', async () => {
  let release; const gateRead = new Promise((r) => { release = r; });
  const h = flowHarness(async () => { await gateRead; return 'pro'; });
  h.flow.upgraded(); const run = h.flow.recheck(); await tick();
  h.flow.upgraded(); release(); await run; // 읽는 중에 새 클릭 → 그 읽기는 'pro'
  assert.equal(h.pros, 1, 'Pro 반영(load)이 불렸다 — 버려지지 않음');
  assert.ok(!h.log.includes('notYet:true'));
});

test('L-2 dispose — 화면을 떠나면 쉬는 타이머를 지우고 더 읽지 않는다', async () => {
  let reads = 0; const h = flowHarness(async () => { reads += 1; return 'free'; });
  h.flow.upgraded(); const run = h.flow.recheck(); await tick(); assert.equal(h.f.timers.size, 1);
  h.flow.dispose(); assert.equal(h.f.timers.size, 0); await run; assert.equal(reads, 1);
  assert.ok(!h.log.includes('notYet:true'));
});

test('LOW-5 iOS에서도 보이는 폰 설정 줄은 중립 문구, en 토스트 안내는 Tap', () => {
  for (const lang of ['ko', 'en']) assert.doesNotMatch(tr('phone.set.plan.sub', lang), /Pro|구독|subscription|Free|무료/i, lang);
  assert.equal(tr('plan.toast.cta', 'en'), 'Tap to see Pro');
});

test('iOS는 Pro 필요 오류에서 결제 권유를 뺀다(App Store 3.1.1) — 메신저 t가 iOS면 사실만 있는 키로 읽는다', () => {
  assert.equal(pro.iosKey('err.proRequired', true), 'err.proRequired.ios');
  assert.equal(pro.iosKey('err.proRequired', false), 'err.proRequired');
  assert.equal(pro.iosKey('room.limit', true), 'room.limit', '다른 키는 그대로');
  for (const lang of ['ko', 'en']) {
    const ios = tr('err.proRequired.ios', lang);
    assert.notEqual(ios, 'err.proRequired.ios', `사전 문구(${lang})`);
    assert.doesNotMatch(ios, /바꾸면|업그레이드|upgrade|구독|subscri|결제|purchase/i, `iOS 문구에 Pro 권유 없음(${lang})`);
    assert.match(ios, /Pro/, '사실(주인의 Pro가 필요하다)은 남긴다');
  }
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /function useT\(\) \{ const \{ lang, setLang, t: ta \} = useLang\(\); return \{ lang, setLang, ta, t: \(k, vars\) => tm\(iosKey\(k, isIos\), lang, vars\) \}; \}/, '메신저 사전 읽기 한 곳에서 가른다(friendlyErr·토스트가 이 t를 쓴다)');
});

test('L-3 uid가 바뀌어(정리 함수 실행) 라운드 중 dispose돼도 확인 중 표시·관문이 남지 않는다 — 버튼이 영구히 막히지 않고 다음 클릭 뒤 복귀 재확인이 시작된다', async () => {
  let reads = 0; const h = flowHarness(async () => { reads += 1; return 'free'; });
  h.flow.upgraded(); const run = h.flow.recheck(); await tick();
  assert.equal(h.flow.gate.running, true); assert.equal(h.log.at(-1), 'notYet:false'); assert.ok(h.log.includes('checking:true'));
  h.flow.dispose(); // 라운드 중 정리(React effect cleanup — uid 변경)
  assert.equal(h.log.filter((x) => x.startsWith('checking:')).at(-1), 'checking:false', '확인 중 표시를 되돌린다(안 하면 disabled={checking}로 영구히 막힘)');
  assert.equal(h.flow.gate.running, false, '관문 해제 — 안 하면 다음 복귀 재확인이 겹침으로 거절됨');
  await run; assert.equal(h.log.filter((x) => x.startsWith('checking:')).at(-1), 'checking:false'); assert.ok(!h.log.includes('notYet:true'));
  h.flow.upgraded(); h.advance(1000); reads = 0;
  const next = h.flow.recheck(); await tick();
  assert.equal(reads, 1, '다시 누른 뒤 복귀하면 새 라운드가 시작된다'); h.flow.dispose(); await next;
  const gone = flowHarness(async () => 'free', { gone: true }); gone.flow.dispose();
  assert.deepEqual(gone.log, [], '이미 떠난 화면에는 아무것도 그리지 않는다');
});

test('L-4 Pro를 읽으면 load(Pro 반영)가 끝난 뒤에 확인 중 표시를 끈다 — 그 사이 버튼이 풀려 free 화면에서 또 결제하지 않게', async () => {
  let release; const loading = new Promise((r) => { release = r; }); const order = [];
  const h = flowHarness(async () => 'pro');
  const flow = pro.recheckFlow({ readPlan: async () => 'pro', setTimer: h.f.setTimer, clearTimer: h.f.clearTimer, onChecking: (x) => order.push(`checking:${x}`), onNotYet: (x) => order.push(`notYet:${x}`), onPro: async () => { order.push('load:start'); await loading; order.push('load:done'); } });
  flow.upgraded(); order.length = 0;
  const run = flow.recheck(); for (let i = 0; i < 10; i += 1) await tick();
  assert.deepEqual(order, ['checking:true', 'notYet:false', 'load:start'], 'load가 끝나기 전에는 확인 중 그대로(버튼 막힘)');
  release(); await run;
  assert.deepEqual(order, ['checking:true', 'notYet:false', 'load:start', 'load:done', 'checking:false']);
  const bad = pro.recheckFlow({ readPlan: async () => 'pro', onChecking: (x) => order.push(`bad:${x}`), onPro: async () => { throw new Error('net'); } });
  bad.upgraded(); await assert.rejects(bad.recheck(), /net/); assert.equal(order.at(-1), 'bad:false', 'load가 실패해도 확인 중이 남지 않는다');
});
