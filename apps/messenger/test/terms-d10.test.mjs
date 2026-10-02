// 기능 점검 D10(2026-10-02): 화면 용어가 어긋났다 — 복사 안내는 '초대 링크·코드로 참여'인데 메뉴는 '초대 코드로 참여',
// 숨김 메뉴는 '크루', 확인 창은 '에이전트', 안내는 v2에 없는 '숨긴 크루 목록'. v2 용어는 '에이전트'로 통일한다.
import test from 'node:test';
import assert from 'node:assert/strict';
const { DICT } = await import(process.env.I18N_PATH ?? '../src/i18n.js');

test("화면 문구에 '크루'·'crew'가 없다 — v2 용어는 에이전트", () => {
  const bad = Object.entries(DICT).filter(([, [ko, en]]) => /크루/.test(ko) || /\bcrews?\b/i.test(en.replace(/\{\w+\}/g, ''))).map(([k]) => k);
  assert.deepEqual(bad, []);
});

test('초대 참여 이름은 메뉴와 같고, 숨김 안내는 실제 설정 경로, 방 사람 버튼은 초대하기', () => {
  assert.equal(DICT['phone.org.join'][0], '초대 코드로 참여');
  assert.match(DICT['inv.pasteHint'][0], /'초대 코드로 참여'/);
  assert.match(DICT['org.step.invite.sub'][0], /'초대 코드로 참여'/);
  assert.equal(DICT['crew.mute'][0], '에이전트 숨기기');
  assert.match(DICT['crew.muted'][0], /설정 > 친구 관리 > 숨김/);
  assert.equal(DICT['msg.mutedCrew'][0], '숨긴 에이전트의 메시지입니다.');
  assert.doesNotMatch(DICT['profile.quiet.desc'][0], /알림함 배지/);
  assert.deepEqual(DICT['ch.add'], ['초대하기', 'Invite']);
});
