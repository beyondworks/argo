// 점검 A·B #6 — 목록이 비었을 때 맞는 말을 한다.
//  - 채팅 탭의 필터(그룹·안읽음·즐겨찾기) 결과가 비면 "아직 채팅이 없습니다"가 아니라 그 필터에 맞는 문구
//  - 대화방의 멘션·결재·에이전트 탭이 비면 아무 안내 없이 하얗게 두지 않는다
import test from 'node:test';
import assert from 'node:assert/strict';
import { dmEmptyKey, roomTabEmptyKey } from '../src/empty-state.mjs';
import { t } from '../src/i18n.js';

test('채팅 탭: 대화가 하나도 없을 때만 "아직 채팅이 없습니다"', () => {
  assert.equal(dmEmptyKey({ filter: 'all', total: 0 }), 'phone.dm.empty');
  assert.equal(dmEmptyKey({ filter: 'group', total: 0 }), 'phone.dm.empty', '대화 자체가 없으면 어느 필터든 같은 안내');
});

test('채팅 탭: 대화가 있는데 필터 결과가 비면 그 필터의 문구', () => {
  assert.equal(dmEmptyKey({ filter: 'group', total: 3 }), 'phone.dm.empty.group');
  assert.equal(dmEmptyKey({ filter: 'unread', total: 3 }), 'phone.dm.empty.unread');
  assert.equal(dmEmptyKey({ filter: 'fav', total: 3 }), 'phone.dm.empty.fav');
  assert.equal(dmEmptyKey({ filter: 'all', total: 3 }), null, '전체 필터에서 대화가 전부 고정돼 있으면(고정 구역이 보인다) "아직 채팅이 없습니다"를 하지 않는다');
});

test('방 탭: 글은 있는데 이 탭에 해당하는 글이 없으면 탭별 문구, 전체 탭은 문구 없음(원래 방 안내가 있다)', () => {
  assert.equal(roomTabEmptyKey({ tab: 'mention', total: 5, shown: 0 }), 'tab.empty.mention');
  assert.equal(roomTabEmptyKey({ tab: 'approval', total: 5, shown: 0 }), 'tab.empty.approval');
  assert.equal(roomTabEmptyKey({ tab: 'crew', total: 5, shown: 0 }), 'tab.empty.crew');
  assert.equal(roomTabEmptyKey({ tab: 'all', total: 5, shown: 0 }), null);
  assert.equal(roomTabEmptyKey({ tab: 'mention', total: 5, shown: 2 }), null, '보일 글이 있으면 안내 없음');
  assert.equal(roomTabEmptyKey({ tab: 'mention', total: 0, shown: 0 }), null, '방 자체가 비었으면 기존 방 안내');
});

test('새 문구는 한국어·영어 모두 있고 서로 달라 보인다', () => {
  for (const k of ['phone.dm.empty.group', 'phone.dm.empty.unread', 'phone.dm.empty.fav', 'tab.empty.mention', 'tab.empty.approval', 'tab.empty.crew']) {
    for (const lang of ['ko', 'en']) assert.notEqual(t(k, lang), k, `${k} ${lang}`);
    assert.match(t(k, 'ko'), /[가-힣]/); assert.doesNotMatch(t(k, 'ko'), /[A-Za-z]{4,}/);
  }
});
