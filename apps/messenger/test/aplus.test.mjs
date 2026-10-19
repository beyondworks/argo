// 메신저 축소판 A+(2026-10-19) 화면 판단·문구·진입점·요청 예산. 화면 캡처는 test/aplus.fixture.html(가짜 원본)로 따로 남긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessOf, agentRows, togglePick, meetingDraftProblem, meetingView, botAddressProblem, botDraftProblem, botStatusOf, layoutOf, notOpenYet, MEETING_MAX, MEETING_ROUNDS } from '../src/aplus/model.mjs';
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

test('외부 봇 주소(R8): 루프백·Tailscale만, 공개·사설 LAN·주소 안 계정·다른 스킴은 거부', () => {
  for (const ok of ['http://127.0.0.1:8642', 'http://localhost:18789/v1', 'http://[::1]:8642', 'https://100.64.0.1', 'http://100.127.255.254:8642', 'http://home-pc.tail1234.ts.net:18789']) assert.equal(botAddressProblem(ok), null, ok);
  assert.equal(botAddressProblem('https://hermes.example.com'), 'public');
  assert.equal(botAddressProblem('http://192.168.0.10:8642'), 'public', '집 LAN도 Tailscale이 아니면 거부(공개 노출 경로)');
  assert.equal(botAddressProblem('http://100.128.0.1'), 'public', '100.64/10 밖');
  assert.equal(botAddressProblem('http://127.0.0.1.example.com'), 'public');
  assert.equal(botAddressProblem('http://user:key@127.0.0.1:8642'), 'userinfo');
  assert.equal(botAddressProblem('ws://127.0.0.1:8642'), 'scheme');
  assert.equal(botAddressProblem('127.0.0.1:8642'), 'invalid', 'http:// 없이 — 형식 안내(예: http://127.0.0.1:8642)');
  assert.equal(botAddressProblem('not a url'), 'invalid');
  assert.equal(botDraftProblem({ kind: 'hermes', name: 'x', address: 'https://evil.example' }), 'addr.public');
  assert.equal(botDraftProblem({ kind: 'other', name: 'x', address: 'http://127.0.0.1' }), 'kind');
  assert.equal(botDraftProblem({ kind: 'openclaw', name: ' ', address: 'http://127.0.0.1' }), 'name');
});

test('봇 상태: 연결됨·꺼짐·확인 못 함(모르는 값)', () => {
  assert.equal(botStatusOf({ status: 'connected' }), 'connected');
  assert.equal(botStatusOf({ status: 'disconnected' }), 'off');
  assert.equal(botStatusOf({ status: 'weird' }), 'unknown');
  assert.equal(botStatusOf(null), 'unknown');
});

test('배치: 640 미만은 한 칸(390), 그 이상은 목록+대화(880·1280)', () => {
  assert.equal(layoutOf(390), 'phone'); assert.equal(layoutOf(880), 'split'); assert.equal(layoutOf(1280), 'split');
});

test('아직 안 열린 기능(서버 스위치)은 오류가 아니라 닫힘으로', () => {
  assert.equal(notOpenYet({ code: 'aplus_not_ready' }), true);
  assert.equal(notOpenYet({ code: 'PGRST202', message: 'Could not find the function' }), true);
  assert.equal(notOpenYet({ message: 'Failed to fetch' }), false);
});

test('문구: A+ 화면이 쓰는 ap.* 키는 사전에 ko·en 둘 다 있다(고정 키 + 조립 키)', () => {
  const src = read('../src/aplus/APlusApp.jsx');
  const fixed = [...src.matchAll(/t\('(ap\.[a-zA-Z0-9.]+)'/g)].map((m) => m[1]);
  const built = [
    ...['dm', 'meet', 'bots', 'me'].flatMap((k) => [`ap.tab.${k}`]), ...['dm', 'meet', 'bots'].map((k) => `ap.empty.${k}`),
    ...['idle', 'running', 'done', 'cancelled', 'cancelling', 'failed'].map((s) => `ap.run.${s}`),
    ...['fewAgents', 'title', 'titleLong', 'dup', 'min', 'max'].map((s) => `ap.meet.problem.${s}`),
    ...['hermes', 'openclaw'].map((k) => `ap.bots.kind.${k}`), ...['connected', 'off', 'unknown'].map((s) => `ap.bots.status.${s}`),
    ...['invalid', 'scheme', 'userinfo', 'public'].map((s) => `ap.bots.problem.addr.${s}`),
  ];
  const missing = [...new Set([...fixed, ...built])].filter((k) => !Array.isArray(DICT[k]) || !DICT[k][0] || !DICT[k][1]);
  assert.deepEqual(missing, []);
  assert.ok(fixed.length > 50, `고정 키 ${fixed.length}개`);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), />[^<>{}]*[가-힣][^<>{}]*</, '화면 원본에 한글을 직접 쓰지 않는다(사전으로)');
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

test('외부 봇 키: 메신저에는 키 입력 칸이 없다(키는 내 PC Argo에만 — 안내 문구만)', () => {
  const ui = read('../src/aplus/APlusApp.jsx');
  const sheet = ui.slice(ui.indexOf('function BotSheet'));
  assert.doesNotMatch(sheet, /type="password"|apiKey|setKey|token\b/);
  assert.match(sheet, /t\('ap\.bots\.key\.title'\)/);
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
