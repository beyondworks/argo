// 멈춘 에이전트가 든 방의 안내·보내기 막기(2026-10-15 — 운영 실측: 답 없는 개인 1:1 5건이 모두 멈춘 에이전트, 답도 안내도 없었다).
// 잠그는 것(경우 표 artifacts/paused-dm/case-table.md): 막기는 나와 멈춘 에이전트뿐인 1:1만, 이유는 내 에이전트일 때만, 행동은 app/off=실행기(limit의 바꾸기는 다음 발행), iOS 문구, 연결된 에이전트는 무시.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pausedRoomNotice } from '../src/agent-pause.mjs';
import { t as tm } from '../src/i18n.js';

const ME = 'u-me';
const p1 = { id: 'c1', owner_user_id: ME, display_name: '서윤', status: 'paused' };
const p2 = { id: 'c2', owner_user_id: ME, display_name: '민준', status: 'paused' };
const other = { id: 'c9', owner_user_id: 'u-friend', display_name: '친구봇', status: 'paused' };
const live = { id: 'c3', owner_user_id: ME, display_name: '하린', status: 'active' };
const dm = { id: 'ch1', kind: 'dm' };
const pause = (reason) => ({ paused: 6, active: 4, limit: 4, reason });
const base = { channel: dm, roomCrewIds: ['c1'], connected: [live], paused: [p1, p2, other], people: 1, uid: ME };

test('C1 무료 한도: 1:1 막기 + limit 문구(바꾸기 단추는 다음 발행)', () => {
  const n = pausedRoomNotice({ ...base, pause: pause('limit') });
  assert.equal(n.block, true);
  assert.deepEqual(n.head, { key: 'agents.paused.room', vars: { name: '서윤' } });
  assert.deepEqual(n.reason, { key: 'agents.pause.limit', vars: { n: 6, limit: 4 } });
  assert.equal(n.action, null);
  assert.deepEqual(n.crews.map((c) => c.id), ['c1']);
});

test('C2 iOS는 결제 권유 없는 문구', () => {
  assert.equal(pausedRoomNotice({ ...base, pause: pause('limit'), ios: true }).reason.key, 'agents.pause.limit.ios');
});

test('C3·C4 옛 실행기·실행기 꺼짐: 그 문구 + 실행기 버튼, 바꾸기 없음', () => {
  for (const r of ['app', 'off']) {
    const n = pausedRoomNotice({ ...base, pause: pause(r) });
    assert.equal(n.reason.key, `agents.pause.${r}`); assert.equal(n.action, 'runner'); assert.equal(n.block, true);
  }
});

test('C5 멈춘 에이전트가 없으면(Pro·연결됨) 안내 없음', () => {
  assert.equal(pausedRoomNotice({ ...base, roomCrewIds: ['c3'], pause: pause('limit') }), null);
  assert.equal(pausedRoomNotice({ ...base, roomCrewIds: [], pause: null }), null);
  assert.equal(pausedRoomNotice({ ...base, paused: [], pause: null }), null); // 멈춘 행을 모르면(이름 읽기 전) 종전과 같다
  assert.equal(pausedRoomNotice({ ...base, channel: null }), null);
});

test('C6 이유를 모르면(옛 서버·읽기 실패) 머리 줄만 + 그래도 1:1은 막는다', () => {
  const n = pausedRoomNotice({ ...base, pause: null });
  assert.equal(n.reason, null); assert.equal(n.action, null); assert.equal(n.block, true);
});

test('C11 사람이 더 있으면 막지 않는다(1:1·채널 모두)', () => {
  assert.equal(pausedRoomNotice({ ...base, people: 2, pause: pause('limit') }).block, false);
  const ch = pausedRoomNotice({ ...base, channel: { id: 'g', kind: 'public' }, people: 5, pause: pause('limit') });
  assert.equal(ch.block, false);
  assert.equal(pausedRoomNotice({ ...base, channel: { id: 'g', kind: 'private' }, people: 1, pause: pause('limit') }).block, false); // 1:1이 아니면 혼자여도 막지 않는다
});

test('C13 남의 멈춘 에이전트: 막지 않고 머리 줄만, 이유·버튼 없음', () => {
  const n = pausedRoomNotice({ ...base, roomCrewIds: ['c9'], pause: pause('limit') });
  assert.equal(n.reason, null); assert.equal(n.action, null); assert.equal(n.head.vars.name, '친구봇');
  assert.equal(n.block, false); assert.equal(n.solo, true); // 막지 않는다 — 다시 켜져도 crew_sync는 주인에게만 간다(검수 #1032)
});

test('C14 연결된 에이전트와 함께 있는 방: 멈춘 것만 이름, 막지 않음', () => {
  const n = pausedRoomNotice({ ...base, channel: { id: 'g', kind: 'public' }, roomCrewIds: ['c3', 'c1', 'c2', 'c1'], people: 3, pause: pause('off') });
  assert.equal(n.block, false); assert.deepEqual(n.head, { key: 'agents.paused.room.many', vars: { name: '서윤, 민준' } });
  assert.equal(pausedRoomNotice({ ...base, roomCrewIds: ['c3', 'c1'], people: 1, pause: null }).block, false); // 에이전트 둘인 1:1(연결 1 + 멈춤 1)은 답할 에이전트가 있다
});

test('문구: ko·en 모두 있고 이름이 들어간다', () => {
  for (const lang of ['ko', 'en']) for (const k of ['agents.paused.room', 'agents.paused.room.many']) {
    const s = tm(k, lang, { name: '서윤' }); assert.ok(s && s !== k, `${lang} ${k}`);
    assert.match(s, /서윤/);
  }
});
