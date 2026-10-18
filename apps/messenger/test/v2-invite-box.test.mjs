// 메신저 v2 초대함(v2/invite-box.mjs) — 남은 기간 문구·거절 결과·목록에서 빼기.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteLeft, declineInvite, withoutInvite, liveInvites, createDecliner, afterDecline } from '../src/v2/invite-box.mjs';

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

test('거절 실행기: 같은 초대를 거절하는 중이면 두 번째는 busy(RPC 한 번), 끝나면 다시 부를 수 있다, 다른 초대는 막지 않는다, 오류는 error로', async () => {
  let calls = 0; let release; const gate = new Promise((r) => { release = r; });
  const d = createDecliner(async (fn, a) => { calls++; if (a.p_code === 'slow') await gate; if (a.p_code === 'bad') return { data: null, error: { message: 'msgr2_app_device_required' } }; return { data: true, error: null }; });
  const first = d.decline('slow');
  assert.equal(d.busy('slow'), true);
  const within = (p, ms = 1000) => Promise.race([p, new Promise((r) => setTimeout(() => r({ kind: 'timeout' }), ms))]); // 막지 않으면 두 번째가 문을 기다려 멈춘다 — 상한으로 실패시킨다
  assert.deepEqual(await within(d.decline('slow')), { kind: 'busy' });
  assert.deepEqual(await d.decline('other'), { kind: 'declined' }, '다른 초대는 막지 않는다');
  release(); assert.deepEqual(await first, { kind: 'declined' });
  assert.equal(calls, 2, 'slow 한 번 + other 한 번');
  assert.equal(d.busy('slow'), false);
  const bad = await d.decline('bad');
  assert.equal(bad.kind, 'error'); assert.match(bad.error.message, /msgr2_app_device_required/);
  assert.equal(d.busy('bad'), false, '실패해도 다시 누를 수 있다');
});

test('거절 뒤 목록: 거절함·이미 정해짐만 그 줄을 빼고, 실패·진행 중이면 그대로 둔다', () => {
  const list = [{ code: 'a' }, { code: 'b' }];
  assert.deepEqual(afterDecline(list, 'a', { kind: 'declined' }), [{ code: 'b' }]);
  assert.deepEqual(afterDecline(list, 'a', { kind: 'gone' }), [{ code: 'b' }]);
  assert.deepEqual(afterDecline(list, 'a', { kind: 'error', error: new Error('x') }), list);
  assert.deepEqual(afterDecline(list, 'a', { kind: 'busy' }), list);
  assert.deepEqual(afterDecline(null, 'a', { kind: 'error' }), []);
});
