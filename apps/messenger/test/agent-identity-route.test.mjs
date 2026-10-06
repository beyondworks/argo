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

test('#2 earlierAgentDms: 그 에이전트의 조직 행마다 옛 1:1(나 + 그 행)과 글 수 — 조직마다 한 줄', async () => {
  const f = fakeLookup({
    cands: [chan('dm-lean', 'o-lean', LEAN), chan('dm-design', 'o-design', DESIGN), chan('grp', 'o-lean', LEAN)],
    members: [mem('dm-lean', 'user', ME), mem('dm-lean', 'crew', 'o-lean'), mem('dm-design', 'user', ME), mem('dm-design', 'crew', 'o-design'),
      mem('grp', 'user', ME), mem('grp', 'user', OTHER), mem('grp', 'crew', 'o-lean')],
    counts: { 'dm-lean': 282, 'dm-design': 4, grp: 9 },
  });
  const got = await G.earlierAgentDms('p-1', { uid: ME, rows: own, ...f });
  assert.deepEqual(got.sort((a, b) => a.orgId.localeCompare(b.orgId)), [{ channelId: 'dm-design', orgId: DESIGN, n: 4 }, { channelId: 'dm-lean', orgId: LEAN, n: 282 }]);
  assert.deepEqual(f.calls.crewDms, [['o-lean', 'o-design']], '같은 에이전트의 조직 행만(다른 에이전트 x-lean 제외), 한 번');
  assert.equal(f.calls.members.length, 1, '구성원 확인 한 번');
  assert.deepEqual(f.calls.count.sort(), ['dm-design', 'dm-lean'], '그룹 방은 세지 않는다');
});

test('#2 earlierAgentDms: 글 0개·보관한 방·다른 조직에 걸린 행은 뺀다, 같은 조직에 방이 둘이면 글이 많은 쪽 한 줄', async () => {
  const f = fakeLookup({
    cands: [chan('empty', 'o-lean', LEAN), chan('arch', 'o-lean', LEAN, { archived_at: '2026-09-30T00:00:00Z' }), chan('a', 'o-design', DESIGN), chan('b', 'o-design', DESIGN), chan('wrongorg', 'o-design', LEAN)],
    members: ['empty', 'arch', 'a', 'b', 'wrongorg'].flatMap((id) => [mem(id, 'user', ME), mem(id, 'crew', id === 'empty' || id === 'arch' ? 'o-lean' : 'o-design')]),
    counts: { empty: 0, arch: 50, a: 3, b: 7, wrongorg: 99 },
  });
  assert.deepEqual(await G.earlierAgentDms('p-1', { uid: ME, rows: own, ...f }), [{ channelId: 'b', orgId: DESIGN, n: 7 }]);
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

test('#2 earlierLines: 조직 목록 순서로, 내가 나간 조직(목록에 없음)은 빼고 조직 이름을 붙인다', () => {
  const orgs = [{ id: DESIGN, name: 'Design' }, { id: LEAN, name: 'Lean' }];
  assert.deepEqual(G.earlierLines([{ channelId: 'dm-lean', orgId: LEAN, n: 282 }, { channelId: 'gone', orgId: 'org-left', n: 3 }, { channelId: 'dm-design', orgId: DESIGN, n: 4 }], orgs),
    [{ channelId: 'dm-design', orgId: DESIGN, n: 4, org: 'Design' }, { channelId: 'dm-lean', orgId: LEAN, n: 282, org: 'Lean' }]);
  assert.deepEqual(G.earlierLines([], orgs), []);
  assert.deepEqual(G.earlierLines(null, null), []);
});

