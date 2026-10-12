// 설정 › 메신저 연결 — 무료 계정이 유지할 에이전트를 고르는 목록(유건 2026-10-12 제보: 12명 중 5~8·9~12번만 번갈아 연결, 1~4번은 영영 안 됨).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keepChoices, hereSlugs, sameAsActive, togglePick, pickReady } from '../app/c/[ws]/settings/keep-choices.mjs';
import { keepPlan } from '../app/api/companies/[ws]/msgr/keep-plan.mjs';

const UID = 'u1';
const agents = Array.from({ length: 12 }, (_, i) => ({ slug: `a${i + 1}`, name: `에이전트${i + 1}` }));
const row = (ws, slug, status, extra = {}) => ({ id: `${ws}-${slug}`, ws_id: ws, slug, display_name: slug, status, hosting: 'local', owner_user_id: UID, ...extra });

// 제보 재현 모델 — 종전 일괄 연결: 빠진 에이전트를 목록 순서대로 하나씩 연결하고, 한도가 차 있으면 연결할 때마다 가장 오래 고른 것을 멈춘다(서버 관문)
function oldBulkConnect(active, order, limit = 4) {
  let act = [...active];
  for (const s of order.filter((x) => !act.includes(x))) { if (act.length >= limit) act.shift(); act.push(s); }
  return act;
}

test('제보 재현: 종전 일괄 연결은 매번 목록 끝 4명만 남아 앞쪽 1~4번은 다시 연결되지 않는다', () => {
  const order = agents.map((a) => a.slug);
  let act = ['a1', 'a2', 'a3', 'a4'];
  const seen = [];
  for (let i = 0; i < 4; i++) { act = oldBulkConnect(act, order); seen.push(act.join(',')); }
  assert.deepEqual(seen, ['a9,a10,a11,a12', 'a5,a6,a7,a8', 'a9,a10,a11,a12', 'a5,a6,a7,a8']);
});

test('고르는 목록: 연결·멈춤 에이전트(다른 회사 포함) + 지금 연결하려는 이 회사 에이전트, 처음 고름 = 지금 연결된 것 + 남는 자리만큼', () => {
  const rows = [row('w', 'a1', 'active'), row('w', 'a2', 'active'), row('w', 'a3', 'paused'), row('other', 'x', 'active'), row('w', 'bot', 'active', { hosting: 'bot' })];
  const { slots, picked } = keepChoices({ rows, uid: UID, ws: 'w', wanted: ['a5', 'a6', 'a7'], agents });
  assert.deepEqual(slots.map((s) => s.key), ['w:a1', 'w:a2', 'w:a3', 'w:a5', 'w:a6', 'w:a7', 'other:x'], '이 회사(카드 순서) 먼저, 봇 제외, 연결하려 하지 않은 a4·a8…은 목록에 없다');
  assert.equal(slots.at(-1).here, false);
  assert.equal(slots.find((s) => s.key === 'w:a3').paused, true);
  assert.equal(slots.find((s) => s.key === 'w:a1').name, '에이전트1', '이 회사 이름은 카드 이름');
  assert.deepEqual([...picked].sort(), ['other:x', 'w:a1', 'w:a2', 'w:a5'].sort(), '연결 3명 + 자리 1 → 연결하려는 첫 번째만');
});

test('[분리 검수 M2] 다른 조직에서 이미 연결된 에이전트를 연결하려 해도 처음 고름에서 빠지지 않는다', () => {
  const c1 = keepChoices({ rows: [row('w', 'a1', 'active')], uid: UID, ws: 'w', wanted: ['a1', 'a2', 'a3'], agents });
  assert.deepEqual([...c1.picked].sort(), ['w:a1', 'w:a2', 'w:a3']);
  const c4 = keepChoices({ rows: ['a1', 'a2', 'a3', 'a4'].map((s) => row('w', s, 'active')), uid: UID, ws: 'w', wanted: ['a1', 'a2', 'a3', 'a4', 'a5'], agents });
  assert.deepEqual([...c4.picked].sort(), ['w:a1', 'w:a2', 'w:a3', 'w:a4'], '이미 연결된 4명은 그대로, 다섯 번째는 사람이 고른다');
});

test('[유지할 에이전트 바꾸기] 연결하려는 것이 없으면 연결·멈춤 에이전트만 고를 거리 — 메신저에 올린 적 없는 에이전트는 나오지 않는다', () => {
  const c = keepChoices({ rows: [row('w', 'a1', 'active'), row('w', 'a2', 'paused')], uid: UID, ws: 'w', agents });
  assert.deepEqual(c.slots.map((s) => s.key), ['w:a1', 'w:a2']);
});

test('한도가 찬 상태: 연결하려는 것은 미리 고르지 않고, 사람이 바꾼 묶음(1·3·4·7)을 그대로 보낸다', () => {
  const rows = ['a1', 'a2', 'a3', 'a4'].map((s) => row('w', s, 'active'));
  const c = keepChoices({ rows, uid: UID, ws: 'w', wanted: ['a5', 'a6', 'a7', 'a8'], agents });
  assert.deepEqual([...c.picked].sort(), ['w:a1', 'w:a2', 'w:a3', 'w:a4']);
  assert.equal(sameAsActive(c.picked, c.slots), true, '바뀐 게 없으면 저장을 끈다');
  let p = togglePick(c.picked, 'w:a7'); assert.equal(p.size, 4, '한도를 넘겨 더하지 않는다');
  p = togglePick(togglePick(c.picked, 'w:a2'), 'w:a7');
  assert.equal(pickReady(p, c.slots), true);
  assert.equal(sameAsActive(p, c.slots), false);
  assert.deepEqual(hereSlugs(p, 'w').sort(), ['a1', 'a3', 'a4', 'a7']);
});

test('에이전트가 한도보다 적으면 그 수만큼 고르면 저장된다', () => {
  const few = agents.slice(0, 3);
  const c = keepChoices({ rows: [row('w', 'a1', 'active')], uid: UID, ws: 'w', wanted: ['a2', 'a3'], agents: few });
  assert.equal(pickReady(new Set(['w:a1', 'w:a2', 'w:a3']), c.slots), true);
  assert.equal(pickReady(new Set(['w:a1', 'w:a2']), c.slots), false);
});

const ORG = '7250bb3f-0000-4000-8000-000000000001';
test('[적용 판정] 연결 흐름: 고른 것 중 add에 든 이 회사 에이전트만 새 행, 함께 연결할 파견 해제 행도 add만', () => {
  const p = keepPlan({ keep: ['w:a1', 'w:a4', 'w:a7', 'w:a12', 'other:x'], add: ['a5', 'a6', 'a7', 'a8', 'a12'], ws: 'w', orgId: ORG, agents,
    existing: new Set(['a1', 'a4', 'a12']), scope: [{ id: 'r12', slug: 'a12', status: 'available' }, { id: 'r4', slug: 'a4', status: 'available' }] });
  assert.deepEqual(p.inserts, ['a7'], 'a12는 이미 행이 있다, a5·a6·a8은 고르지 않았다');
  assert.deepEqual(p.act, ['r12'], 'a4는 add 밖 — 사람이 해제한 행을 켜지 않는다');
  assert.equal(p.keys.length, 5);
});

test('[적용 판정] 바꾸기(add 없음)는 새 조직 등록을 만들지 않고, 지운 에이전트의 남은 행도 유지할 수 있다(분리 검수 L1·L2)', () => {
  const p = keepPlan({ keep: ['w:gone', 'w:a1'], ws: 'w', orgId: ORG, agents, existing: new Set(['gone']), scope: [{ id: 'g', slug: 'gone', status: 'available' }] });
  assert.deepEqual(p, { keys: ['w:gone', 'w:a1'], inserts: [], act: [] });
  assert.deepEqual(keepPlan({ keep: ['w:gone'], add: ['gone'], ws: 'w', orgId: ORG, agents }), { error: 'msgr_crew_not_found' }, '새로 넣으려는 것은 카드가 있어야 한다');
});

test('[적용 판정] 개인 공간은 행을 넣지 않는다 · 입력 거절(빈 목록·형식·20개 초과·조직 id)', () => {
  const p = keepPlan({ keep: ['w:a1', 'w:a2'], add: ['a2'], ws: 'w', personal: true, agents, scope: [{ id: 'p2', slug: 'a2', status: 'available' }] });
  assert.deepEqual(p.inserts, []);
  assert.deepEqual(p.act, ['p2']);
  for (const bad of [{ keep: [] }, { keep: ['nocolon'] }, { keep: Array.from({ length: 21 }, (_, i) => `w:a${i}`) }, { keep: ['w:a1'], orgId: 'x' }]) {
    assert.deepEqual(keepPlan({ ws: 'w', agents, orgId: ORG, ...bad }), { error: 'msgr_bad_request' }, JSON.stringify(bad).slice(0, 40));
  }
});

test('배선: 자리가 모자라면 고르기를 먼저 열고(못 열 때만 종전 확인), 라우트는 keepPlan 판정 뒤 msgr_free_keep 한 번', () => {
  const page = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /if \(p\?\.victims\?\.length\) \{[\s\S]{0,300}?if \(await openKeep\(scope, slugs\)\) return;\s*\n\s*setConfirm\(/);
  const route = readFileSync(new URL('../app/api/companies/[ws]/msgr/route.js', import.meta.url), 'utf8');
  assert.match(route, /const plan = keepPlan\(/);
  assert.match(route, /rpc\('msgr_free_keep', \{ p_keep: keys, p_activate: act \}\)/);
});
