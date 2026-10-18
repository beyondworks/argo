// 메신저 v2 초대함(v2/invite-box.mjs) — 남은 기간 문구·거절 결과·목록에서 빼기.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteLeft, declineInvite, withoutInvite, liveInvites } from '../src/v2/invite-box.mjs';

const now = Date.parse('2026-10-18T03:00:00Z');
const plus = (ms) => new Date(now + ms).toISOString();

test('남은 기간: 기한 없음·만료·1시간 안·시간(올림)·날(올림)', () => {
  assert.deepEqual(inviteLeft(null, now), { key: 'inv.box.left.never', n: null });
  assert.deepEqual(inviteLeft('', now), { key: 'inv.box.left.never', n: null });
  assert.deepEqual(inviteLeft('nope', now), { key: 'inv.box.left.never', n: null });
  assert.deepEqual(inviteLeft(plus(0), now), { key: 'inv.box.left.expired', n: null });
  assert.deepEqual(inviteLeft(plus(-5_000), now), { key: 'inv.box.left.expired', n: null });
  assert.deepEqual(inviteLeft(plus(59 * 60_000), now), { key: 'inv.box.left.soon', n: null });
  assert.deepEqual(inviteLeft(plus(60 * 60_000), now), { key: 'inv.box.left.hours', n: 1 });
  assert.deepEqual(inviteLeft(plus(90 * 60_000), now), { key: 'inv.box.left.hours', n: 2 });
  assert.deepEqual(inviteLeft(plus(24 * 3_600_000), now), { key: 'inv.box.left.days', n: 1 });
  assert.deepEqual(inviteLeft(plus(6 * 24 * 3_600_000 + 1), now), { key: 'inv.box.left.days', n: 7 });
});

test('거절: msgr2_invite_decline(p_code) 한 번, true면 declined, false면 gone(이미 정해짐), 오류는 메시지로 던진다', async () => {
  const calls = [];
  const rpc = (data, error = null) => async (fn, args) => { calls.push([fn, args]); return { data, error }; };
  assert.equal(await declineInvite(rpc(true), 'c1'), 'declined');
  assert.deepEqual(calls, [['msgr2_invite_decline', { p_code: 'c1' }]]);
  assert.equal(await declineInvite(rpc(false), 'c1'), 'gone');
  await assert.rejects(declineInvite(rpc(null, { message: 'msgr2_app_required' }), 'c1'), /msgr2_app_required/);
  await assert.rejects(declineInvite(rpc(null, {}), 'c1'), /msgr2_invite_decline_failed/);
});

test('목록에서 빼기: 그 코드만 뺀다, 빈 목록·null도 된다', () => {
  assert.deepEqual(withoutInvite([{ code: 'a' }, { code: 'b' }], 'a'), [{ code: 'b' }]);
  assert.deepEqual(withoutInvite(null, 'a'), []);
});

test('받을 수 있는 초대만: 만료 시각이 지난 것은 빼고, 기한 없음·남은 것은 둔다', () => {
  const list = [{ code: 'a', expiresAt: plus(-1) }, { code: 'b', expiresAt: plus(60_000) }, { code: 'c', expiresAt: null }];
  assert.deepEqual(liveInvites(list, now).map((v) => v.code), ['b', 'c']);
  assert.deepEqual(liveInvites(null, now), []);
});
