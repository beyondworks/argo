// 에이전트 일정 도구(calendar) — 명세 2026-09-30 규칙 9·10·DB 계약(office_event_list / office_event_write).
// DB 함수는 가짜 세션 클라이언트로 대신한다(라이브 DB·실벤더 호출 0). 세션 클라이언트 모양 = msgr.mjs sessionClient()의 { client, uid }.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-cal-tool-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { makeCrewServer } = await import('../src/chat.mjs');
const { crewToolSpecs, ensureRequired } = await import('../src/engine/native-query.mjs');
const { calendarTool, calendarDeps, resolveTimes, occurrences, kstMidnight } = await import('../src/gateway/office-calendar.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const ME = 'owner-uid'; const OTHER = 'other-uid'; const ORG = 'org-1';
const NOW = Date.parse('2026-10-01T10:00:00+09:00');
const realDeps = { ...calendarDeps };
after(() => Object.assign(calendarDeps, realDeps));

/** 가짜 세션 — rpc 호출을 기록하고, list는 주어진 행을 돌려준다(서버처럼 기간은 거르지 않는다 — 도구의 펼치기·거르기를 본다). */
function fakeSession(events = [], { error = null, uid = ME } = {}) {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (error) return { data: null, error: { message: error } };
    if (name === 'office_event_list') return { data: { events, orgs: [{ id: ORG, name: '린팀', role: 'member' }] }, error: null };
    const d = args.p_data;
    return { data: { ok: true, event: d.next ?? { ...d, owner: uid } }, error: null };
  } };
  return { calls, session: async () => ({ client, uid }) };
}
let idSeq = 0;
function use(fake) { Object.assign(calendarDeps, { session: fake.session, now: () => NOW, newId: () => `new-${++idSeq}` }); return fake; }
const msgrCtx = (extra = {}) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: ORG, channelId: 'ch-1', crewId: 'crew-1', uid: ME, wsId: 'w', origin: ME, ...extra });
const run = (args, opts = {}) => calendarTool(args, { crew: 'alpha', lang: 'ko', ownerId: ME, ...opts });
const ev = (over = {}) => ({ id: 'e1', org_id: null, owner: ME, owner_name: '나', crew: null, visibility: 'private', title: '치과', note: null, location: null, category: null,
  customer_id: null, all_day: false, starts_at: '2026-10-02T05:00:00.000Z', ends_at: '2026-10-02T06:00:00.000Z', attendees: [], rrule: null, exdates: [], parent_id: null, recur_on: null, can_edit: true, ...over });
const writes = (f) => f.calls.filter((c) => c.name === 'office_event_write');

test('C1. 종일 변환 = KST 자정 [첫날 00:00+09, 끝날 다음날 00:00+09), 시간대 없는 시각은 KST', () => {
  const t = resolveTimes({ start: '2026-10-02', end: '2026-10-04' }, { allDay: false, start: 0, end: 3600_000 });
  assert.equal(t.allDay, true);
  assert.equal(new Date(t.start).toISOString(), '2026-10-01T15:00:00.000Z');
  assert.equal(new Date(t.end).toISOString(), '2026-10-04T15:00:00.000Z', '끝날(10/4) 다음날 KST 자정');
  const one = resolveTimes({ start: '2026-10-02' }, { allDay: false, start: 0, end: 3600_000 });
  assert.equal(new Date(one.end).toISOString(), '2026-10-02T15:00:00.000Z', '하루짜리 종일');
  const timed = resolveTimes({ start: '2026-10-02T14:00', end: '15:30' }, { allDay: false, start: 0, end: 3600_000 });
  assert.equal(new Date(timed.start).toISOString(), '2026-10-02T05:00:00.000Z'); assert.equal(new Date(timed.end).toISOString(), '2026-10-02T06:30:00.000Z');
  const iso = resolveTimes({ start: '2026-10-02T14:00:00Z' }, { allDay: false, start: 0, end: 3600_000 });
  assert.equal(iso.end - iso.start, 3600_000, '끝이 없으면 1시간');
  assert.ok(resolveTimes({ start: '2026-10-02T14:00', end: '13:00' }, { allDay: false, start: 0, end: 1 }).error, '끝이 시작보다 앞이면 거절');
  assert.ok(Number.isNaN(kstMidnight('2026-02-30')), '없는 날짜');
});

test('C2. create — 쓰기 p_data에 crew가 붙고, 종일은 KST 자정, 개인 일정은 private·참석자 빈 배열', async () => {
  const f = use(fakeSession());
  const out = await run({ action: 'create', title: '워크숍', start: '2026-10-02', end: '2026-10-03' });
  const [w] = writes(f);
  assert.equal(w.args.p_action, 'save');
  assert.equal(w.args.p_data.crew, 'alpha', '모든 쓰기에 이 크루 id');
  assert.equal(w.args.p_data.org_id, null); assert.equal(w.args.p_data.visibility, 'private'); assert.deepEqual(w.args.p_data.attendees, []);
  assert.equal(w.args.p_data.all_day, true);
  assert.equal(w.args.p_data.starts_at, '2026-10-01T15:00:00.000Z'); assert.equal(w.args.p_data.ends_at, '2026-10-03T15:00:00.000Z');
  assert.match(w.args.p_data.id, /^new-/, '도구가 만든 id(멱등)');
  assert.match(out, /일정을 만들었다:\n--- 바깥 글 시작 \[cal-[0-9a-f]+\][^\n]*\n- 2026-10-02\(금\)~2026-10-03\(토\) 종일 · "워크숍" · 개인/, '일정 줄(제목·장소)은 바깥 글 경계 안에(S1)');
});

test('C3. 조직 캘린더 — 메신저 조직 문맥이면 그 조직·visibility 반영, 아니면 RPC 없이 거절하고 personal 안내', async () => {
  let f = use(fakeSession());
  assert.match(await run({ action: 'create', title: 'x', start: '2026-10-02T10:00', calendar: 'org' }), /calendar: "personal"/);
  assert.match(await run({ action: 'list', calendar: 'org' }), /조직 캘린더를 고를 수 없다/);
  assert.equal(f.calls.length, 0, '문맥 없는 org는 호출하지 않는다');
  f = use(fakeSession());
  await run({ action: 'create', title: '회의', start: '2026-10-02T10:00', calendar: 'org', visibility: 'private', repeat: 'weekly', repeat_interval: 2, repeat_until: '2026-12-31' }, { ctx: msgrCtx() });
  const d = writes(f)[0].args.p_data;
  assert.equal(d.org_id, ORG); assert.equal(d.visibility, 'private'); assert.equal(d.crew, 'alpha');
  assert.equal(d.rrule, 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231', '서버 check와 같은 모양');
});

test('C4. list — 62일 초과는 호출 없이 거절, 반복은 펼치고 exdates는 빼며, 조직 채널 턴에는 다른 조직 일정을 섞지 않는다', async () => {
  let f = use(fakeSession());
  assert.match(await run({ action: 'list', from: '2026-10-01', to: '2026-12-02' }), /62일까지만 볼 수 있다\(요청 63일\)/);
  assert.equal(f.calls.length, 0);
  await run({ action: 'list', from: '2026-10-01', to: '2026-12-01' }); assert.equal(f.calls.length, 1, '딱 62일은 허용');
  const weekly = ev({ id: 'w1', title: '주간회의', org_id: ORG, visibility: 'org', starts_at: '2026-09-03T01:00:00.000Z', ends_at: '2026-09-03T02:00:00.000Z', rrule: 'FREQ=WEEKLY', exdates: ['2026-10-08'] });
  const foreign = ev({ id: 'x1', title: '남의조직', org_id: 'org-2', visibility: 'org', owner: OTHER, owner_name: '김', can_edit: false });
  const theirs = ev({ id: 't1', title: '팀장 일정', org_id: ORG, visibility: 'org', owner: OTHER, owner_name: '박팀장', can_edit: false, starts_at: '2026-10-05T00:00:00.000Z', ends_at: '2026-10-05T01:00:00.000Z' });
  f = use(fakeSession([weekly, foreign, theirs, ev()]));
  const out = await run({ action: 'list', from: '2026-10-01', to: '2026-10-14' }, { ctx: msgrCtx() });
  const [call] = f.calls;
  assert.deepEqual(call.args, { p_from: '2026-09-30T15:00:00.000Z', p_to: '2026-10-14T15:00:00.000Z' }, '[from 00:00 KST, to 다음날 00:00 KST)');
  assert.match(out, /2026-10-01\(목\) 10:00–11:00 · "주간회의" · 조직 "린팀" · 반복 매주 · id=w1 회차=2026-10-01/);
  assert.doesNotMatch(out, /회차=2026-10-08/, 'exdates 회차 제외');
  assert.match(out, /— 3건/, '범위 안 회차만(10/1 회의·10/2 치과·10/5 팀장)'); assert.doesNotMatch(out, /회차=2026-10-15/);
  assert.doesNotMatch(out, /남의조직/, '조직 채널 턴에 다른 조직 일정 없음');
  assert.match(out, /"팀장 일정" · 조직 "린팀" · 읽기 전용\(주인 "박팀장"\)/);
  assert.match(out, /2026-10-02\(금\) 14:00–15:00 · "치과" · 개인/);
  assert.ok(occurrences(ev({ rrule: 'FREQ=MONTHLY', starts_at: '2026-01-30T15:00:00.000Z', ends_at: '2026-01-30T16:00:00.000Z' }), Date.parse('2026-02-01T00:00:00+09:00'), Date.parse('2026-04-01T00:00:00+09:00')).map((o) => o.day).join() === '2026-03-31', '매월 31일은 없는 달(2월)을 건너뛴다');
});

test('C5. 남의 일정 update·delete는 쓰기 RPC 없이 한 줄 거절(관리자 can_edit라도 주인이 아니면)', async () => {
  const theirs = ev({ id: 't1', org_id: ORG, visibility: 'org', owner: OTHER, owner_name: '박팀장', can_edit: true });
  for (const args of [{ action: 'update', id: 't1', day: '2026-10-02', title: '바꿈' }, { action: 'delete', id: 't1', day: '2026-10-02' }]) {
    const f = use(fakeSession([theirs]));
    assert.match(await run(args, { ctx: msgrCtx() }), /고치거나 지울 수 없다[^\n]*일정 주인:\n--- 바깥 글 시작[^\n]*\n"박팀장"\n--- 바깥 글 끝 /, '일정 주인 이름은 읽어 온 남의 글 — 거절 문장에서도 경계 블록 안에(검수 M2)');
    assert.deepEqual(f.calls.map((c) => c.name), ['office_event_list'], `${args.action}: 조회만, 쓰기 없음`);
  }
  const f = use(fakeSession([ev({ can_edit: false })]));
  assert.match(await run({ action: 'delete', id: 'e1', day: '2026-10-02' }), /고치거나 지울 수 없다/);
  assert.equal(writes(f).length, 0);
});

test('C6. 주인 일정 update·delete — 반복은 scope를 요구하고, this=skip·following=split·all=save/delete, 모두 crew 부착', async () => {
  const weekly = ev({ id: 'w1', title: '주간회의', starts_at: '2026-09-03T01:00:00.000Z', ends_at: '2026-09-03T02:00:00.000Z', rrule: 'FREQ=WEEKLY' });
  let f = use(fakeSession([weekly]));
  assert.match(await run({ action: 'delete', id: 'w1', day: '2026-10-01' }), /scope를 정해/); assert.equal(writes(f).length, 0);
  assert.match(await run({ action: 'delete', id: 'w1', day: '2026-10-02', scope: 'this' }), /회차가 아니다/, '목요일 반복의 금요일');
  await run({ action: 'delete', id: 'w1', day: '2026-10-01', scope: 'this' });
  assert.deepEqual(writes(f)[0].args, { p_action: 'skip', p_data: { id: 'w1', day: '2026-10-01', crew: 'alpha' } });

  f = use(fakeSession([weekly]));
  await run({ action: 'update', id: 'w1', day: '2026-10-15', scope: 'following', start: '2026-10-15T15:00' });
  const s = writes(f)[0].args;
  assert.equal(s.p_action, 'split'); assert.equal(s.p_data.id, 'w1'); assert.equal(s.p_data.day, '2026-10-15'); assert.equal(s.p_data.crew, 'alpha');
  assert.equal(s.p_data.next.starts_at, '2026-10-15T06:00:00.000Z'); assert.equal(s.p_data.next.ends_at, '2026-10-15T07:00:00.000Z', '길이 유지');
  assert.equal(s.p_data.next.rrule, 'FREQ=WEEKLY'); assert.notEqual(s.p_data.next.id, 'w1');

  f = use(fakeSession([weekly]));
  await run({ action: 'update', id: 'w1', day: '2026-10-15', scope: 'all', start: '2026-10-15T15:00' });
  const w = writes(f)[0].args;
  assert.equal(w.p_action, 'save'); assert.equal(w.p_data.starts_at, '2026-09-03T06:00:00.000Z', '시리즈 시작일(요일 기준)은 유지하고 시각만 옮긴다');

  f = use(fakeSession([weekly]));
  await run({ action: 'update', id: 'w1', day: '2026-10-15', scope: 'this', title: '이번만' });
  const c = writes(f)[0].args.p_data;
  assert.equal(c.parent_id, 'w1'); assert.equal(c.recur_on, '2026-10-15'); assert.equal(c.rrule, null); assert.equal(c.title, '이번만'); assert.equal(c.starts_at, '2026-10-15T01:00:00.000Z'); assert.equal(c.crew, 'alpha');

  f = use(fakeSession([weekly]));
  await run({ action: 'delete', id: 'w1', day: '2026-10-15', scope: 'following' });
  // 이유: save로 UNTIL만 바꾸면 그 뒤의 '이번만 수정' 행이 달력에 유령처럼 남는다 — next 없는 split이 서버에서 자르고 치운다
  assert.deepEqual(writes(f)[0].args, { p_action: 'split', p_data: { id: 'w1', day: '2026-10-15', crew: 'alpha' } }, '이후 지우기 = next 없는 split');

  f = use(fakeSession([ev()]));
  await run({ action: 'delete', id: 'e1', day: '2026-10-02' });
  assert.deepEqual(writes(f)[0].args, { p_action: 'delete', p_data: { id: 'e1', crew: 'alpha' } });
});

test('C7. 세션 없음·주인 아닌 로그인·RPC 오류·위임 턴은 원인을 한 줄로 돌려준다(삼키지 않는다)', async () => {
  use({ session: async () => null });
  assert.match(await run({ action: 'list' }), /메신저에 로그인돼 있지 않아/);
  use(fakeSession([], { uid: OTHER }));
  assert.match(await run({ action: 'list' }), /주인의 계정이 아니라/);
  assert.match(await run({ action: 'list' }, { ownerId: null }), /주인의 계정이 아니라/, '소유자 없는 회사도 막는다(브리지와 같은 규칙)');
  use(fakeSession([], { error: 'calendar_limit' }));
  assert.match(await run({ action: 'create', title: 'x', start: '2026-10-02' }), /한도\(5,000건\)/);
  use(fakeSession([], { error: 'Could not find the function public.office_event_list' }));
  assert.match(await run({ action: 'list' }), /일정 서버 호출 실패: Could not find the function/);
  const f = use(fakeSession());
  assert.match(await run({ action: 'list' }, { ctx: { kind: 'msgr-rules', orgSlug: 'o' } }), /위임 턴/);
  assert.equal(f.calls.length, 0);
});

// ── 등록 배선: SDK 서버·네이티브 엔진(sink)·손님 판정 ─────────────────────────────
const WS = 'cal-wire';
await createCompany(WS, '일정사', 'owner', ME);

test('C8. calendar는 SDK 크루 서버와 네이티브 sink 둘 다에 보이고, 벤더로 나가는 스키마에 required가 있다', async () => {
  const sdk = makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], null, 'ko');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await sdk.instance.connect(st);
  const client = new Client({ name: 't', version: '1' }); await client.connect(ct);
  const listed = (await client.listTools()).tools.find((t) => t.name === 'calendar');
  await client.close();
  assert.ok(listed, 'SDK 경로에 calendar');
  assert.deepEqual(listed.inputSchema.required, ['action']);
  const sink = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], null, 'en', [], '', sink);
  const def = sink.find((d) => d.name === 'calendar');
  assert.ok(def, '네이티브 sink 경로에 calendar'); assert.match(def.description, /owner's calendar/, '영어 설명');
  const [spec] = crewToolSpecs([def]);
  assert.deepEqual(ensureRequired(spec.input_schema).required, ['action'], 'xAI 엄격 벤더용 required 배열');
});

test('C9. 손님 턴은 읽기·쓰기 모두 guestNo — 세션을 부르지도 않는다. 주인 턴은 sink 처리기로 끝까지 돈다', async () => {
  let called = 0; Object.assign(calendarDeps, { session: async () => { called++; return null; } });
  const guestSink = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx({ origin: 'guest-uid' }), 'ko', [], '', guestSink);
  const h = guestSink.find((d) => d.name === 'calendar').handler;
  for (const args of [{ action: 'list' }, { action: 'create', title: 'x', start: '2026-10-02' }]) assert.match((await h(args)).content[0].text, /주인이 아닌 사람/);
  assert.equal(called, 0, '손님 턴은 주인의 일정을 조회조차 하지 않는다');
  const f = use(fakeSession([ev()]));
  const ownerSink = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx(), 'ko', [], '', ownerSink);
  const out = (await ownerSink.find((d) => d.name === 'calendar').handler({ action: 'list', from: '2026-10-01', to: '2026-10-07' })).content[0].text;
  assert.match(out, /치과/); assert.equal(f.calls[0].name, 'office_event_list');
});
