// 폰 에이전트 탭 — 같은 에이전트 한 줄로 합치기·상단 메뉴 단락·즐겨찾기(유건 2026-10-02) 행동 테스트.
// 같은 에이전트 판정 = 주인(owner_user_id) + 회사(ws_id) + slug. 서버 msgr_personal_room_crews가 개인 행의 접속 시각을
// 조직 행에서 빌려 올 때 쓰는 규칙과 같다. 외부 봇의 개인 쌍둥이도 ws_id 'bot' + 조직 봇 행 slug 그대로라 같은 규칙으로 묶인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKey, groupAgents, rowForSpace, agentSections, AGENT_FILTERS, groupIsFav, favChanges, readAgentFav } from '../src/agent-groups.mjs';

const ME = 'u-me';
const LEAN = 'org-lean'; const DESIGN = 'org-design';
const row = (id, extra = {}) => ({ id, owner_user_id: ME, ws_id: 'ws-a', slug: 'davinci', display_name: '다빈치', hosting: 'local', status: 'active', org_id: null, ...extra });

test('같은 주인·회사·slug면 개인 공간 행과 조직 행이 한 줄로 합쳐진다', () => {
  const groups = groupAgents([row('c-org', { org_id: LEAN }), row('c-personal')], { orgOrder: [LEAN] });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rows.map((r) => r.id), ['c-personal', 'c-org'], '개인 공간이 먼저, 그 다음 조직 순서');
  assert.equal(groups[0].display_name, '다빈치');
});

test('회사(ws_id)가 다르면 이름·slug가 같아도 다른 에이전트다', () => {
  const groups = groupAgents([row('a', { org_id: LEAN }), row('b', { org_id: DESIGN, ws_id: 'ws-b' })], { orgOrder: [LEAN, DESIGN] });
  assert.equal(groups.length, 2);
});

test('이름만 같고 slug가 다르면 합치지 않는다(이름으로 판정하지 않는다)', () => {
  const groups = groupAgents([row('a', { org_id: LEAN }), row('b', { slug: 'davinci-2' })]);
  assert.equal(groups.length, 2);
});

test('주인이 다르면 합치지 않는다', () => {
  const groups = groupAgents([row('a', { org_id: LEAN }), row('b', { owner_user_id: 'u-other' })]);
  assert.equal(groups.length, 2);
});

test('ws_id·slug를 모르는 행(옛 서버)은 id로만 — 절대 다른 행과 합치지 않는다', () => {
  const groups = groupAgents([row('a', { ws_id: null }), row('b', { ws_id: null, org_id: LEAN })]);
  assert.equal(groups.length, 2);
  assert.equal(agentKey({ id: 'x', owner_user_id: ME, slug: 's' }), 'id:x');
});

test('외부 봇과 그 개인 쌍둥이(ws_id bot, 같은 slug)는 한 줄, ext로 분류된다', () => {
  const bot = { id: 'b-org', org_id: LEAN, owner_user_id: ME, ws_id: 'bot', slug: 'bot-8204192fa27f', display_name: '슈리', hosting: 'bot', status: 'active' };
  const twin = { ...bot, id: 'b-twin', org_id: null };
  const other = { ...bot, id: 'b-other', slug: 'bot-ffffffffffff', display_name: '슈리' }; // 같은 이름의 다른 봇
  const groups = groupAgents([bot, twin, other], { orgOrder: [LEAN] });
  assert.equal(groups.length, 2);
  const shuri = groups.find((g) => g.rows.length === 2);
  assert.deepEqual(shuri.rows.map((r) => r.id), ['b-twin', 'b-org']);
  assert.equal(shuri.ext, true);
});

test('같은 행이 두 번 와도 한 번만 센다', () => {
  const groups = groupAgents([row('a'), row('a')]);
  assert.equal(groups[0].rows.length, 1);
});

test('줄을 누르면 지금 보고 있는 공간의 행, 없으면 첫 공간', () => {
  const [g] = groupAgents([row('c-org', { org_id: LEAN }), row('c-personal')], { orgOrder: [LEAN] });
  assert.equal(rowForSpace(g, LEAN, 'personal').id, 'c-org');
  assert.equal(rowForSpace(g, 'personal', 'personal').id, 'c-personal');
  assert.equal(rowForSpace(g, DESIGN, 'personal').id, 'c-personal', '보고 있는 공간에 없으면 첫 공간(개인)');
});

test('상단 메뉴: 전체 · 즐겨찾기 · 내 에이전트 · 외부 에이전트', () => {
  assert.deepEqual(AGENT_FILTERS, ['all', 'fav', 'mine', 'ext']);
});

test('전체 = 즐겨찾기 → 내 에이전트 → 외부 에이전트 단락, 즐겨찾기는 아래 단락에 다시 나오지 않는다', () => {
  const groups = groupAgents([row('m1', { slug: 'a', display_name: '가' }), row('m2', { slug: 'b', display_name: '나' }), row('e1', { slug: 'bot-1', ws_id: 'bot', hosting: 'bot', display_name: '다', org_id: LEAN })]);
  const fav = new Set([groups.find((g) => g.display_name === '나').key]);
  const isFav = (g) => fav.has(g.key);
  const all = agentSections(groups, { filter: 'all', isFav });
  assert.deepEqual(all.map((s) => [s.key, s.list.map((g) => g.display_name)]), [['fav', ['나']], ['mine', ['가']], ['ext', ['다']]]);
  assert.deepEqual(agentSections(groups, { filter: 'fav', isFav }).map((s) => [s.key, s.list.length]), [['fav', 1]]);
  assert.deepEqual(agentSections(groups, { filter: 'mine', isFav }).map((s) => [s.key, s.list.map((g) => g.display_name)]), [['mine', ['가', '나']]], '내 에이전트 칩은 즐겨찾기도 포함');
  assert.deepEqual(agentSections(groups, { filter: 'ext', isFav }).map((s) => [s.key, s.list.map((g) => g.display_name)]), [['ext', ['다']]]);
});

test('빈 단락은 돌려주지 않는다', () => {
  const groups = groupAgents([row('m1')]);
  assert.deepEqual(agentSections(groups, { filter: 'all', isFav: () => false }).map((s) => s.key), ['mine']);
});

test('즐겨찾기 판정 — 조직 행은 서버 고정(msgr_target_prefs), 개인 행은 이 기기 목록. 하나라도 켜져 있으면 즐겨찾기', () => {
  const [g] = groupAgents([row('c-org', { org_id: LEAN }), row('c-personal')], { orgOrder: [LEAN] });
  assert.equal(groupIsFav(g, { pinned: new Set(), local: new Set() }), false);
  assert.equal(groupIsFav(g, { pinned: new Set([`${LEAN}:c-org`]), local: new Set() }), true);
  assert.equal(groupIsFav(g, { pinned: new Set(), local: new Set(['c-personal']) }), true);
});

test('즐겨찾기 켜기·끄기 — 바뀌는 행만 서버에 쓴다(같은 값은 다시 쓰지 않는다), 개인 행은 기기 목록만 바꾼다', () => {
  const [g] = groupAgents([row('c-org', { org_id: LEAN }), row('c-org2', { org_id: DESIGN }), row('c-personal')], { orgOrder: [LEAN, DESIGN] });
  const on = favChanges(g, true, { pinned: new Set([`${LEAN}:c-org`]), local: new Set() });
  assert.deepEqual(on.server, [{ org_id: DESIGN, target_kind: 'crew', target_id: 'c-org2', pinned: true }]);
  assert.deepEqual([...on.local], ['c-personal']);
  const off = favChanges(g, false, { pinned: new Set([`${LEAN}:c-org`, `${DESIGN}:c-org2`]), local: new Set(['c-personal', 'keep-me']) });
  assert.deepEqual(off.server.map((p) => [p.org_id, p.pinned]), [[LEAN, false], [DESIGN, false]]);
  assert.deepEqual([...off.local], ['keep-me'], '다른 에이전트의 기기 즐겨찾기는 그대로');
  const same = favChanges(g, false, { pinned: new Set(), local: new Set() });
  assert.deepEqual(same.server, [], '이미 꺼져 있으면 서버 쓰기 0');
});

test('기기 즐겨찾기 읽기 — 깨진 값·배열 아닌 값은 빈 목록', () => {
  const store = (v) => ({ getItem: () => v });
  assert.deepEqual([...readAgentFav(store('["a","b"]'))], ['a', 'b']);
  assert.deepEqual([...readAgentFav(store('{bad'))], []);
  assert.deepEqual([...readAgentFav(store('{"a":1}'))], []);
  assert.deepEqual([...readAgentFav(null)], []);
});
