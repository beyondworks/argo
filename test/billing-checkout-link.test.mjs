// 유건 제보 2026-09-25: "아르고 프로 결제하려고 링크 들어갔는데 422 Unprocessable Content".
// 실측: LS 체크아웃은 checkout[email]이 빈 값·'undefined'면 422, 이메일을 빼면 200. 결제 귀속은 custom user_id(lsbilling.mjs:45).
// → 올바른 이메일일 때만 붙이고, 게스트(로컬) 신원은 결제 링크를 만들지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkoutUrl } from '../app/c/[ws]/settings/checkout-link.mjs';

const BASE = 'https://argo-agent.lemonsqueezy.com/checkout/buy/x?enabled=1';
const UID = '11111111-2222-3333-4444-555555555555';

test('정상 이메일이면 user_id·email을 붙인다(인코딩)', () => {
  const u = checkoutUrl(BASE, { id: UID, email: 'a+b@example.com' });
  assert.equal(u, `${BASE}&checkout[custom][user_id]=${UID}&checkout[email]=a%2Bb%40example.com`);
});

test('이메일이 비었거나 undefined·null·형식 불량이면 email을 빼고 user_id만 — 422 방지', () => {
  for (const email of ['', undefined, null, 'undefined', 'null', 'not-an-email', '  ']) {
    const u = checkoutUrl(BASE, { id: UID, email });
    assert.equal(u, `${BASE}&checkout[custom][user_id]=${UID}`, String(email));
    assert.doesNotMatch(u, /checkout\[email\]/);
  }
});

test('게스트(로컬)·신원 없음이면 링크를 만들지 않는다 — 결제를 귀속할 계정이 없다', () => {
  assert.equal(checkoutUrl(BASE, { id: 'local', email: '' }), null);
  assert.equal(checkoutUrl(BASE, null), null);
  assert.equal(checkoutUrl(BASE, { email: 'a@b.co' }), null);
  assert.equal(checkoutUrl('', { id: UID, email: 'a@b.co' }), null);
});

test('물음표 없는 링크는 ?로 시작', () => {
  assert.equal(checkoutUrl('https://x.test/buy', { id: UID, email: '' }), `https://x.test/buy?checkout[custom][user_id]=${UID}`);
});

test('설정 화면 업그레이드 버튼이 이 함수를 쓰고, 게스트에게는 로그인 안내를 보인다', () => {
  const src = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function UpgradeButtons('), src.indexOf('function', src.indexOf('function UpgradeButtons(') + 20));
  assert.match(fn, /checkoutUrl\(/);
  assert.doesNotMatch(fn, /checkout\[email\]=\$\{encodeURIComponent\(user\.email\)\}/, '옛 조립식 제거');
  assert.match(fn, /billing\.signInToPay/);
  const dict = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  assert.match(dict, /'billing\.signInToPay': \['[^']+', '[^']+'\]/);
});
