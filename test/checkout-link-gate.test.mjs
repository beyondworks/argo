// 2026-09-26 실사고(에드나 확정): 연간 링크가 월간 변형 주소(buy/8ec2b79d…?enabled=2079849)를 써서 연간 버튼에 US$12가 담겼다.
// LS 체크아웃은 buy/ 뒤 값이 변형을 정하고 enabled는 허용 목록일 뿐이다 → 서로 다른 변형(enabled)이 같은 buy 값을 쓰면 발행을 막는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutLinkProblems } from '../scripts/checkout-link-gate.mjs';

const M = 'https://argo-agent.lemonsqueezy.com/checkout/buy/8ec2b79d-6d8b-415e-bae0-4563cc07cb83?enabled=2079807';
const Y_BAD = 'https://argo-agent.lemonsqueezy.com/checkout/buy/8ec2b79d-6d8b-415e-bae0-4563cc07cb83?enabled=2079849';
const Y_OK = 'https://argo-agent.lemonsqueezy.com/checkout/buy/a68219ba-6885-4613-83b9-68045af86241?enabled=2079849';

test('월간·연간이 서로 다른 buy 값이면 통과', () => {
  assert.deepEqual(checkoutLinkProblems(`a="${M}";b="${Y_OK}"`), []);
});
test('연간이 월간 buy 값을 쓰면(실사고) 막는다', () => {
  const p = checkoutLinkProblems(`a="${M}";b="${Y_BAD}"`);
  assert.equal(p.length, 1); assert.match(p[0], /8ec2b79d/); assert.match(p[0], /2079807/); assert.match(p[0], /2079849/);
});
test('링크가 하나도 없으면 막는다(secrets 누락 = 결제 버튼 실종)', () => {
  assert.match(checkoutLinkProblems('no links here').join(' '), /없다/);
});
test('알려진 테스트 모드 변형이면 막는다', () => {
  assert.match(checkoutLinkProblems(`x="https://argo-agent.lemonsqueezy.com/checkout/buy/1c3a92a4-0000-0000-0000-000000000000?enabled=1956350"`).join(' '), /테스트/);
});
