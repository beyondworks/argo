// 메신저 축소판 A+(2026-10-19) 화면 판단·문구·진입점·요청 예산. 화면 캡처는 test/aplus.fixture.html(가짜 원본)로 따로 남긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessOf, agentRows, togglePick, meetingDraftProblem, meetingView, meetingPickable, deriveRun, runStateOf, effectiveState, afterCancel, errorKey, limitKey, botStatusOf, layoutOf, notOpenYet, MEETING_MAX, MEETING_ROUNDS } from '../src/aplus/model.mjs';
import { aplusEnabled, APLUS_FLAG_KEY } from '../src/aplus/flag.mjs';
import { createFakeSource } from '../src/aplus/fake.mjs';
import { DICT } from '../src/i18n.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const store = (v) => ({ getItem: (k) => (k === APLUS_FLAG_KEY ? v : null) });

test('플래그: 값이 정확히 1일 때만 켠다(빌드 env 또는 이 기기), 막힌 저장소는 꺼짐', () => {
  assert.equal(aplusEnabled('1', null), true);
  assert.equal(aplusEnabled(undefined, store('1')), true);
  assert.equal(aplusEnabled('true', store('yes')), false);
  assert.equal(aplusEnabled(undefined, { getItem: () => { throw new Error('blocked'); } }), false);
});

test('플랜 → 화면: pro·trial은 열림, free는 Pro 안내, 모름(실패)은 다시 확인', () => {
  assert.equal(accessOf('pro'), 'open'); assert.equal(accessOf('trial'), 'open');
  assert.equal(accessOf('free'), 'free'); assert.equal(accessOf(null), 'unknown'); assert.equal(accessOf('team'), 'unknown');
});

test('1:1 목록: 내 에이전트만, 은퇴는 숨기고 멈춤은 표시, 최근 대화 순 → 이름순', () => {
  const agents = [
    { id: 'a', owner_user_id: 'me', display_name: '나중', status: 'active' },
    { id: 'b', owner_user_id: 'me', display_name: '가장', status: 'paused' },
    { id: 'c', owner_user_id: 'me', display_name: '은퇴', status: 'retired' },
    { id: 'd', owner_user_id: 'other', display_name: '남의 것', status: 'active' },
    { id: 'e', owner_user_id: 'me', display_name: '최근', status: 'active' },
  ];
  const rows = agentRows(agents, { uid: 'me', rooms: { e: { roomId: 'r-e', at: 100, unread: 2 } } });
  assert.deepEqual(rows.map((r) => r.id), ['e', 'b', 'a']);
  assert.equal(rows[0].roomId, 'r-e'); assert.equal(rows[0].unread, 2);
  assert.equal(rows.find((r) => r.id === 'b').paused, true);
  assert.deepEqual(agentRows([], { uid: 'me' }), [], '에이전트 0명 — 빈 목록(화면은 만드는 법 안내)');
});

test('회의 참가자: 최대 5명에서 더 넣지 않고(capped), 빼기는 언제나', () => {
  let p = [];
  for (const id of ['1', '2', '3', '4', '5']) p = togglePick(p, id).picked;
  assert.equal(p.length, MEETING_MAX);
  const over = togglePick(p, '6'); assert.equal(over.capped, true); assert.deepEqual(over.picked, p);
  assert.deepEqual(togglePick(p, '3').picked, ['1', '2', '4', '5']);
});

test('회의 만들기 입력: 에이전트 2명 미만이면 만들 수 없음, 이름·인원(2~5)·중복', () => {
  assert.equal(meetingDraftProblem({ title: 'x', picked: ['a'], available: 1 }), 'fewAgents');
  assert.equal(meetingDraftProblem({ title: ' ', picked: ['a', 'b'], available: 3 }), 'title');
  assert.equal(meetingDraftProblem({ title: 'x'.repeat(61), picked: ['a', 'b'], available: 3 }), 'titleLong');
  assert.equal(meetingDraftProblem({ title: 'x', picked: ['a'], available: 3 }), 'min');
  assert.equal(meetingDraftProblem({ title: 'x', picked: ['a', 'a'], available: 3 }), 'dup');
  assert.equal(meetingDraftProblem({ title: 'x', picked: ['a', 'b', 'c', 'd', 'e', 'f'], available: 6 }), 'max');
  assert.equal(meetingDraftProblem({ title: '주간 점검', picked: ['a', 'b', 'c', 'd', 'e'], available: 6 }), null);
});

test('회의 진행 줄: 라운드는 1..2로 자르고, 진행 중에만 취소·보내기 막힘, 취소 중에도 보내기 막힘', () => {
  assert.deepEqual(meetingView(null), { state: 'idle', canCancel: false, canSend: true });
  const run = meetingView({ state: 'running', round: 1, answered: 2, total: 3 });
  assert.equal(run.canCancel, true); assert.equal(run.canSend, false); assert.equal(run.rounds, MEETING_ROUNDS);
  assert.equal(meetingView({ state: 'running', round: 4, answered: 9, total: 9 }).round, 2, '서버가 4를 줘도 2를 넘겨 그리지 않는다');
  assert.equal(meetingView({ state: 'running', round: 1, answered: 9, total: 9 }).total, MEETING_MAX);
  assert.equal(meetingView({ state: 'cancelling' }).canSend, false);
  assert.equal(meetingView({ state: 'cancelled' }).canSend, true);
  assert.equal(meetingView({ state: 'done', round: 2 }).canCancel, false);
  assert.equal(meetingView({ state: '???' }).state, 'failed');
});

test('회의 참가자로 고를 수 있는 에이전트: 멈춤·외부 봇 제외(서버 msgr2_meeting_no_bot)', () => {
  assert.equal(meetingPickable({ paused: false, bot: false }), true);
  assert.equal(meetingPickable({ paused: true, bot: false }), false);
  assert.equal(meetingPickable({ paused: false, bot: true }), false);
  const rows = agentRows([{ id: 'b', owner_user_id: 'me', display_name: '헤르메스', status: 'active', hosting: 'bot' }], { uid: 'me' });
  assert.equal(rows[0].bot, true, '봇도 1:1 목록에는 보인다(약속 v1.1 kind bot)');
});

test('회의 진행 계산: 그 일(workId)의 글 meta.round 최대값과 그 라운드에 답한 에이전트 수, 일 상태 → 진행 상태', () => {
  const run = { workId: 'w1', state: 'running', total: 3 };
  assert.deepEqual(deriveRun(run, []), { ...run, round: 1, answered: 0 });
  const msgs = [{ workId: 'w0', round: 2, author: 'a' }, { workId: 'w1', round: 1, author: 'a' }, { workId: 'w1', round: 1, author: 'b' }, { workId: 'w1', round: 1, author: 'c' }, { workId: 'w1', round: 2, author: 'a' }];
  assert.deepEqual(deriveRun(run, msgs), { ...run, round: 2, answered: 1 }, '다른 일(w0)의 글은 세지 않는다');
  assert.deepEqual(deriveRun({ state: 'running', round: 1, answered: 2, total: 3 }, msgs), { state: 'running', round: 1, answered: 2, total: 3 }, 'workId 없으면 주어진 값');
  assert.equal(runStateOf('accepted'), 'running'); assert.equal(runStateOf('awaiting_approval'), 'running', '서버 이름(awaiting_approval)');
  assert.equal(runStateOf('stalled'), 'failed'); assert.equal(runStateOf('expired'), 'failed');
  assert.equal(runStateOf('done'), 'done'); assert.equal(runStateOf('cancelled'), 'cancelled'); assert.equal(runStateOf('expired'), 'failed'); assert.equal(runStateOf(null), null);
});

test('서버 거부·봇 오류 코드 → 문구 키(#1117·#1116), 상한 안내 글(meta.limit) → 문구 키', () => {
  for (const c of ['msgr2_lite_only', 'msgr2_meeting_full', 'msgr2_meeting_no_bot', 'msgr2_pro_required', 'bot_unreachable', 'bot_limit']) assert.equal(errorKey({ code: '42501', message: c }), `aplus.err.${c}`, c);
  assert.equal(errorKey('bot_limit'), 'aplus.err.bot_limit');
  assert.equal(errorKey({ message: 'Failed to fetch' }), null);
  for (const l of ['pro', 'need_update', 'bot_turns', 'bot_hops', 'agent_minute', 'streak']) assert.equal(limitKey({ code: 'work.limit', limit: l }), `aplus.limit.${l}`);
  assert.equal(limitKey({ code: 'work.limit', limit: 'new_one' }), 'aplus.limit.other', '모르는 상한도 안내는 한다');
  assert.equal(limitKey({ code: 'room.created' }), null);
});

test('봇 상태: 연결됨·꺼짐·확인 못 함(모르는 값)', () => {
  assert.equal(botStatusOf({ status: 'connected' }), 'connected');
  assert.equal(botStatusOf({ status: 'disconnected' }), 'off');
  assert.equal(botStatusOf({ status: 'weird' }), 'unknown');
  assert.equal(botStatusOf(null), 'unknown');
  assert.equal(botStatusOf({ lastWork: { state: 'failed', error_code: 'bot_unreachable' } }), 'off', '마지막 일이 연결 실패면 꺼짐');
  assert.equal(botStatusOf({ lastWork: { state: 'done' } }), 'connected');
  assert.equal(botStatusOf({ lastWork: { state: 'failed', error_code: 'bot_limit' } }), 'unknown');
});

test('배치: 640 미만은 한 칸(390), 그 이상은 목록+대화(880·1280)', () => {
  assert.equal(layoutOf(390), 'phone'); assert.equal(layoutOf(880), 'split'); assert.equal(layoutOf(1280), 'split');
});

test('아직 안 열린 기능(서버 스위치)은 오류가 아니라 닫힘으로', () => {
  assert.equal(notOpenYet({ code: 'aplus_not_ready' }), true);
  assert.equal(notOpenYet({ code: 'PGRST202', message: 'Could not find the function' }), true);
  assert.equal(notOpenYet({ code: '42703', message: 'column msgr2_rooms.meeting does not exist' }), true, '#1117 전 서버');
  assert.equal(notOpenYet({ message: 'Failed to fetch' }), false);
});

test('문구: A+ 화면이 쓰는 aplus.* 키는 사전에 ko·en 둘 다 있다(고정 키 + 조립 키)', () => {
  const src = read('../src/aplus/APlusApp.jsx');
  const fixed = [...src.matchAll(/t\('(aplus\.[a-zA-Z0-9.]+)'/g)].map((m) => m[1]);
  const built = [
    ...['dm', 'meet', 'bots', 'me'].flatMap((k) => [`aplus.tab.${k}`]), ...['dm', 'meet', 'bots'].map((k) => `aplus.empty.${k}`),
    ...['idle', 'running', 'done', 'cancelled', 'cancelling', 'failed'].map((s) => `aplus.run.${s}`),
    ...['fewAgents', 'title', 'titleLong', 'dup', 'min', 'max'].map((s) => `aplus.meet.problem.${s}`),
    ...['hermes', 'openclaw', 'bot'].map((k) => `aplus.bots.kind.${k}`), ...['connected', 'off', 'unknown'].map((s) => `aplus.bots.status.${s}`),
    ...['s1', 's2', 's3', 's4'].map((k) => `aplus.bots.guide.${k}`),
    ...['msgr2_lite_only', 'msgr2_meeting_full', 'msgr2_meeting_no_bot', 'msgr2_pro_required', 'msgr2_meeting_agents', 'msgr2_agent_not_allowed', 'bot_unreachable', 'bot_limit'].map((c) => `aplus.err.${c}`),
    ...['pro', 'need_update', 'bot_turns', 'bot_hops', 'agent_minute', 'streak', 'other'].map((l) => `aplus.limit.${l}`),
  ];
  const missing = [...new Set([...fixed, ...built])].filter((k) => !Array.isArray(DICT[k]) || !DICT[k][0] || !DICT[k][1]);
  assert.deepEqual(missing, []);
  assert.ok(fixed.length > 50, `고정 키 ${fixed.length}개`);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), />[^<>{}]*[가-힣][^<>{}]*</, '화면 원본에 한글을 직접 쓰지 않는다(사전으로)');
});

test('진입점: A+ 셸에는 채널·조직·파견·사람 채팅·초대 화면이 없고, 옛 RPC를 부르지 않는다', () => {
  const ui = read('../src/aplus/APlusApp.jsx'); const src = read('../src/aplus/source.mjs');
  for (const word of ['channel', 'Channel', 'org', 'dispatch', 'friend', 'invite', 'seat']) assert.doesNotMatch(ui.replace(/\/\/.*$/gm, ''), new RegExp(`\\b${word}`), word);
  assert.doesNotMatch(src, /'msgr_(?!.*my_plan)[a-z_]+'/, '옛 msgr_* 표·RPC 없음(my_plan만)');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /set_seat|room_members_add|invite|friend/);
});

test('쉬는 동안 요청 0: A+ 원본·화면에 주기 조회가 없다(setInterval 없음)', () => {
  for (const f of ['../src/aplus/APlusApp.jsx', '../src/aplus/source.mjs', '../src/aplus/model.mjs']) assert.doesNotMatch(read(f), /setInterval/, f);
});

test('외부 봇: 메신저에는 주소·키 입력 칸이 없다(내 PC Argo 설정에서 연결 — 약속 v1.1, 서버에 주소·키 없음)', () => {
  const ui = read('../src/aplus/APlusApp.jsx');
  const guide = ui.slice(ui.indexOf('function BotGuide'));
  assert.doesNotMatch(guide, /<input|type="password"|apiKey|address/);
  assert.match(guide, /t\('aplus\.bots\.key\.title'\)/);
  assert.doesNotMatch(read('../src/aplus/source.mjs'), /addBot|bot_url|api_key/i);
});

test('A+ 원본은 앱 앞·뒤 연결(bindLifecycle)을 기계에 걸고 stop에서 푼다(분리 검수 — 뒤로 가면 소켓 닫음, 앞으로 오면 다시 붙음)', () => {
  const src = read('../src/aplus/source.mjs');
  assert.match(src, /offs\.push\(bindLifecycle\(rt\.machine\)\)/);
  assert.match(src, /stop\(\) \{ for \(const off of offs\.splice\(0\)\) off\(\);/);
  assert.match(src, /retry\(\) \{ if \(rt && gaveUpOf\(rt\.machine\.getSnapshot\(\)\)\) rt\.retry\(\); \}/);
});

test('가짜 원본: 무료 시나리오에서 plan 말고는 부르지 않는 흐름의 재료(plan → free)', async () => {
  const s = createFakeSource({ scenario: 'free' });
  assert.equal(accessOf(await s.plan()), 'free');
  assert.deepEqual(s.calls, ['plan']);
  await assert.rejects(createFakeSource({ scenario: 'closed' }).meetings(), (e) => notOpenYet(e));
});

test('App 배선: A+ 플래그는 v2가 켜진 때만, 켜지면 Shell 대신 APlusRoot, 꺼지면 지금 셸 그대로', () => {
  const app = read('../src/App.jsx');
  assert.match(app, /const APLUS = V2 && aplusEnabled\(/);
  assert.match(app, /body = APLUS \? <APlusRoot key=\{session\.user\.id\} session=\{session\} onSignOut=\{signOut\} \/> : <Shell key=\{session\.user\.id\} session=\{session\} \/>;/);
  assert.match(app, /function APlusRoot\(/);
  assert.match(app, /bindV2Push\(\{ machine: source\.machine\(\), getToken: getPushToken, observeResume: observeMobileResume \}\)/, 'A+에서도 휴대폰 토큰을 싣는다(R3)');
});

test('재검수(높음): 일의 지금 상태는 서버 _msgr2_effective_state와 같게 — 기한 지난 offered·리스 끝난 일은 끝남(입력이 영구히 막히지 않음)', () => {
  const now = Date.parse('2026-10-20T00:00:00Z'); const past = '2026-10-19T23:00:00Z'; const future = '2026-10-20T01:00:00Z';
  assert.equal(effectiveState({ state: 'offered', expires_at: past }, now), 'expired');
  assert.equal(effectiveState({ state: 'offered', expires_at: future }, now), 'offered');
  assert.equal(effectiveState({ state: 'running', lease_until: past, has_result: false }, now), 'stalled');
  assert.equal(effectiveState({ state: 'awaiting_approval', lease_until: past, has_result: false }, now), 'stalled');
  assert.equal(effectiveState({ state: 'running', lease_until: past, has_result: true }, now), 'running', '결과가 있으면 stalled 아님(서버와 같음)');
  assert.equal(effectiveState({ state: 'accepted', lease_until: null, has_result: false }, now), 'accepted', '리스 null은 서버 not(null>now)=null → stalled 아님');
  assert.equal(meetingView({ state: runStateOf(effectiveState({ state: 'offered', expires_at: past }, now)) }).canSend, true);
});

test('재검수: 회의 취소는 RPC가 돌려준 상태로 바로 바꾼다(이미 끝난 일은 방송이 없어 cancelling에 갇혔다)', () => {
  const src = read('../src/aplus/source.mjs');
  assert.match(src, /st = ok\(await raw\.rpc\('msgr2_work_cancel'/);
  assert.match(src, /state: afterCancel\(st\)/);
  for (const [st, want] of [['cancelled', 'cancelled'], ['expired', 'failed'], ['done', 'done'], ['failed', 'failed']]) {
    assert.equal(afterCancel(st), want, st);
    assert.equal(meetingView({ state: afterCancel(st) }).canSend, true, `${st} 뒤에는 다시 보낼 수 있다`);
  }
  assert.match(src, /select\('id, room_id, state, created_at, expires_at, lease_until, has_result'\)/);
});
