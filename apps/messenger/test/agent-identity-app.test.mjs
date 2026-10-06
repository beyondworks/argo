// 에이전트 = 한 사람(유건 2026-10-05) 분리 검수 #1·#5 — App.jsx의 실제 openAgentDmInstead를 꺼내 가짜 의존성으로 돌린다(rail-state.test.mjs loadMyAgents와 같은 방식).
//  #1 옛 조직 1:1에 안 읽은 글이 있으면 목록 줄이라도 돌리지 않는다(false → 부르는 쪽이 setChId로 열고, 방이 읽음 처리한다). 글을 가리키는 입구도 돌리지 않는다.
//  #5 돌리는 중에 같은 줄을 다시 누르면 무시한다(서버에 한 번만 묻는다), 끝나면 다시 누를 수 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../src/agent-groups.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const head = 'const openAgentDmInstead = ';
const start = app.indexOf(head) + head.length;
const src = app.slice(start, app.indexOf('\n  };', start) + 4);

const ME = 'u-me'; const LEAN = 'org-lean';
const LEGACY = { id: 'dm-pepper', kind: 'dm', org_id: LEAN };
const ORG_ROW = { id: 'o-1', org_id: LEAN, owner_user_id: ME, ws_id: 'ws-a', slug: 'pepper', status: 'active' };
const MY_AGENTS = [ORG_ROW, { id: 'p-1', org_id: null, owner_user_id: ME, ws_id: 'ws-a', slug: 'pepper', status: 'active', hosting: 'local' }];

function harness({ unread = {} } = {}) {
  const seen = { asked: 0, moved: [], opened: [], busy: [] }; const waits = [];
  const deps = {
    isPersonal: false, agentDmRedirect: G.agentDmRedirect, agentDmRoute: G.agentDmRoute, channels: [LEGACY],
    dmMembers: { [LEGACY.id]: [{ member_kind: 'user', member_id: ME }, { member_kind: 'crew', member_id: 'o-1' }] },
    uid: ME, crewOf: (id) => (id === 'o-1' ? ORG_ROW : null), myAgents: MY_AGENTS, unread,
    redirecting: { current: null }, setRedirectingId: (v) => seen.busy.push(v),
    orgId: LEAN, chId: 'general', activeOrg: { current: LEAN },
    personalTwin: () => { seen.asked += 1; return new Promise((res) => waits.push(() => res(MY_AGENTS[1]))); },
    toPersonalTwin: (crew, twin) => seen.moved.push(twin.id),
    setChId: (id) => seen.opened.push(id), setPage: () => {}, setRail: () => {}, setSheet: () => {},
  };
  const open = new Function(...Object.keys(deps), `return (${src});`)(...Object.values(deps));
  const settle = async () => { for (const w of waits.splice(0)) w(); await new Promise((r) => setTimeout(r, 0)); };
  return { open, seen, settle };
}

test('#1 옛 조직 1:1에 안 읽은 글이 있으면 목록 줄이라도 돌리지 않는다 — 부르는 쪽이 그 방을 연다(읽음 처리는 방이 한다)', async () => {
  const h = harness({ unread: { [LEGACY.id]: { n: 2, mention: 0 } } });
  assert.equal(h.open(LEGACY.id, 'list'), false);
  await h.settle();
  assert.equal(h.seen.asked, 0, '개인 행을 묻지 않는다');
  assert.deepEqual(h.seen.moved, []);
});

test('#1 알림함·OS 알림·푸시·전경 카드·미리보기는 그 방의 글을 가리킨다 — 안 읽은 글이 없어도 옛 방', async () => {
  for (const from of ['inbox', 'push', 'mac', 'card', 'peek']) {
    const h = harness();
    assert.equal(h.open(LEGACY.id, from), false, from);
    await h.settle();
    assert.equal(h.seen.asked, 0, from);
  }
});

test('#1 안 읽은 글이 없는 목록 줄은 종전대로 개인 1:1로 간다', async () => {
  const h = harness();
  assert.equal(h.open(LEGACY.id, 'list'), true);
  await h.settle();
  assert.equal(h.seen.asked, 1);
  assert.deepEqual(h.seen.moved, ['p-1']);
  assert.deepEqual(h.seen.opened, [], '옛 방은 열지 않는다');
});

test('#5 돌리는 중에 같은 줄을 다시 누르면 무시한다 — 서버에 한 번만 묻고, 끝나면 다시 누를 수 있다', async () => {
  const h = harness();
  assert.equal(h.open(LEGACY.id, 'list'), true);
  assert.equal(h.open(LEGACY.id, 'list'), true, '두 번째 누름도 처리한 것으로(부르는 쪽이 옛 방을 열지 않게)');
  assert.equal(h.seen.asked, 1, '연타해도 한 번');
  assert.deepEqual(h.seen.busy, [LEGACY.id], '줄에 돌리는 중 표시');
  await h.settle();
  assert.deepEqual(h.seen.moved, ['p-1'], '옮기기도 한 번');
  assert.deepEqual(h.seen.busy, [LEGACY.id, null], '끝나면 표시를 지운다');
  h.open(LEGACY.id, 'list'); await h.settle();
  assert.equal(h.seen.asked, 2, '끝난 뒤에는 다시 누를 수 있다');
});
