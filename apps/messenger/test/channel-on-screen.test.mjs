// 폰에서 목록·설정·검색만 보고 있는데 뒤에 그려 둔 마지막 대화가 읽음 처리되던 결함(2026-09-29 점검, 2026-10-02 기능 점검 D1).
// v2 탭 이름(friends·chats·channels·agents·memory)이 옛 이름(home·dm)을 대신하며 다시 샜다 — 판정을 "대화방 화면이 열려 있을 때만 화면 안"으로 뒤집는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOnScreen } from '../src/unread-open-scroll.mjs';

test('폰: 대화방(chat)이 열려 있을 때만 화면 안 — 다섯 탭·설정·검색·알림함·기억 문서는 화면 밖', () => {
  assert.equal(channelOnScreen({ isPhone: true, page: 'chat' }), true);
  for (const page of ['friends', 'chats', 'channels', 'agents', 'memory', 'settings', 'set-profile', 'set-ext', 'orgsettings', 'search', 'inbox', 'memdoc', 'home', 'dm', 'some-new-page']) {
    assert.equal(channelOnScreen({ isPhone: true, page }), false, page);
  }
});

test('데스크톱은 그대로 — 대화가 늘 화면에 있다', () => {
  for (const page of ['chat', 'settings', 'chats', 'home']) assert.equal(channelOnScreen({ isPhone: false, page }), true);
});
