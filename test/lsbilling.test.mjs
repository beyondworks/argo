// 레몬스퀴지 결제 환산 회귀 — 돈이 걸린 경계라 셋을 잠근다:
//  ① 서명 검증(위조·시크릿 부재 fail-closed) ② 상태→plan 매핑(유예·해지예약 포함) ③ 순서 역전 방어
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyLsSignature, mapSubscriptionEvent, isStaleEvent, PRO_STATUSES, FREE_STATUSES } from '../src/lsbilling.mjs';

const SECRET = 'test-signing-secret';
const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');

test('서명: 올바른 HMAC은 통과, 위조·타 시크릿·빈 헤더는 거부', () => {
  const body = '{"a":1}';
  assert.equal(verifyLsSignature(body, sign(body), SECRET), true);
  assert.equal(verifyLsSignature(body, sign(body).toUpperCase(), SECRET), true); // 대소문자 hex 허용
  assert.equal(verifyLsSignature(body, sign(body, 'wrong'), SECRET), false);
  assert.equal(verifyLsSignature(body + ' ', sign(body), SECRET), false); // 본문 1바이트 변조
  assert.equal(verifyLsSignature(body, '', SECRET), false);
  assert.equal(verifyLsSignature(body, sign(body), ''), false); // 시크릿 미설정 = fail-closed
});

const UID = '11111111-2222-3333-4444-555555555555';
const evt = (status, extra = {}) => ({
  meta: { event_name: 'subscription_updated', custom_data: { user_id: UID } },
  data: { id: 'sub_1', attributes: { status, customer_id: 77, updated_at: '2026-07-28T01:00:00Z', ends_at: null, urls: { customer_portal: 'https://ls.example/portal' }, ...extra } },
});

test('매핑: 정상·유예·해지예약은 pro — 결제 실수·해지 예약으로 업무를 끊지 않는다', () => {
  for (const s of ['on_trial', 'active', 'past_due', 'cancelled']) {
    const m = mapSubscriptionEvent('subscription_updated', evt(s));
    assert.equal(m.plan, 'pro', s);
    assert.equal(m.userId, UID);
  }
});

test('매핑: 만료·미납·정지는 free — 클라우드 동결(데이터 삭제 아님)', () => {
  for (const s of ['expired', 'unpaid', 'paused']) {
    assert.equal(mapSubscriptionEvent('subscription_updated', evt(s)).plan, 'free', s);
  }
});

test('매핑: PRO/FREE 집합이 서로 배타 — 같은 상태가 양쪽에 들어가는 실수 차단', () => {
  for (const s of PRO_STATUSES) assert.equal(FREE_STATUSES.has(s), false, s);
});

test('매핑: 모르는 상태는 조용히 오판하지 않고 error로 드러난다', () => {
  const m = mapSubscriptionEvent('subscription_updated', evt('brand_new_status'));
  assert.match(m.error, /unknown-status/);
});

test('매핑: user_id 누락·비UUID는 error(유령 결제 로그 대상), 관련 없는 이벤트는 null', () => {
  const noUser = evt('active'); delete noUser.meta.custom_data;
  assert.equal(mapSubscriptionEvent('subscription_updated', noUser).error, 'no-user');
  const badUser = evt('active'); badUser.meta.custom_data.user_id = 'DROP TABLE';
  assert.equal(mapSubscriptionEvent('subscription_updated', badUser).error, 'no-user');
  assert.equal(mapSubscriptionEvent('order_created', evt('active')), null);
  assert.equal(mapSubscriptionEvent('subscription_payment_failed', evt('active')), null); // 인보이스류 스킵
});

test('순서 역전: 과거 이벤트는 스킵, 최신·비교불가는 진행', () => {
  assert.equal(isStaleEvent('2026-07-28T00:00:00Z', '2026-07-28T01:00:00Z'), true);
  assert.equal(isStaleEvent('2026-07-28T02:00:00Z', '2026-07-28T01:00:00Z'), false);
  assert.equal(isStaleEvent(null, '2026-07-28T01:00:00Z'), false);
  assert.equal(isStaleEvent('2026-07-28T02:00:00Z', null), false);
});

test('포털·구독 메타가 환산 결과에 실린다(설정 카드 구독 관리 링크의 원천)', () => {
  const m = mapSubscriptionEvent('subscription_updated', evt('active'));
  assert.equal(m.portal_url, 'https://ls.example/portal');
  assert.equal(m.ls_subscription_id, 'sub_1');
  assert.equal(m.ls_customer_id, '77');
  assert.equal(m.ls_status, 'active');
});
