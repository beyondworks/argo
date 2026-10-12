// agent-pick.mjs — 유지할 에이전트 고르기(유건 2026-10-12 "유지할 4명의 에이전트를 선택해주세요", 한도 안에서 무제한 변경).
// 판정(슬롯 셈·고르는 목록·한도까지 고르기·저장 가능)과 배선(모든 연결 경로가 선택 창을 지나고, 적용은 서버 함수 msgr_free_keep 한 번)을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slotState, slotKey, keepChoices, togglePick, pickReady, swapPreview, keepAgents, readMyPlan, FREE_AGENT_LIMIT } from '../src/agent-pick.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const mod = readFileSync(new URL('../src/agent-pick.mjs', import.meta.url), 'utf8');
const me = 'u1';
const row = (id, ws, slug, status, over = {}) => ({ id, ws_id: ws, slug, status, owner_user_id: me, hosting: 'local', display_name: slug, ...over });

test('slotState — 같은 에이전트(ws+slug)의 여러 공간 행은 한 자리, 하나라도 active면 연결됨, 봇·남의 것 제외', () => {
  const rows = [row('a1', 'w1', 'pepper', 'active'), row('a2', 'w1', 'pepper', 'paused'), row('b1', 'w1', 'dale', 'paused'),
    row('c1', 'w2', 'eda', 'active'), row('x', 'w9', 'bot', 'active', { hosting: 'bot' }), row('z', 'w3', 'other', 'active', { owner_user_id: 'someone-else' })];
  const st = slotState(rows, me);
  assert.equal(st.slots.length, 3);
  assert.equal(st.used, 2);
  assert.equal(st.slots.find((s) => s.key === 'w1:dale').paused, true);
  assert.equal(st.slots.find((s) => s.key === 'w1:pepper').paused, false, '연결된 행이 있으면 멈춤이 아니다');
});

test('keepChoices — 연결·멈춤 에이전트 + 연결하려는 에이전트, 처음 고른 것 = 지금 연결된 것 + 연결하려는 것, 파견 해제 행은 함께 연결할 행으로', () => {
  const rows = ['p1', 'p2', 'p3', 'p4'].map((s, i) => row(`a${i}`, 'w', s, 'active')).concat([row('m1', 'w', 'm', 'paused')]);
  const target = row('t1', 'w', 'new', 'available');
  const c = keepChoices(rows, me, target);
  assert.deepEqual(c.slots.map((s) => s.key), ['w:p1', 'w:p2', 'w:p3', 'w:p4', 'w:m', 'w:new']);
  assert.deepEqual([...c.picked].sort(), ['w:new', 'w:p1', 'w:p2', 'w:p3', 'w:p4'], '5명이 골라진 채 시작 — 하나를 빼야 저장된다');
  assert.deepEqual(c.activate, ['t1']);
  assert.equal(pickReady(c.picked, c.slots), false, '5명은 저장 불가');
  assert.deepEqual(keepChoices(rows, me, row('m1', 'w', 'm', 'paused')).activate, [], '멈춘 에이전트는 서버가 재개한다(함께 연결할 행 없음)');
  assert.deepEqual([...keepChoices(rows, me).picked].sort(), ['w:p1', 'w:p2', 'w:p3', 'w:p4'], '설정 화면 — 지금 연결된 것');
});

test('togglePick·pickReady — 한도까지만 더하고, 고를 수 있는 만큼 정확히 골라야 저장(에이전트가 한도보다 적으면 그 수)', () => {
  let p = new Set(['a', 'b', 'c', 'd']);
  assert.equal(togglePick(p, 'e').size, 4, '한도에서 더하지 않는다');
  p = togglePick(p, 'd'); assert.equal(p.size, 3);
  p = togglePick(p, 'e'); assert.ok(p.has('e') && p.size === FREE_AGENT_LIMIT);
  const five = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: k }));
  assert.equal(pickReady(p, five), true);
  assert.equal(pickReady(new Set(['a', 'b']), five), false, '4명을 골라야 한다');
  assert.equal(pickReady(new Set(['a', 'b']), five.slice(0, 2)), true, '에이전트가 2명뿐이면 2명');
  assert.equal(pickReady(new Set(), []), false);
});

test('keepAgents — 서버 함수 한 번(고른 키·함께 연결할 행), 오류·던짐은 { ok: false }', async () => {
  const calls = [];
  const db = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: { paused: 1 }, error: null }; } };
  assert.deepEqual(await keepAgents(db, new Set(['w:a', 'w:b']), ['t1', null]), { ok: true, data: { paused: 1 } });
  assert.deepEqual(calls[0], ['msgr_free_keep', { p_keep: ['w:a', 'w:b'], p_activate: ['t1'] }]);
  assert.equal((await keepAgents({ rpc: async () => ({ error: { message: 'msgr_bad_member' } }) }, ['w:a'])).ok, false);
  assert.equal((await keepAgents({ rpc: async () => { throw new Error('net'); } }, ['w:a'])).ok, false);
  assert.doesNotMatch(mod, /from\('msgr_crews'\)\.update/, '앱은 상태를 직접 쓰지 않는다(파견 해제는 조직 기억을 지운다)');
});

test('swapPreview·readMyPlan — 오류는 [] / 이전 값', async () => {
  assert.deepEqual(await swapPreview({ rpc: async () => ({ data: ['d'], error: null }) }, row('a', 'w', 'x', 'available')), ['d']);
  assert.deepEqual(await swapPreview({ rpc: async () => ({ error: new Error('404') }) }, row('a', 'w', 'x', 'available')), []);
  assert.equal(await readMyPlan({ rpc: async () => ({ data: { plan: 'free' }, error: null }) }, 1000), 'free');
  assert.equal(await readMyPlan({ rpc: async () => ({ data: { plan: '??' }, error: null }) }, 400_000 + 1000), 'free');
});

test('배선 — 모든 연결 경로가 선택 창을 지나고, 문구는 유건 문구, 적용은 서버 함수·채널 참여까지', () => {
  assert.match(app, /if \(await needVictimPick\(crew, channelId\)\) return 'picking';/, 'dispatchCrew(레일·채널 추가)');
  assert.match(app, /if \(next && onNeedVictimPick && await onNeedVictimPick\(crew\)\)/, '에이전트 카드');
  assert.match(app, /if \(res === 'picking'\) \{ later\.push\(/, '채널 추가는 선택 창이 열린 에이전트를 "추가됨"으로 세지 않는다');
  assert.match(app, /if \(r === 'picking'\) return;/, '레일은 "연결했어요"를 띄우지 않는다');
  assert.match(app, /if \(!row\?\.ws_id \|\| !row\?\.slug\)/, 'ws_id·slug 없는 행은 1건 읽어 채운다(미리 보기가 죽지 않게)');
  assert.match(app, /const r = await keepAgents\(supabase, pick\.picked, targetKept \? pick\.activate : \[\]\)/, '적용은 서버 함수 한 번');
  assert.match(app, /if \(pick\.channelId && targetKept\) \{/, '연결하려던 에이전트를 고르면 채널에도 넣는다');
  assert.match(app, /<KeepPickList slots=\{victimPick\.slots\}/, '선택 창');
  assert.match(app, /<KeepPickList slots=\{choices\.slots\}/, '설정 › 내 에이전트(언제든 다시 고르기)');
  assert.ok(app.indexOf('{victimPick && (') > app.indexOf('{chSheet && channel && !orgBlocked && <ChannelSheet'), '선택 창은 채널 시트 위에');
  assert.doesNotMatch(app, /const \[joinErr, /, '상태가 모듈 함수 joinErr를 가리지 않는다');
  const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(i18n, /'agents\.slot\.full': \['유지할 \{limit\}명의 에이전트를 선택해주세요', 'Choose the \{limit\} agents to keep'\]/);
});
