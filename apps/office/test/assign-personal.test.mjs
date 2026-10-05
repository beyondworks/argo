// 10/5 연결성 CX-03 — 오피스에서 내 에이전트에게 맡기면 메신저 '에이전트' 탭이 여는 그 방(개인 공간 1:1)으로 간다.
// 메신저 agent-groups.mjs agentRoomTarget과 같은 규칙: 내 에이전트의 개인 행이 있으면 개인 1:1, 봇 쌍둥이는 서버가 준비됐다고 할 때만, 아니면 종전 조직 1:1.
// DB 호출은 가짜로 바꿔 끼우고 분기를 잠근다(test/crew-assign.test.mjs와 같은 가짜). 서버 함수 계약(msgr_dm_personal_crew)은 메신저 드릴이 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/core/crew-assign.js';
// 이름공간으로 가져온다 — 고치기 전 코드(assignTarget 없음)에서도 파일이 열리고 시험마다 따로 실패하게
const deliverToCrew = (...a) => A.deliverToCrew(...a), assignTarget = (...a) => A.assignTarget(...a);

const ME = 'me', ORG = 'org', CREW = 'crew-1', TWIN = 'twin-1';
const fakeDb = ({ rpc = {}, channels = [], members = [] } = {}) => {
  const calls = [];
  const answer = { msgr_org_locked: false, msgr_org_entitled: true, msgr_instruct_check: 'ok', msgr_my_ai_consent: '2026-09-29T00:00:00Z', msgr_create_channel: 'org-ch', msgr_dm_personal_crew: 'personal-ch', msgr_personal_room_crews: [], ...rpc };
  return { calls, rpc: async (fn, args) => { calls.push([fn, args]); const v = answer[fn]; if (v instanceof Error) throw v; return v; },
    myChannels: async () => channels, members: async () => members, insert: async (row) => { calls.push(['insert', row]); } };
};
const job = { owner: ME, orgId: ORG, crewId: CREW, personalId: TWIN, crewName: '페퍼', body: '요약해 주세요', meta: { source: 'office_mail' }, clientId: 'c-1' };
const called = (db, fn) => db.calls.filter(([f]) => f === fn);

test('CX-03: 개인 행이 있는 내 에이전트는 개인 1:1(msgr_dm_personal_crew)로 — 조직 잠금·자격·조직 1:1은 건드리지 않는다', async () => {
  const db = fakeDb();
  assert.equal(await deliverToCrew(db, job), 'personal');
  assert.deepEqual(called(db, 'msgr_dm_personal_crew')[0][1], { crew: TWIN });
  assert.deepEqual(called(db, 'msgr_instruct_check')[0][1], { crew: TWIN, author: ME, channel: null }, '권한은 개인 행 기준(서버 게이트웨이가 보는 행)');
  assert.equal(called(db, 'insert')[0][1].channel_id, 'personal-ch');
  for (const fn of ['msgr_org_locked', 'msgr_org_entitled', 'msgr_create_channel']) assert.equal(called(db, fn).length, 0, fn);
});

test('CX-03: 봇 쌍둥이는 서버가 준비됐다고 할 때만 개인 1:1, 아니면 종전 조직 1:1(답이 없는 방으로 보내지 않는다)', async () => {
  const notReady = fakeDb({ rpc: { msgr_personal_room_crews: [{ id: TWIN, ready: false }] } });
  assert.equal(await deliverToCrew(notReady, { ...job, personalBot: true }), 'sent');
  assert.equal(called(notReady, 'msgr_dm_personal_crew').length, 0);
  assert.equal(called(notReady, 'insert')[0][1].channel_id, 'org-ch');
  const ready = fakeDb({ rpc: { msgr_personal_room_crews: [{ id: TWIN, ready: true }] } });
  assert.equal(await deliverToCrew(ready, { ...job, personalBot: true }), 'personal');
  const unknown = fakeDb({ rpc: { msgr_personal_room_crews: Object.assign(new Error('x'), { code: 'PGRST202' }) } });
  assert.equal(await deliverToCrew(unknown, { ...job, personalBot: true }), 'sent', '준비 상태를 모르면 개인 방으로 보내지 않는다');
});

test('CX-03: 개인 1:1도 보내기 전에 거절할 것은 거절한다(권한·AI 동의), 조직 행 없이 열 수 없으면 쓸 수 없음', async () => {
  for (const [rpc, reason] of [[{ msgr_instruct_check: 'inactive' }, 'not_allowed'], [{ msgr_my_ai_consent: null }, 'consent'],
    [{ msgr_dm_personal_crew: Object.assign(new Error('msgr_bad_member'), { code: '22023' }) }, 'not_allowed']]) {
    const db = fakeDb({ rpc });
    await assert.rejects(deliverToCrew(db, job), (e) => e.assign === reason && e.transient === false, reason);
    assert.equal(called(db, 'insert').length, 0, `${reason}인데 보냈다`);
  }
  const only = fakeDb({ rpc: { msgr_personal_room_crews: [] } });
  await assert.rejects(deliverToCrew(only, { ...job, orgId: null, crewId: null, personalBot: true }), (e) => e.assign === 'unavailable');
  assert.equal(await deliverToCrew(fakeDb(), { ...job, orgId: null, crewId: null }), 'personal', '조직이 없는 사람(개인 행뿐)도 맡길 수 있다(CX-01)');
});

test('CX-03: 맡길 곳 고르기 — 묶인 줄·조직 행·개인 행', () => {
  const spaces = [{ key: 'me', kind: 'me' }, { key: 'acme', kind: 'org', id: ORG }];
  const twin = { id: TWIN, personal: true, agent: 'A', space: 'me', hosting: 'local' };
  const orgRow = { id: CREW, space: 'acme', agent: 'A' };
  assert.deepEqual(assignTarget({ ...orgRow, twin: TWIN }, [orgRow, twin], spaces), { orgId: ORG, crewId: CREW, personalId: TWIN, personalBot: false }, '내 공간에서 묶인 줄');
  assert.deepEqual(assignTarget(orgRow, [orgRow, twin], spaces), { orgId: ORG, crewId: CREW, personalId: TWIN, personalBot: false }, '조직 공간에서 고른 조직 행도 같은 에이전트의 개인 1:1로');
  assert.deepEqual(assignTarget(twin, [twin], spaces), { orgId: null, crewId: null, personalId: TWIN, personalBot: false }, '개인 행뿐');
  assert.deepEqual(assignTarget({ id: 'x', space: 'acme', agent: 'x' }, [orgRow, twin], spaces), { orgId: ORG, crewId: 'x', personalId: null, personalBot: false }, '다른 에이전트의 개인 행은 고르지 않는다');
  assert.equal(assignTarget(orgRow, [orgRow, { ...twin, hosting: 'bot' }], spaces).personalBot, true);
});
