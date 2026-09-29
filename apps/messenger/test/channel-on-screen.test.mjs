// 폰 채팅 탭 목록 뒤에 숨은 대화가 읽음 처리되던 결함(2026-09-29 점검) — 목록만 봐도 마지막 대화가 display:none으로 그려진 채 커서를 올렸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOnScreen } from '../src/unread-open-scroll.mjs';

test('폰 홈·채팅 목록 탭에서는 대화가 화면에 없다', () => {
  assert.equal(channelOnScreen({ isPhone: true, page: 'home' }), false);
  assert.equal(channelOnScreen({ isPhone: true, page: 'dm' }), false);
});

test('폰 대화방, 데스크톱은 어느 페이지 값이든 대화가 화면에 있다', () => {
  assert.equal(channelOnScreen({ isPhone: true, page: 'chat' }), true);
  for (const page of ['home', 'dm', 'chat']) assert.equal(channelOnScreen({ isPhone: false, page }), true);
});
