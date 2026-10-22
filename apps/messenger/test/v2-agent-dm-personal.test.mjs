// 2026-10-22 결함: v2 셸에서 조직 레일의 내 에이전트를 누르면(#1135로 기본 동작) 개인 공간의 그 에이전트 1:1이 아니라 팀 공간에 비공개 방이 새로 생겼다.
// 원인: personalTwin이 옛 모델(조직별 msgr_crews 쌍둥이 행·msgr_personal_room_crews)로 찾아 v2에서 늘 null → msgr_create_channel(v2 msgr2_room_create).
// 기대(유건 2026-10-03 "에이전트 = 한 사람", 10-13): 내 에이전트 1:1은 개인 공간 하나 — 조직에서 눌러도 그 방을 연다(서버 msgr2_agent_dm_open이 열거나 만든다).
// 화면은 픽스처(test/v2-shell.fixture.html?space=team)에서 레일 탭·우클릭 '개인 1:1 대화'·카드 시트 단추 세 입구 모두 msgr2_room_create 0·msgr2_agent_dm_open 1을 확인했다(PR 본문).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v2PersonalTwin } from '../src/agent-groups.mjs';
import { LEGACY_RPCS } from '../src/v2/legacy-rpc.mjs';

const ME = 'u-me';

test('v2PersonalTwin: 내 에이전트는 그 자신(같은 id), 남의 에이전트·모르는 행은 null', () => {
  assert.deepEqual(v2PersonalTwin({ id: 'ag-1', owner_user_id: ME }, ME), { id: 'ag-1' });
  assert.equal(v2PersonalTwin({ id: 'ag-2', owner_user_id: 'u-other' }, ME), null, '남의 에이전트 — 종전대로 주인과의 1:1');
  assert.equal(v2PersonalTwin(null, ME), null);
  assert.equal(v2PersonalTwin({ id: 'ag-1', owner_user_id: ME }, null), null, '로그인 전');
});

test('개인 1:1 열기(msgr_dm_personal_crew)는 v2에서 msgr2_agent_dm_open 하나 — 방 만들기(msgr2_room_create)를 부르지 않는다', async () => {
  const calls = [];
  const c = { call: async (fn, args) => { calls.push([fn, args]); return { data: { room_id: 'r-dm' }, error: null }; }, forget: () => {} };
  const r = await LEGACY_RPCS.msgr_dm_personal_crew(c, { crew: 'ag-1' });
  assert.deepEqual(calls, [['msgr2_agent_dm_open', { p_agent: 'ag-1' }]]);
  assert.equal(r.data, 'r-dm');
});

test('App 배선: v2는 personalTwin·dmGoesPersonal이 v2PersonalTwin(조회 없음), 옛 경로는 그대로', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const personalTwin = \(c\) => V2 \? Promise\.resolve\(v2PersonalTwin\(c, uid\)\)[^\n]*: personalRoomFor\(c, \{ uid,/);
  assert.match(app, /const dmGoesPersonal = \(c\) => !isPersonal && \(V2 \? !!v2PersonalTwin\(c, uid\) : personalRoomKnown\(c, myAgents, uid\)\);/);
  const open = app.slice(app.indexOf('  const openDm = async (kind, id'), app.indexOf('  const toPersonalTwin = '));
  const iTwin = open.indexOf("if (kind === 'crew' && crewOf(id)?.owner_user_id === uid) {"), iCreate = open.indexOf("supabase.rpc('msgr_create_channel'");
  assert.ok(iTwin > 0 && iCreate > iTwin, '내 에이전트는 방 만들기 전에 개인 1:1로 돌린다');
  assert.ok(open.includes('if (twin) { toPersonalTwin(crew, twin, { text, source: opts.source, here, hereCh }); return null; }'));
});
