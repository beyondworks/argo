// agent-pick.mjs — 슬롯 셈(서버 count distinct (ws_id, slug)과 같은 규칙)·선택 교체(멈춤 → 연결, 실패 시 되돌리기)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slotState, slotKey, swapPreview, swapConnect, writeStatus, FREE_AGENT_LIMIT, readMyPlan } from '../src/agent-pick.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'); // 배선 핀 — 선택지가 실제 경로에 연결돼 있는지(분리 검수 HIGH-1: crew 행에 ws_id가 없어 미리 보기가 죽던 것)

const me = 'u1';
const row = (id, ws, slug, status, over = {}) => ({ id, ws_id: ws, slug, status, owner_user_id: me, hosting: 'local', display_name: slug, ...over });

test('slotState — 같은 에이트(ws+slug)의 여러 공간 행은 한 자리, 하나라도 active면 연결됨', () => {
  const rows = [row('a1', 'w1', 'pepper', 'active'), row('a2', 'w1', 'pepper', 'available'), row('b1', 'w1', 'dale', 'paused'),
    row('c1', 'w2', 'eda', 'active'), row('x', 'w9', 'bot', 'active', { hosting: 'bot' }), row('z', 'w3', 'other', 'active', { owner_user_id: 'someone-else' })];
  const st = slotState(rows, me);
  assert.equal(st.slots.length, 3, '봇·남의 것 제외 3슬롯');
  assert.equal(st.used, 2, 'pepper·eda 연결됨');
  assert.equal(st.slots.find((s) => s.key === 'w1:dale').paused, true);
  assert.equal(st.slots.find((s) => s.key === 'w1:pepper').rows.length, 2);
});

test('swapPreview — 서버가 주는 멈춤 예정 이름, 오류·옛 서버는 []', async () => {
  const ok = { rpc: async () => ({ data: ['dale'], error: null }) };
  assert.deepEqual(await swapPreview(ok, row('a1', 'w1', 'pepper', 'available')), ['dale']);
  const err = { rpc: async () => ({ data: null, error: new Error('404') }) };
  assert.deepEqual(await swapPreview(err, row('a1', 'w1', 'pepper', 'available')), []);
});

const fakeDb = (failOn = null) => {
  const calls = [];
  return { calls, from: () => ({ update: (v) => ({ in: (c, ids) => { calls.push([v.status, ids]); return { select: () => Promise.resolve(failOn === v.status ? { data: null, error: { message: 'denied' } } : { data: ids.map((id) => ({ id })), error: null }) }; } }) }) };
};

test('writeStatus — RLS가 일부만 바꾸면(0행·일부 행) 오류로 본다', async () => {
  const db = fakeDb();
  assert.deepEqual(await writeStatus(db, ['a', 'b'], 'available'), { ok: true });
  const partial = { from: () => ({ update: () => ({ in: () => ({ select: () => Promise.resolve({ data: [{ id: 'a' }], error: null }) }) }) }) };
  assert.equal((await writeStatus(partial, ['a', 'b'], 'available')).ok, false);
});

test('swapConnect — 멈춤 먼저, 연결 실패 시 멈춤을 되돌린다(되돌리기 실패는 오류 문구에)', async () => {
  const ok = fakeDb();
  const victim = { name: 'dale', rows: [row('b1', 'w1', 'dale', 'active'), row('b2', 'w1', 'dale', 'active', { org_id: 'o' })] };
  const target = row('a1', 'w1', 'pepper', 'available');
  assert.deepEqual(await swapConnect(ok, victim, target), { ok: true });
  assert.deepEqual(ok.calls, [['available', ['b1', 'b2']], ['active', ['a1']]], '슬롯의 모든 행을 끊고 대상을 연결');

  const fail = fakeDb('active'); // 연결 쓰기가 거절
  const r = await swapConnect(fail, victim, target);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'connect');
  assert.deepEqual(fail.calls[2], ['active', ['b1', 'b2']], '멈춘 행을 되돌린다');
  assert.equal(r.rolledBack, false, '되돌리기도 같은 쓰기라 거절되면 rolledBack=false — 앱이 "멈춘 채 남음" 문구를 보인다');
});

test('배선 핀(분리 검수 HIGH-1) — 모든 연결 경로가 needVictimPick을 지난다: ws_id·slug 없는 행은 1건 읽어 채우고, 선택지는 App이 띄운다', () => {
  assert.match(app, /if \(await needVictimPick\(crew, channelId\)\) return 'picking';/, 'dispatchCrew(레일·채널 추가)가 쓰기 전에 묻는다');
  assert.match(app, /if \(res === 'picking'\) \{ later\.push\(/, '채널 추가는 선택지가 열린 에이전트를 "추가됨"으로 세지 않고, 첫 선택지에서 멈춰 남은 것을 안내한다');
  assert.ok(app.indexOf('{victimPick && (') > app.indexOf('{chSheet && channel && !orgBlocked && <ChannelSheet'), '선택 창은 채널 시트보다 뒤에 그려 위에 보인다');
  assert.doesNotMatch(readFileSync(new URL('../src/agent-pick.mjs', import.meta.url), 'utf8'), /되돌리기도 실패|'row count'/, '사용자에게 보일 문구를 모듈에 고정하지 않는다(다국어)');
  assert.match(app, /if \(r === 'picking'\) return;/, '레일은 선택지가 열리면 "연결했어요" 안내를 띄우지 않는다');
  assert.match(app, /if \(channelId\) \{ const j = await supabase\.rpc\('msgr_crew_join', \{ ch: channelId, crew: target\.id \}\)/, '고른 뒤 교체하면 원래 넣으려던 채널에도 넣는다');
  assert.match(app, /if \(next && onNeedVictimPick && await onNeedVictimPick\(crew\)\)/, '에이전트 카드가 쓰기 전에 묻는다');
  assert.match(app, /if \(!row\?\.ws_id \|\| !row\?\.slug\)/, 'ws_id·slug가 없는 행을 가려 낸다');
  assert.match(app, /supabase\.from\('msgr_crews'\)\.select\('id, ws_id, slug, display_name'\)\.eq\('id', row\.id\)/, '없으면 1건 읽어 채운다 — p_ws undefined로 미리 보기가 죽는 일이 없게');
  assert.match(app, /setVictimPick\(\{ target: full, channelId, slots: slotState\(rows, uid\)\.slots\.filter/, '선택지는 연결된 슬롯으로 채운다(넣으려던 채널을 기억)');
  assert.match(app, /\{victimPick && \(/, '선택지는 App이 띄운다(모든 경로 공용)');
});

test('readMyPlan — pro/trial/free만 값으로, 실패·모름은 이전 값(초기 null)', async () => {
  const pro = { rpc: async () => ({ data: { plan: 'pro' }, error: null }) };
  assert.equal(await readMyPlan(pro, 1000), 'pro');
  const weird = { rpc: async () => ({ data: { plan: 'enterprise??' }, error: null }) };
  assert.equal(await readMyPlan(weird, 1000 + 400_000), 'pro', '모르는 값은 이전 값 유지');
  const down = { rpc: async () => ({ data: null, error: new Error('net') }) };
  assert.equal(await readMyPlan(down, 1000 + 800_000), 'pro', '오류도 이전 값');
});

