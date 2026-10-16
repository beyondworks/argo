// 설정 '메신저 받기' 단추 — 메신저 중단 스위치가 켜져 있으면 '출시 알림 받기' + 랜딩 신청란(#waitlist), 꺼짐·모름이면 지금 그대로(0.1.113, 검수 2의 #1053 지적).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { msgrGetLink, MESSENGER_PAGE, MESSENGER_WAITLIST } from '../app/c/[ws]/settings/msgr-card.mjs';

test('스위치 켜짐 → 출시 알림 받기 + https://argo.ceo/messenger#waitlist', () => {
  assert.deepEqual(msgrGetLink(true), { href: 'https://argo.ceo/messenger#waitlist', labelKey: 'settings.msgr.getWaitlist' });
  assert.equal(MESSENGER_WAITLIST, 'https://argo.ceo/messenger#waitlist');
});

test('스위치 꺼짐·모름(로드 전·옛 서버·오류) → 지금 단추 그대로', () => {
  for (const v of [false, undefined, null, 'true', 1]) assert.deepEqual(msgrGetLink(v), { href: MESSENGER_PAGE, labelKey: 'settings.msgr.get' }, String(v));
  assert.equal(MESSENGER_PAGE, 'https://argo.ceo/messenger');
});

test('사전·화면 — 두 문구 ko·en, 설정 화면은 단추를 msgrGetLink로만 그린다', async () => {
  const dict = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  assert.match(dict, /'settings\.msgr\.get': \['메신저 받기', 'Get the messenger'\],/);
  assert.match(dict, /'settings\.msgr\.getWaitlist': \['메신저 출시 알림 받기', 'Get notified when Messenger returns'\],/);
  const page = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /href=\{getLink\.href\}/);
  assert.match(page, /t\(getLink\.labelKey\)/);
  assert.doesNotMatch(page, /href=\{MESSENGER_PAGE\}/, '상수를 직접 쓰는 옛 단추가 남지 않는다');
});
