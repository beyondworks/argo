// 초대 서버 호출(invite-flow.mjs) — 새 서버 모양과 옛 서버 폴백을 가짜 supabase로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { discardInvite, inviteRow, createInvite, previewInvite, acceptInvite, revokeInvite, inviteStatus, daysLeft, inviteErrorKey, missingFn, invitePerms, channelPick, settingsSummary } from '../src/invite-flow.mjs';

const MISSING_FN = { code: 'PGRST202', message: 'Could not find the function public.msgr_accept_invite_v2(code) in the schema cache' };
const MISSING_COL = { code: 'PGRST204', message: "Could not find the 'channel_ids' column of 'msgr_invites' in the schema cache" };
function fakeSb({ rpc = {}, insert, row } = {}) {
  const log = [];
  return { log,
    rpc: async (name, args) => { log.push(['rpc', name, args]); const r = rpc[name]; return typeof r === 'function' ? r(args) : r ?? { data: null, error: MISSING_FN }; },
    from: (table) => ({ select: (cols) => ({ eq: () => ({ maybeSingle: async () => { log.push(['select', table, cols]); return typeof row === 'function' ? row(cols) : row; } }) }),
      insert: (row) => ({ select: () => ({ single: async () => { log.push(['insert', table, row]); return insert(row); } }) }),
      delete: () => { const eqs = []; const q = { eq: (k, v) => { eqs.push([k, v]); return q; }, select: async () => { log.push(['delete', table, eqs[0][1], ...eqs.slice(1).flat()]); return { data: [{ id: eqs[0][1] }], error: null }; } }; return q; } }) };
}
const NOW = Date.parse('2026-09-18T00:00:00Z');

test('만들 행 — 멤버는 사용 제한 없음을 null로 명시, 만료 없음도 null, 게스트는 1회·채널 하나·이용 기간', () => {
  assert.deepEqual(inviteRow({ orgId: 'o', uid: 'u', role: 'member', channelIds: ['a', 'b'], expiryDays: 7, maxUses: null }, NOW),
    { org_id: 'o', role: 'member', created_by: 'u', channel_ids: ['a', 'b'], max_uses: null, expires_at: '2026-09-25T00:00:00.000Z' });
  assert.equal(inviteRow({ orgId: 'o', uid: 'u', role: 'member', expiryDays: null }, NOW).expires_at, null);
  assert.deepEqual(inviteRow({ orgId: 'o', uid: 'u', role: 'guest', channelIds: ['p', 'q'], maxUses: null, guestDays: 30 }, NOW),
    { org_id: 'o', role: 'guest', created_by: 'u', channel_ids: ['p'], max_uses: 1, expires_at: '2026-09-25T00:00:00.000Z', guest_days: 30 });
});

test('만들기 — 새 서버는 새 행 그대로, 옛 서버(열 없음)는 옛 모양으로 한 번 더(게스트는 channel_id 단수)', async () => {
  const neo = fakeSb({ insert: () => ({ data: { id: 'i1', code: 'NEW' }, error: null }) });
  assert.deepEqual(await createInvite(neo, { orgId: 'o', uid: 'u', role: 'member', channelIds: ['a'] }, NOW), { id: 'i1', code: 'NEW', legacy: false });
  assert.equal(neo.log.length, 1);
  let n = 0; const old = fakeSb({ insert: (row) => (n++ === 0 ? { data: null, error: MISSING_COL } : { data: { id: 'i2', code: 'OLD' }, error: null }) });
  assert.deepEqual(await createInvite(old, { orgId: 'o', uid: 'u', role: 'guest', channelIds: ['p'], guestDays: 7 }, NOW), { id: 'i2', code: 'OLD', legacy: true });
  assert.deepEqual(old.log[1][2], { org_id: 'o', role: 'guest', created_by: 'u', channel_id: 'p', guest_days: 7 });
  const denied = fakeSb({ insert: () => ({ data: null, error: { code: 'P0001', message: 'msgr_invite_channel_forbidden' } }) });
  await assert.rejects(createInvite(denied, { orgId: 'o', uid: 'u', role: 'member', channelIds: ['x'] }), /msgr_invite_channel_forbidden/);
  assert.equal(denied.log.length, 1, '권한 거절은 옛 모양으로 재시도하지 않는다');
});

test('미리보기 — 서버에 없으면 null(옛 즉시 수락으로), 틀린 코드는 예외', async () => {
  assert.equal(await previewInvite(fakeSb(), 'c'), null);
  const sb = fakeSb({ rpc: { msgr_invite_preview: { data: { state: 'valid', org_name: 'Lean' }, error: null } } });
  assert.deepEqual(await previewInvite(sb, 'c'), { state: 'valid', org_name: 'Lean' });
  const bad = fakeSb({ rpc: { msgr_invite_preview: { data: null, error: { code: 'P0001', message: 'msgr_invite_not_found' } } } });
  await assert.rejects(previewInvite(bad, 'c'), /msgr_invite_not_found/);
});

test('수락 — v2면 조직·첫 채널·건너뜀, v2가 없으면 v1(조직 id만), 만료 등은 그대로 예외', async () => {
  const v2 = fakeSb({ rpc: { msgr_accept_invite_v2: { data: { org_id: 'o', channel_id: 'c1', joined_channel_ids: ['c1'], skipped_channel_ids: ['c2'] }, error: null } } });
  assert.deepEqual(await acceptInvite(v2, 'k'), { orgId: 'o', channelId: 'c1', joined: ['c1'], skipped: ['c2'], legacy: false });
  const v1 = fakeSb({ rpc: { msgr_accept_invite: { data: 'o', error: null } } });
  assert.deepEqual(await acceptInvite(v1, 'k'), { orgId: 'o', channelId: null, joined: [], skipped: [], legacy: true });
  assert.deepEqual(v1.log.map((x) => x[1]), ['msgr_accept_invite_v2', 'msgr_accept_invite']);
  const exp = fakeSb({ rpc: { msgr_accept_invite_v2: { data: null, error: { code: 'P0001', message: 'msgr_invite_expired' } } } });
  await assert.rejects(acceptInvite(exp, 'k'), /msgr_invite_expired/);
  assert.equal(exp.log.length, 1, '만료는 v1로 다시 수락하지 않는다');
});

test('취소 — RPC가 있으면 소프트 취소, 없으면 옛 delete', async () => {
  assert.deepEqual(await revokeInvite(fakeSb({ rpc: { msgr_invite_revoke: { data: null, error: null } } }), 'i'), { legacy: false });
  const old = fakeSb();
  assert.deepEqual(await revokeInvite(old, 'i'), { legacy: true });
  assert.deepEqual(old.log.at(-1), ['delete', 'msgr_invites', 'i']);
});

test('목록 상태·남은 날 — 취소 > 만료 > 소진 > 유효, 옛 1회용은 수락되면 소진', () => {
  const later = new Date(NOW + 5 * 86_400_000 - 1000).toISOString();
  assert.equal(inviteStatus({ revoked_at: 'x', expires_at: later }, NOW), 'revoked');
  assert.equal(inviteStatus({ expires_at: new Date(NOW - 1).toISOString() }, NOW), 'expired');
  assert.equal(inviteStatus({ expires_at: later, max_uses: 10, use_count: 10 }, NOW), 'exhausted');
  assert.equal(inviteStatus({ expires_at: later, max_uses: null, use_count: 99 }, NOW), 'live');
  assert.equal(inviteStatus({ expires_at: later, accepted_at: 'y' }, NOW), 'exhausted', '옛 서버 행(max_uses 열 없음)');
  assert.equal(inviteStatus({ expires_at: null, max_uses: null }, NOW), 'live');
  assert.equal(daysLeft({ expires_at: later }, NOW), 5); assert.equal(daysLeft({ expires_at: null }, NOW), null);
});

test('오류 문구 키 · 누락 판정', () => {
  assert.equal(inviteErrorKey('msgr_invite_exhausted'), 'inv.err.exhausted');
  assert.equal(inviteErrorKey('msgr_invite_invalid'), 'inv.err.notFound', 'v1 옛 오류도 코드 오류로');
  assert.equal(inviteErrorKey('something else'), null);
  assert.ok(missingFn(MISSING_FN) && missingFn(MISSING_COL) && missingFn({ code: '42883' }));
  assert.ok(!missingFn({ code: 'P0001', message: 'msgr_invite_expired' }));
});

test('초대 창 권한(총괄 확정) — 관리자 = 멤버·게스트·아무 채널, 관리자 아닌 방장 = 자기 비공개 채널 게스트만, 멤버 = 없음', () => {
  const pub = { id: 'p', kind: 'public' }, mine = { id: 'm', kind: 'private' }, other = { id: 'o', kind: 'private' }, dm = { id: 'd', kind: 'dm' };
  const admin = { isAdmin: true, hostOf: new Set() }, host = { isAdmin: false, hostOf: new Set(['m']) }, member = { isAdmin: false, hostOf: new Set() };
  assert.deepEqual(invitePerms(admin), { member: true, guest: true, anyChannel: true });
  assert.deepEqual(invitePerms(host), { member: false, guest: true, anyChannel: false });
  assert.deepEqual(invitePerms(member), { member: false, guest: false, anyChannel: false });
  assert.ok(channelPick(other, admin, 'member').ok && channelPick(pub, admin, 'member').ok, '관리자는 비공개도 방장 취급');
  assert.equal(channelPick(dm, admin, 'member').ok, false);
  assert.deepEqual(channelPick(pub, host, 'guest'), { ok: false, why: 'guestPrivate' }, '게스트는 공개 채널 불가(서버 RLS)');
  assert.deepEqual(channelPick(other, host, 'guest'), { ok: false, why: 'host' }, '방장 아닌 비공개 = msgr_invite_channel_forbidden');
  assert.ok(channelPick(mine, host, 'guest').ok);
  assert.deepEqual(channelPick(other, member, 'member'), { ok: false, why: 'host' });
});

test('설정 요약 — 링크 만료와 게스트 이용 기간을 따로, 게스트는 늘 1회', () => {
  const t = (k, v) => (v ? `${k}(${Object.values(v).join(',')})` : k);
  assert.equal(settingsSummary({ role: 'member', expiryDays: 7, maxUses: null, guestDays: 30 }, t), 'inv.expiry.sum(7) · inv.uses.unlimited · inv.role.member');
  assert.equal(settingsSummary({ role: 'guest', expiryDays: null, maxUses: null, guestDays: 90 }, t), 'inv.expiry.never · inv.uses.sum(1) · inv.role.guest · inv.guest.daysSum(90)');
});

test('창이 버린 링크 정리 — 안 쓰였으면 삭제(새 서버는 use_count = 0 조건), 쓰였거나(use_count·옛 accepted_at) 못 읽으면 둔다', async () => {
  const revoked = (sb) => sb.log.some((x) => x[1] === 'msgr_invite_revoke' || x[0] === 'delete');
  const fresh = fakeSb({ row: { data: { id: 'i', use_count: 0, accepted_at: null }, error: null } });
  assert.equal(await discardInvite(fresh, 'i'), true);
  assert.deepEqual(fresh.log.at(-1), ['delete', 'msgr_invites', 'i', 'use_count', 0], '소프트 취소가 아니라 삭제, 안 쓰였을 때만');
  const used = fakeSb({ row: { data: { id: 'i', use_count: 1, accepted_at: 'x' }, error: null } });
  assert.equal(await discardInvite(used, 'i'), false); assert.ok(!revoked(used));
  const old = fakeSb({ row: (cols) => cols.includes('use_count') ? { data: null, error: { code: '42703', message: 'column use_count does not exist' } } : { data: { id: 'i', accepted_at: null }, error: null } });
  assert.equal(await discardInvite(old, 'i'), true, '옛 서버: use_count 없이 accepted_at으로 판정, 취소는 delete로');
  assert.deepEqual(old.log.at(-1), ['delete', 'msgr_invites', 'i']);
  assert.equal(await discardInvite(fakeSb({ row: { data: null, error: { code: '42501', message: 'denied' } } }), 'i'), false);
  assert.equal(await discardInvite(fakeSb(), null), false);
});
