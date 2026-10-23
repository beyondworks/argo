// 재공개 전 검수 F1(클라이언트)·F3 — 에이전트 사용 범위가 방에 넣을 때 덮어써지지 않고 v2에서 저장되는가, 결제 링크가 앱 안에서도 열리는가.
// 행동: src/v2/seat.mjs를 가짜 rpc로 부른다. 연결: App.jsx·aplus가 그 함수를 실제로 쓰는지(옛 'all' 덮어쓰기 호출이 남지 않았는지)를 함께 본다.
// 화면 확인은 v2 셸 픽스처(PR 본문 화면 절) — 픽스처의 msgr2_set_seat도 실제 서버처럼 allow·users를 쓰게 고쳤다(종전 가짜는 p_allow를 무시해 이 결함을 못 잡았다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seatEnsure, seatRecall, seatSaveScope } from '../src/v2/seat.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const spy = () => { const calls = []; const rpc = async (name, args) => { calls.push([name, args]); return { data: name === 'msgr2_seat_ensure' ? 'kept' : null, error: null }; }; return { calls, rpc }; };

test('방에 넣기·다시 파견 = msgr2_seat_ensure — 범위(p_allow)를 보내지 않는다', async () => {
  const { calls, rpc } = spy();
  await seatEnsure(rpc, 'ag', 'sp');
  assert.deepEqual(calls, [['msgr2_seat_ensure', { p_agent: 'ag', p_space: 'sp' }]]);
});

test('회수 = msgr2_set_seat p_remove(서버는 범위를 건드리지 않는다)', async () => {
  const { calls, rpc } = spy();
  await seatRecall(rpc, 'ag', 'sp');
  assert.deepEqual(calls, [['msgr2_set_seat', { p_agent: 'ag', p_space: 'sp', p_allow: 'all', p_remove: true }]]);
});

test('사용 범위 저장 = msgr2_seat_scope(allow, users) — 파견된 자리만(빠진 자리를 되살리지 않음, 검수 2차) — 나만·모두는 명단 비움, 지정한 사람은 중복 없이, 모르는 값은 보내지 않음', async () => {
  const { calls, rpc } = spy();
  await seatSaveScope(rpc, 'ag', 'sp', 'owner', ['x']);
  await seatSaveScope(rpc, 'ag', 'sp', 'all');
  await seatSaveScope(rpc, 'ag', 'sp', 'list', ['u1', 'u2', 'u1']);
  const bad = await seatSaveScope(rpc, 'ag', 'sp', 'everyone', []);
  assert.deepEqual(calls, [
    ['msgr2_seat_scope', { p_agent: 'ag', p_space: 'sp', p_allow: 'owner', p_users: [] }],
    ['msgr2_seat_scope', { p_agent: 'ag', p_space: 'sp', p_allow: 'all', p_users: [] }],
    ['msgr2_seat_scope', { p_agent: 'ag', p_space: 'sp', p_allow: 'list', p_users: ['u1', 'u2'] }],
  ]);
  assert.equal(bad.error?.message, 'msgr2_bad_allow');
});

test('연결: App.jsx가 방에 넣기·파견·범위 저장에 seat.mjs를 쓰고, 옛 "all 덮어쓰기" 호출이 남지 않았다', () => {
  const app = read('../src/App.jsx');
  assert.doesNotMatch(app, /rpc\('msgr2_set_seat'/, '자리 RPC를 App.jsx에서 직접 부르지 않는다(seat.mjs 한 곳)');
  assert.match(app, /seatEnsure\(rawSupabase\.rpc\.bind\(rawSupabase\), crew\.id, orgId\)/, 'dispatchCrew(방에 넣기)');
  assert.match(app, /next \? seatEnsure\(rpc2, crew\.id, org\.id\) : seatRecall\(rpc2, crew\.id, org\.id\)/, 'CrewSheet 파견·회수');
  assert.match(app, /seatSaveScope\(rawSupabase\.rpc\.bind\(rawSupabase\), crew\.id, org\.id, nextAllow, nextList\)/, 'CrewSheet 사용 범위 저장(v2)');
});

test('F3 연결: Pro 업그레이드 링크는 openExternalUrl로 연다(Tauri 웹뷰는 target=_blank를 무시한다) — aplus의 새 창 링크가 모두 앱 오프너를 거친다', () => {
  for (const f of ['../src/aplus/APlusApp.jsx', '../src/aplus/People.jsx']) {
    const src = read(f);
    const at = [...src.matchAll(/target="_blank"/g)].map((m) => m.index); // 태그 안의 onClick에 `=>`가 있어 `>`로 태그를 자를 수 없다 — 속성 뒤 한 줄을 본다
    assert.ok(at.length >= 1, `${f}: 링크가 있다(전제)`);
    for (const i of at) assert.match(src.slice(i, src.indexOf('\n', i)), /^target="_blank" rel="[a-z ]+" onClick=\{\(e\) => \{ e\.preventDefault\(\); openExternalUrl\(/, `${f}: ${src.slice(i, i + 80)}`);
  }
});

test('v2 범위 단추는 파견된 에이전트에만 — 파견 안 됐으면 안내(검수 2차: 해제한 자리를 범위 저장이 되살리지 않게)', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /V2 && !dispatched \? <p className="note">\{t\('crew\.allow\.needDispatch'\)\}/);
});
