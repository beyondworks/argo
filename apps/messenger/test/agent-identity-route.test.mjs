// 에이전트 = 한 사람(유건 2026-10-05) 분리 검수 반영 — 옛 조직 1:1 행동 테스트(순수 함수·가짜 조회).
//  #1 옛 조직 1:1에 안 읽은 글이 있거나 글을 가리키는 입구(알림함·OS 알림·푸시·전경 카드·미리보기)면 옛 방을 연다(agentDmRoute).
//  #2 내 에이전트 개인 1:1 위 '이전 대화 보기' — 그 에이전트의 옛 조직 1:1과 글 수(earlierAgentDms·earlierLines).
// 실제 App openAgentDmInstead 동작(#1·#5)은 agent-identity-app.test.mjs. 새 함수는 이름공간으로 가져온다 — 고치기 전 코드에서는 함수가 없어 각 테스트가 따로 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/agent-groups.mjs';

const ME = 'u-me'; const OTHER = 'u-other';
const LEAN = 'org-lean'; const DESIGN = 'org-design';
const row = (id, extra = {}) => ({ id, owner_user_id: ME, ws_id: 'ws-a', slug: 'pepper', status: 'active', org_id: null, face: null, avatar_url: null, created_at: '2026-09-10T00:00:00+00:00', ...extra });

// ── #1 입구별 판단 ──
test('#1 agentDmRoute: 목록 줄은 안 읽은 글이 없을 때만 개인 1:1, 안 읽은 글이 있으면 옛 방', () => {
  const channel = { id: 'c1', kind: 'dm', org_id: LEAN };
  assert.equal(G.agentDmRoute({ channel, unread: {}, from: 'list' }), 'personal');
  assert.equal(G.agentDmRoute({ channel, unread: { c1: { n: 0, mention: 0 } }, from: 'list' }), 'personal');
  assert.equal(G.agentDmRoute({ channel, unread: { c1: { n: 2, mention: 0 } }, from: 'list' }), 'legacy', '옛 방의 안 읽은 글을 볼 길이 없었다');
  assert.equal(G.agentDmRoute({ channel, unread: { other: { n: 5 } }, from: 'list' }), 'personal', '다른 방의 안 읽은 글은 상관없다');
});

test('#1 agentDmRoute: 그 방의 글을 가리키는 입구(알림함·OS 알림·푸시·전경 카드·미리보기)는 안 읽은 글이 없어도 옛 방', () => {
  const channel = { id: 'c1', kind: 'dm', org_id: LEAN };
  for (const from of ['inbox', 'push', 'mac', 'card', 'peek']) assert.equal(G.agentDmRoute({ channel, unread: {}, from }), 'legacy', from);
  assert.equal(G.agentDmRoute({ channel, unread: {}, from: undefined }), 'legacy', '모르는 입구는 글을 숨기지 않는 쪽(옛 방)');
});

// ── #2 이전 대화 보기 ──
const own = [row('p-1'), row('o-lean', { org_id: LEAN, created_at: '2026-09-01T00:00:00+00:00' }), row('o-design', { org_id: DESIGN }), row('x-lean', { org_id: LEAN, slug: 'max' })];
const chan = (channel_id, member_id, org_id, extra = {}) => ({ channel_id, member_id, msgr_channels: { org_id, kind: 'dm', archived_at: null, ...extra } });
const mem = (channel_id, member_kind, member_id) => ({ channel_id, member_kind, member_id });
function fakeLookup({ cands = [], members = [], counts = {}, fail = null } = {}) {
  const calls = { crewDms: [], members: [], count: [] };
  return {
    calls,
    crewDms: async (ids) => { calls.crewDms.push(ids); if (fail === 'crewDms') throw new Error('net'); return cands.filter((c) => ids.includes(c.member_id)); },
    members: async (ids) => { calls.members.push(ids); return members.filter((m) => ids.includes(m.channel_id)); },
    count: async (id) => { calls.count.push(id); if (fail === 'count') throw new Error('net'); return counts[id] ?? 0; },
  };
}

test('#2 earlierAgentDms: 그 에이전트의 조직 행마다 옛 1:1(나 + 그 행)과 글 수 — 그룹 방·다른 에이전트는 빼고', async () => {
  const f = fakeLookup({
    cands: [chan('dm-lean', 'o-lean', LEAN), chan('dm-design', 'o-design', DESIGN), chan('grp', 'o-lean', LEAN)],
    members: [mem('dm-lean', 'user', ME), mem('dm-lean', 'crew', 'o-lean'), mem('dm-design', 'user', ME), mem('dm-design', 'crew', 'o-design'),
      mem('grp', 'user', ME), mem('grp', 'user', OTHER), mem('grp', 'crew', 'o-lean')],
    counts: { 'dm-lean': 282, 'dm-design': 4, grp: 9 },
  });
  const got = await G.earlierAgentDms('p-1', { uid: ME, rows: own, ...f });
  assert.deepEqual(got.sort((a, b) => a.orgId.localeCompare(b.orgId)), [
    { channelId: 'dm-design', orgId: DESIGN, crewId: 'o-design', n: 4, archived: false },
    { channelId: 'dm-lean', orgId: LEAN, crewId: 'o-lean', n: 282, archived: false }]);
  assert.deepEqual(f.calls.crewDms, [['o-lean', 'o-design']], '같은 에이전트의 조직 행만(다른 에이전트 x-lean 제외), 한 번');
  assert.equal(f.calls.members.length, 1, '구성원 확인 한 번');
  assert.deepEqual(f.calls.count.sort(), ['dm-design', 'dm-lean'], '그룹 방은 세지 않는다');
});

// 유건 결정 2026-10-08 1-②: 옛 조직 1:1은 보관하고 '이전 대화 보기'로 연다 — 보관한 방을 빼면 보관 뒤 옛 글(실측 페퍼 287개)을 볼 길이 없다.
// 같은 조직에 같은 에이전트와의 옛 1:1이 둘이면(운영 실측: 페퍼 287개·13개) 큰 방 하나만 보이던 것도 모두 보이게 한다.
test('#2 earlierAgentDms: 보관한 옛 1:1도, 같은 조직의 두 방도 모두 — 글 0개와 다른 조직에 걸린 행만 뺀다', async () => {
  const f = fakeLookup({
    cands: [chan('empty', 'o-lean', LEAN), chan('arch', 'o-lean', LEAN, { archived_at: '2026-10-08T00:00:00Z' }), chan('a', 'o-design', DESIGN), chan('b', 'o-design', DESIGN), chan('wrongorg', 'o-design', LEAN)],
    members: ['empty', 'arch', 'a', 'b', 'wrongorg'].flatMap((id) => [mem(id, 'user', ME), mem(id, 'crew', id === 'empty' || id === 'arch' ? 'o-lean' : 'o-design')]),
    counts: { empty: 0, arch: 50, a: 3, b: 7, wrongorg: 99 },
  });
  const got = await G.earlierAgentDms('p-1', { uid: ME, rows: own, ...f });
  assert.deepEqual(got.sort((x, y) => x.channelId.localeCompare(y.channelId)), [
    { channelId: 'a', orgId: DESIGN, crewId: 'o-design', n: 3, archived: false },
    { channelId: 'arch', orgId: LEAN, crewId: 'o-lean', n: 50, archived: true },
    { channelId: 'b', orgId: DESIGN, crewId: 'o-design', n: 7, archived: false }]);
});

test('#2 earlierAgentDms: 조직 행이 없거나·남의 행·조직 행에서 부르면 조회 0, 조회가 실패하면 빈 목록', async () => {
  const solo = fakeLookup();
  assert.deepEqual(await G.earlierAgentDms('p-solo', { uid: ME, rows: [row('p-solo', { slug: 'solo' })], ...solo }), []);
  assert.deepEqual(await G.earlierAgentDms('o-lean', { uid: ME, rows: own, ...solo }), [], '개인 1:1의 개인 행만');
  assert.deepEqual(await G.earlierAgentDms('p-1', { uid: OTHER, rows: own, ...solo }), [], '내 행이 아니면');
  assert.deepEqual(await G.earlierAgentDms('p-1', { uid: ME, rows: null, ...solo }), [], '내 크루 행을 아직 모르면');
  assert.equal(solo.calls.crewDms.length + solo.calls.members.length + solo.calls.count.length, 0);
  const bad = fakeLookup({ fail: 'crewDms' });
  assert.deepEqual(await G.earlierAgentDms('p-1', { uid: ME, rows: own, ...bad }), []);
  const badCount = fakeLookup({ cands: [chan('dm-lean', 'o-lean', LEAN)], members: [mem('dm-lean', 'user', ME), mem('dm-lean', 'crew', 'o-lean')], fail: 'count' });
  assert.deepEqual(await G.earlierAgentDms('p-1', { uid: ME, rows: own, ...badCount }), []);
});

test('#2 earlierLines: 조직 목록 순서로(같은 조직이면 글이 많은 방 먼저), 내가 나간 조직(목록에 없음)은 빼고 조직 이름을 붙인다', () => {
  const orgs = [{ id: DESIGN, name: 'Design' }, { id: LEAN, name: 'Lean' }];
  assert.deepEqual(G.earlierLines([{ channelId: 'dm-lean', orgId: LEAN, n: 282 }, { channelId: 'gone', orgId: 'org-left', n: 3 }, { channelId: 'dm-design', orgId: DESIGN, n: 4 }], orgs),
    [{ channelId: 'dm-design', orgId: DESIGN, n: 4, org: 'Design' }, { channelId: 'dm-lean', orgId: LEAN, n: 282, org: 'Lean' }]);
  assert.deepEqual(G.earlierLines([{ channelId: 'small', orgId: LEAN, n: 13, archived: true }, { channelId: 'big', orgId: LEAN, n: 287, archived: true }, { channelId: 'dm-design', orgId: DESIGN, n: 4 }], orgs).map((x) => x.channelId),
    ['dm-design', 'big', 'small'], '같은 조직의 두 방은 둘 다, 글이 많은 방 먼저');
  assert.deepEqual(G.earlierLines([], orgs), []);
  assert.deepEqual(G.earlierLines(null, null), []);
});

// 보관한 옛 1:1을 읽기로 연 방(App openEarlier가 남긴 것) — 지금 공간·지금 방일 때만 그 행. 목록(보관 제외)에 없는 방을 이것으로 그린다.
test('#2 archivedRoomFor: 지금 공간·지금 방이 읽기로 연 보관 방이면 그 행, 아니면 없음', () => {
  const row = { id: 'arch', kind: 'dm', org_id: LEAN, archived_at: '2026-10-08T00:00:00Z', name: 'dm:페퍼' };
  const earlier = { orgId: LEAN, channel: row, crewId: 'o-lean' };
  assert.equal(G.archivedRoomFor(earlier, { orgId: LEAN, chId: 'arch' }), row);
  assert.equal(G.archivedRoomFor(earlier, { orgId: DESIGN, chId: 'arch' }), undefined, '다른 공간');
  assert.equal(G.archivedRoomFor(earlier, { orgId: LEAN, chId: 'general' }), undefined, '다른 방으로 옮겼다');
  assert.equal(G.archivedRoomFor({ ...earlier, channel: { ...row, archived_at: null } }, { orgId: LEAN, chId: 'arch' }), undefined, '보관이 풀린 방은 목록이 그린다');
  assert.equal(G.archivedRoomFor(null, { orgId: LEAN, chId: 'arch' }), undefined);
});

// 검수 #857 MEDIUM(2026-10-08): 보관 대상 중 19개 방에 안 읽은 에이전트 글 54개(가장 최근 10/6, 운영 읽기 조회). 서버 안 읽음 수(msgr_unread·totals)는
// 보관 방을 세지 않아 보관하는 순간 배지가 안내 없이 사라진다 → 이전 대화 보기 줄에 보관 방의 안 읽은 수를 붙이고, 열어 읽으면 한 번만 커서를 올린다.
const reader = ({ cursors = {}, unread = {}, fail = null } = {}) => {
  const calls = { reads: [], unread: [] };
  return { calls,
    reads: async (ids) => { calls.reads.push(ids); if (fail === 'reads') throw new Error('net'); return ids.filter((id) => id in cursors).map((id) => ({ channel_id: id, last_read_id: cursors[id] })); },
    unread: async (id, after) => { calls.unread.push([id, after]); if (fail === 'unread') throw new Error('net'); return unread[`${id}>${after}`] ?? 0; } };
};
test('#2 earlierAgentDms: 보관한 방만 안 읽은 수를 센다 — 내 읽음 커서 한 번 + 보관 방마다 커서 뒤 글 수 1건, 보관 안 된 방은 조회 0', async () => {
  const f = fakeLookup({
    cands: [chan('arch-big', 'o-lean', LEAN, { archived_at: '2026-10-08T00:00:00Z' }), chan('arch-new', 'o-lean', LEAN, { archived_at: '2026-10-08T00:00:00Z' }), chan('live', 'o-design', DESIGN)],
    members: ['arch-big', 'arch-new', 'live'].flatMap((id) => [mem(id, 'user', ME), mem(id, 'crew', id === 'live' ? 'o-design' : 'o-lean')]),
    counts: { 'arch-big': 287, 'arch-new': 4, live: 3 },
  });
  const r = reader({ cursors: { 'arch-big': 900 }, unread: { 'arch-big>900': 3, 'arch-new>0': 4 } });
  const got = await G.earlierAgentDms('p-1', { uid: ME, rows: own, ...f, reads: r.reads, unread: r.unread });
  const by = Object.fromEntries(got.map((x) => [x.channelId, x]));
  assert.equal(by['arch-big'].unread, 3, '커서 뒤 글 수');
  assert.equal(by['arch-new'].unread, 4, '읽음 행이 없으면 처음부터(커서 0)');
  assert.equal('unread' in by.live, false, '보관 안 된 방은 목록 배지(서버 셈)가 그대로 있어 세지 않는다');
  assert.equal(r.calls.reads.length, 1, '내 읽음 커서는 한 번에');
  assert.deepEqual(r.calls.reads[0].sort(), ['arch-big', 'arch-new'], '보관 방만 묻는다');
  assert.deepEqual(r.calls.unread.sort(), [['arch-big', 900], ['arch-new', 0]]);
});
test('#2 earlierAgentDms: 안 읽은 수 조회가 실패해도 줄은 그대로(unread null) — 이전 대화를 볼 길을 막지 않는다', async () => {
  const base = () => fakeLookup({ cands: [chan('arch', 'o-lean', LEAN, { archived_at: '2026-10-08T00:00:00Z' })], members: [mem('arch', 'user', ME), mem('arch', 'crew', 'o-lean')], counts: { arch: 50 } });
  for (const fail of ['reads', 'unread']) {
    const r = reader({ fail });
    assert.deepEqual(await G.earlierAgentDms('p-1', { uid: ME, rows: own, ...base(), reads: r.reads, unread: r.unread }), [{ channelId: 'arch', orgId: LEAN, crewId: 'o-lean', n: 50, archived: true, unread: null }], fail);
  }
});
test('#2 earlierLineLabel: 보관 방에 안 읽은 글이 있으면 그 수를 붙인 문구, 없거나 모르면 종전 문구', () => {
  assert.deepEqual(G.earlierLineLabel({ org: 'Lean', n: 287, unread: 3 }), ['dm.earlier.unread', { org: 'Lean', n: 287, u: 3 }]);
  for (const unread of [0, null, undefined]) assert.deepEqual(G.earlierLineLabel({ org: 'Lean', n: 287, unread }), ['dm.earlier', { org: 'Lean', n: 287 }], String(unread));
});
test('#2 archivedReadStep: 이전 대화 보기로 연 보관 방만 판정 — 안 읽은 글이 있었으면 한 번(once), 없었으면 쓰기 0(skip), 그 밖은 종전(null)', () => {
  const ch = { id: 'arch', archived_at: '2026-10-08T00:00:00Z' };
  assert.equal(G.archivedReadStep({ orgId: LEAN, channel: ch, crewId: 'o-lean', unread: 3 }, 'arch'), 'once');
  assert.equal(G.archivedReadStep({ orgId: LEAN, channel: ch, crewId: 'o-lean', unread: 0 }, 'arch'), 'skip');
  assert.equal(G.archivedReadStep({ orgId: LEAN, channel: ch, crewId: 'o-lean', unread: null }, 'arch'), 'skip', '셀 수 없었으면 쓰지 않는다(종전과 같다)');
  assert.equal(G.archivedReadStep({ orgId: LEAN, channel: ch, crewId: 'o-lean', unread: 3 }, 'general'), null, '다른 방은 종전대로');
  assert.equal(G.archivedReadStep({ orgId: LEAN, channel: { ...ch, archived_at: null }, unread: 3 }, 'arch'), null, '보관이 풀린 방은 목록 방과 같다');
  assert.equal(G.archivedReadStep(null, 'arch'), null);
});
test('#2 clearEarlierUnread: 읽은 보관 방의 줄만 안 읽은 수 0으로(다시 묻지 않고 세션 기억을 고친다)', () => {
  const list = [{ channelId: 'a', n: 9, archived: true, unread: 3 }, { channelId: 'b', n: 2, archived: true, unread: 1 }, { channelId: 'c', n: 4, archived: false }];
  assert.deepEqual(G.clearEarlierUnread(list, 'a'), [{ channelId: 'a', n: 9, archived: true, unread: 0 }, list[1], list[2]]);
  assert.equal(list[0].unread, 3, '원래 목록은 바꾸지 않는다');
  assert.deepEqual(G.clearEarlierUnread(null, 'a'), []);
});
