// 에이전트 = 한 사람(유건 2026-10-05) — 같은 에이전트(주인·회사·slug)는 공간·화면과 상관없이 같은 얼굴·사진이고,
// 내 에이전트와의 1:1은 어느 입구로 들어가도 개인 1:1 한 방으로 간다. 행동 테스트(순수 함수·가짜 supabase).
//  · 얼굴 기준 = 대표 조직 행(그 주인·회사·slug의 살아 있는 조직 행 중 created_at·id가 가장 앞선 것): 저장된 얼굴이 있으면 그것, 없으면 대표 행 id 씨앗.
//  · 사진 = 그 행 사진, 없으면 대표 행 사진.
//  · 얼굴·사진 저장 = 같은 에이전트의 내 행 전부를 한 번에.
//  · 옛 조직 1:1(사람은 나 하나 + 내 에이전트 하나) = 개인 1:1로 돌린다. 남의 에이전트·사람 DM·그룹 방은 그대로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceOf, agentLooks, agentLook, agentFace } from '../src/crew-face.mjs';
import { agentKey, legacyAgentDm, agentDmRedirect, saveAgentLook } from '../src/agent-groups.mjs';

const ME = 'u-me'; const OTHER = 'u-other';
const LEAN = 'org-lean'; const DESIGN = 'org-design';
const row = (id, extra = {}) => ({ id, owner_user_id: ME, ws_id: 'ws-a', slug: 'pepper', status: 'active', org_id: null, face: null, avatar_url: null, created_at: '2026-09-10T00:00:00+00:00', ...extra });
const ORANGE = { v: 2, shape: 8, color: 9 };

test('같은 에이전트의 개인 행과 조직 행은 같은 얼굴 — 조직 행에 저장된 얼굴(주황)이 개인 공간에도 보인다', () => {
  const rows = [row('p-1'), row('o-1', { org_id: LEAN, face: ORANGE })];
  const looks = agentLooks(rows);
  assert.deepEqual(agentFace('p-1', looks), { shape: 8, color: 9 }, '개인 행은 저장값이 없어도 대표 조직 행의 얼굴');
  assert.deepEqual(agentFace('o-1', looks), { shape: 8, color: 9 });
});

test('얼굴을 저장한 적이 없으면 대표 조직 행(가장 먼저 만든 행) id가 씨앗 — 모든 행이 같은 얼굴', () => {
  const rows = [row('p-1', { created_at: '2026-09-01T00:00:00+00:00' }), row('o-late', { org_id: DESIGN, created_at: '2026-09-20T00:00:00+00:00' }), row('o-early', { org_id: LEAN, created_at: '2026-09-05T00:00:00+00:00' })];
  const looks = agentLooks(rows);
  const want = faceOf('o-early');
  for (const id of ['p-1', 'o-late', 'o-early']) assert.deepEqual(agentFace(id, looks), want, `${id}도 대표 행 기준`);
  assert.equal(agentLook('p-1', looks).seed, 'o-early', '개인 행이 더 먼저 만들어졌어도 대표는 조직 행');
});

test('만든 시각이 같으면(한 문장으로 넣은 행) id가 앞선 행이 대표', () => {
  const at = '2026-09-05T00:00:00.123+00:00';
  const looks = agentLooks([row('o-b', { org_id: DESIGN, created_at: at }), row('o-a', { org_id: LEAN, created_at: at }), row('p-1')]);
  assert.equal(agentLook('p-1', looks).seed, 'o-a');
});

test('조직 행이 없는 에이전트(개인 전용)는 지금처럼 자기 행 기준', () => {
  const looks = agentLooks([row('p-only', { face: { v: 2, shape: 3, color: 4 } }), row('p-plain', { slug: 'solo' })]);
  assert.deepEqual(agentFace('p-only', looks), { shape: 3, color: 4 });
  assert.deepEqual(agentFace('p-plain', looks), faceOf('p-plain'));
});

test('대표 행에 저장값이 없고 다른 행에만 있으면 그 저장값 — 주인이 고른 얼굴을 버리지 않는다', () => {
  const looks = agentLooks([row('o-rep', { org_id: LEAN, created_at: '2026-09-01T00:00:00+00:00' }), row('p-1', { face: { v: 2, shape: 1, color: 2 } })]);
  assert.deepEqual(agentFace('o-rep', looks), { shape: 1, color: 2 });
  assert.deepEqual(agentFace('p-1', looks), { shape: 1, color: 2 });
});

test('사진: 그 행에 사진이 없으면 대표 행 사진, 있으면 자기 사진', () => {
  const looks = agentLooks([row('o-1', { org_id: LEAN, avatar_url: 'https://x/rep.jpg' }), row('p-1'), row('o-2', { org_id: DESIGN, created_at: '2026-09-30T00:00:00+00:00', avatar_url: 'https://x/own.jpg' })]);
  assert.equal(agentLook('p-1', looks).photo, 'https://x/rep.jpg');
  assert.equal(agentLook('o-2', looks).photo, 'https://x/own.jpg');
});

test('주인·회사·slug 중 하나라도 모르는 행, 지도에 없는 행(남의 에이전트)은 그 행 id·저장값 그대로', () => {
  const looks = agentLooks([row('o-1', { org_id: LEAN, face: ORANGE }), row('p-x', { ws_id: null })]);
  assert.deepEqual(agentFace('p-x', looks), faceOf('p-x'), '회사를 모르면 합치지 않는다');
  assert.deepEqual(agentFace('theirs', looks, { v: 2, shape: 5, color: 5 }), { shape: 5, color: 5 }, '남의 에이전트는 자기 행 저장값');
  assert.deepEqual(agentFace('theirs', looks), faceOf('theirs'));
  assert.deepEqual(agentFace('x', null), faceOf('x'), '지도가 아직 없으면 종전 계산');
});

test('agentKey는 얼굴 지도와 같은 규칙(주인·회사·slug, 모르면 id)', () => {
  assert.equal(agentKey(row('a')), 'u-me|ws-a|pepper');
  assert.equal(agentKey({ id: 'z', owner_user_id: ME, slug: 's' }), 'id:z');
});

// ── 저장: 같은 에이전트의 내 행 전부를 한 번에 ──
function fakeDb({ failBulk = false } = {}) {
  const calls = [];
  const db = { from(table) {
    const call = { table, patch: null, ids: null, eq: null };
    const chain = {
      update(patch) { call.patch = patch; return chain; },
      in(col, ids) { call.ids = [col, ids]; return chain; },
      eq(col, v) { call.eq = [col, v]; return chain; },
      select() { calls.push(call); const bulk = call.ids && call.ids[1].length > 1; return Promise.resolve(failBulk && bulk ? { data: null, error: { message: 'msgr_policy_locked' } } : { data: (call.ids?.[1] ?? [call.eq?.[1]]).map((id) => ({ id })), error: null }); },
    };
    return chain;
  } };
  return { db, calls };
}

test('얼굴 저장은 같은 에이전트(주인·회사·slug)의 내 행 전부를 바꾼다 — 다른 에이전트 행은 건드리지 않는다', async () => {
  const looks = agentLooks([row('p-1'), row('o-1', { org_id: LEAN }), row('o-2', { org_id: DESIGN }), row('x-1', { slug: 'other', org_id: LEAN })]);
  const { db, calls } = fakeDb();
  const r = await saveAgentLook(db, 'p-1', { face: ORANGE }, looks);
  assert.equal(r.error, null);
  assert.equal(calls.length, 1, '요청 한 번');
  assert.equal(calls[0].table, 'msgr_crews');
  assert.deepEqual(calls[0].patch, { face: ORANGE });
  assert.deepEqual(calls[0].ids, ['id', ['p-1', 'o-1', 'o-2']]);
  assert.deepEqual(r.ids.slice().sort(), ['o-1', 'o-2', 'p-1']);
});

test('사진 저장·지우기도 같은 규칙, 지도를 모르면(옛 서버) 누른 행 하나만', async () => {
  const looks = agentLooks([row('p-1'), row('o-1', { org_id: LEAN })]);
  const a = fakeDb(); await saveAgentLook(a.db, 'o-1', { avatar_url: null }, looks);
  assert.deepEqual(a.calls[0].ids, ['id', ['p-1', 'o-1']]);
  const b = fakeDb(); await saveAgentLook(b.db, 'solo', { face: ORANGE }, null);
  assert.deepEqual(b.calls[0].ids, ['id', ['solo']]);
});

test('여러 행 저장이 거절되면(조직 정책 잠금 등) 누른 행 하나만 다시 저장한다', async () => {
  const looks = agentLooks([row('p-1'), row('o-1', { org_id: LEAN })]);
  const { db, calls } = fakeDb({ failBulk: true });
  const r = await saveAgentLook(db, 'p-1', { face: ORANGE }, looks);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].ids, ['id', ['p-1']]);
  assert.equal(r.error, null);
  assert.deepEqual(r.ids, ['p-1']);
});

// ── 옛 조직 1:1 → 개인 1:1 ──
const crewRows = { 'o-1': row('o-1', { org_id: LEAN }), 'their': row('their', { org_id: LEAN, owner_user_id: OTHER, slug: 'max' }) };
const crewOf = (id) => crewRows[id] ?? null;
const dm = (id, extra = {}) => ({ id, kind: 'dm', org_id: LEAN, ...extra });
const mem = (kind, id) => ({ member_kind: kind, member_id: id });
const myAgents = [row('p-1', { org_id: null }), row('o-1', { org_id: LEAN })];

test('내 에이전트와의 조직 1:1(사람은 나 하나 + 내 에이전트 하나)이면 그 에이전트', () => {
  assert.equal(legacyAgentDm(dm('c1'), [mem('user', ME), mem('crew', 'o-1')], { uid: ME, crewOf })?.id, 'o-1');
});

test('남의 에이전트·사람 1:1·그룹 방·개인 방·구성원을 아직 모르는 방은 돌리지 않는다', () => {
  assert.equal(legacyAgentDm(dm('c2'), [mem('user', ME), mem('user', OTHER), mem('crew', 'their')], { uid: ME, crewOf }), null, '남의 에이전트');
  assert.equal(legacyAgentDm(dm('c3'), [mem('user', ME), mem('user', OTHER)], { uid: ME, crewOf }), null, '사람 1:1');
  assert.equal(legacyAgentDm(dm('c4'), [mem('user', ME), mem('user', OTHER), mem('crew', 'o-1')], { uid: ME, crewOf }), null, '사람이 둘인 방');
  assert.equal(legacyAgentDm(dm('c5', { org_id: null }), [mem('user', ME), mem('crew', 'o-1')], { uid: ME, crewOf }), null, '개인 방은 이미 개인');
  assert.equal(legacyAgentDm(dm('c6'), undefined, { uid: ME, crewOf }), null, '구성원을 모름');
  assert.equal(legacyAgentDm({ id: 'c7', kind: 'public', org_id: LEAN }, [mem('user', ME), mem('crew', 'o-1')], { uid: ME, crewOf }), null, '채널');
});

test('개인 1:1이 있다고 알면 known, 내 에이전트 목록을 아직 모르면 서버에 물어볼 대상, 개인 행이 없으면 종전대로', () => {
  const members = [mem('user', ME), mem('crew', 'o-1')];
  assert.deepEqual(agentDmRedirect(dm('c1'), members, { uid: ME, crewOf, myAgents }), { crew: crewRows['o-1'], known: true });
  assert.deepEqual(agentDmRedirect(dm('c1'), members, { uid: ME, crewOf, myAgents: null }), { crew: crewRows['o-1'], known: false });
  assert.equal(agentDmRedirect(dm('c1'), members, { uid: ME, crewOf, myAgents: [row('o-1', { org_id: LEAN })] }), null, '개인 행이 없는 에이전트(0.1.92 이전 본체)');
  assert.equal(agentDmRedirect(dm('c2'), [mem('user', ME), mem('user', OTHER), mem('crew', 'their')], { uid: ME, crewOf, myAgents }), null, '남의 에이전트는 그대로');
});
