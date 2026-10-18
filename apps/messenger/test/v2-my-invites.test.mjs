// 메신저 v2 받은 초대(v2/my-invites.mjs) — 서버 행 정리·알림함 항목·읽기 실패 처리. 셸 연결은 v2-shell 픽스처 화면으로 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { myInviteRows, inviteInboxItems, loadMyInvites, loadMyInvitesIf } from '../src/v2/my-invites.mjs';

const row = (o = {}) => ({ invite_id: 'i1', code: 'cd'.repeat(24), space_id: 's1', space_name: 'Acme 디자인', role: 'member', inviter_id: 'u2', inviter_name: '민지', created_at: '2026-10-18T01:00:00Z', expires_at: '2026-10-25T01:00:00Z', ...o });
const t = (k, v = {}) => `${k}|${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')}`;

test('서버 행 → 화면 행: 코드·공간이 없는 행은 빼고, 같은 공간 초대는 가장 최근(서버 순서 첫 행) 하나만', () => {
  const out = myInviteRows([row(), row({ invite_id: 'i0', code: 'ab'.repeat(24) }), row({ invite_id: 'i2', space_id: 's2', space_name: '' }), row({ invite_id: 'i3', code: null }), row({ invite_id: 'i4', space_id: null }), null]);
  assert.deepEqual(out.map((v) => [v.id, v.spaceId, v.code]), [['i1', 's1', 'cd'.repeat(24)], ['i2', 's2', 'cd'.repeat(24)]]);
  assert.deepEqual(out[0], { id: 'i1', code: 'cd'.repeat(24), spaceId: 's1', spaceName: 'Acme 디자인', role: 'member', inviterId: 'u2', inviterName: '민지', at: '2026-10-18T01:00:00Z', expiresAt: '2026-10-25T01:00:00Z' });
  assert.deepEqual(myInviteRows(null), []);
});

test('알림함 항목: 친구 요청과 같은 모양(kind invite·방 없음·사람 작성자), 누를 코드를 싣고, 초대한 사람 이름이 없으면 대신 말을 쓴다', () => {
  const [a, b] = inviteInboxItems(myInviteRows([row(), row({ invite_id: 'i2', space_id: 's2', space_name: '팀2', inviter_name: '' })]), t);
  assert.deepEqual(a, { kind: 'invite', key: 'invite:i1', channel_id: null, at: '2026-10-18T01:00:00Z', who: 'u2', whoKind: 'user', friendName: '민지', inviteCode: 'cd'.repeat(24), text: 'inbox.invite.text|name=민지,space=Acme 디자인' });
  assert.equal(b.text, 'inbox.invite.text|name=inbox.invite.someone|,space=팀2');
  assert.deepEqual(inviteInboxItems([], t), []);
});

test('읽기: msgr2_my_invites 한 번, 실패(오류 응답·예외)는 null — 화면은 이전 목록을 빈 목록으로 덮지 않는다', async () => {
  const calls = [];
  assert.deepEqual((await loadMyInvites(async (fn) => { calls.push(fn); return { data: [row()], error: null }; })).map((v) => v.id), ['i1']);
  assert.deepEqual(calls, ['msgr2_my_invites']);
  assert.equal(await loadMyInvites(async () => ({ data: null, error: { message: 'msgr2_device_required' } })), null);
  assert.equal(await loadMyInvites(async () => { throw new Error('net'); }), null);
  assert.deepEqual(await loadMyInvites(async () => ({ data: null, error: null })), []);
});

test('읽기 관문: 플래그 끔·로그인 전이면 기기 대기·서버 호출 0(옛 서버에 실패 요청을 만들지 않는다), 켜짐이면 기기 대기 뒤 한 번', async () => {
  const log = [];
  const rpc = async (fn) => { log.push(fn); return { data: [row()], error: null }; };
  const ready = async () => { log.push('ready'); };
  assert.equal(await loadMyInvitesIf({ enabled: false, uid: 'u1', ready, rpc }), null);
  assert.equal(await loadMyInvitesIf({ enabled: true, uid: null, ready, rpc }), null);
  assert.deepEqual(log, [], '플래그 끔·로그인 전: 호출 0');
  assert.deepEqual((await loadMyInvitesIf({ enabled: true, uid: 'u1', ready, rpc })).map((v) => v.id), ['i1']);
  assert.deepEqual(log, ['ready', 'msgr2_my_invites']);
  await assert.rejects(loadMyInvitesIf({ enabled: true, uid: 'u1', ready: async () => { throw new Error('v2_not_registered'); }, rpc }), /v2_not_registered/, '기기 등록 실패는 던진다(셸이 삼킨다) — 호출하지 않는다');
  assert.equal(log.length, 2);
});
