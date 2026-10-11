// 멈춘(paused) 에이전트가 '?'로 보이던 제보(2026-10-11, 메신저 0.1.57) — 무료 계정 에이전트가 #941로 status='paused'가 되면
// 메신저가 크루 행을 active·available만 읽어 1:1 방 이름이 'dm:?', 방 머리가 '?', 글쓴이가 '에이전트'로 떴다(로컬 검수 스택 재현).
// 잠그는 것: ① 나누기 기준 상태(active·available·paused, detached 없음). 조직 목록 조회는 active·available 그대로(전송량 — #950 분리 검수, rail-state.test.mjs가 실제 loadOrg로 잠근다)
// ⑦ 조직의 모르는 크루 id만 따로 한 번(표시 열만, 같은 id 재조회 0)
// ② 나누기 — 연결(목록·숫자·멘션·초대·턴)은 active만, 내 꺼 둔 에이전트는 available만, 이름·얼굴·글쓴이는 paused까지
// ③ 이름 찾기 — 연결된 행이 먼저, 없으면 멈춘 행(멈춘 1:1 방 이름·글쓴이가 '?'·'에이전트'가 아니다)
// ④ 1:1 방 머리의 '멈춤' 표시 — 방의 에이전트 한 명이 멈췄고 연결된 에이전트가 없을 때만(그룹·채널·연결된 방은 없음)
// ⑤ 문구 ko·en(결제 권유 없음 — iOS도 같은 문구) ⑥ 화면 배선: 조직 조회·개인 방 이름·대화창·알림함·검색·얼굴이 표시용 찾기를 쓰고, 목록 숫자는 연결 기준 그대로
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPACE_CREW_STATUSES, splitSpaceCrews, withPaused, pausedRoomCrew, crewNameAsker, readPausedCrewNames } from '../src/agent-pause.mjs';
import { t as tm } from '../src/i18n.js';

const ME = 'u-me'; const OTHER = 'u-other';
const row = (id, status, extra = {}) => ({ id, status, owner_user_id: ME, display_name: id.toUpperCase(), ...extra });
const rows = [row('a1', 'active'), row('p1', 'paused'), row('v1', 'available'), row('v2', 'available', { owner_user_id: OTHER }), row('p2', 'paused', { owner_user_id: OTHER }), row('d1', 'detached')];

test('① 나누기 기준 상태 — active·available·paused(detached는 표시하지 않는다)', () => {
  assert.deepEqual([...SPACE_CREW_STATUSES].sort(), ['active', 'available', 'paused']);
});

test('② 나누기 — 연결은 active만, 꺼 둔 것은 내 available만, 멈춤은 paused만, 표시용은 셋 다(detached 없음)', () => {
  const s = splitSpaceCrews(rows, ME);
  assert.deepEqual(s.connected.map((c) => c.id), ['a1'], '연결 목록·"에이전트 · N"·멘션·초대·턴 대상은 active만');
  assert.deepEqual(s.available.map((c) => c.id), ['v1'], '남의 꺼 둔 에이전트는 내 다시 켜기 목록에 없다');
  assert.deepEqual(s.paused.map((c) => c.id), ['p1', 'p2']);
  assert.deepEqual(s.shown.map((c) => c.id), ['a1', 'p1', 'v1', 'v2', 'p2'], '이름 찾기 — detached(빠진 에이전트)는 넣지 않는다');
  assert.deepEqual(splitSpaceCrews(null, ME), { connected: [], available: [], paused: [], shown: [] });
});

test('② 연결 숫자는 멈춘 행이 섞여도 그대로 — 전부 멈추면 0(안내 문구가 이유를 말한다)', () => {
  const before = splitSpaceCrews(rows.filter((r) => r.status !== 'paused'), ME).connected.length;
  assert.equal(splitSpaceCrews(rows, ME).connected.length, before);
  const allPaused = ['도윤', '하람', '지호', '세온'].map((n, i) => row(`c${i}`, 'paused', { display_name: n }));
  assert.equal(splitSpaceCrews(allPaused, ME).connected.length, 0);
});

test('③ 이름 찾기 — 멈춘 1:1 방 이름·글쓴이가 \'?\'·\'에이전트\'가 아니라 그 이름(재현: 도윤 → ?)', () => {
  const allPaused = ['도윤', '하람', '지호', '세온'].map((n, i) => row(`c${i}`, 'paused', { display_name: n }));
  const s = splitSpaceCrews(allPaused, ME);
  const crewOf = (id) => s.connected.find((c) => c.id === id); // 연결 판단용(지금 그대로)
  const shown = withPaused(crewOf, s.paused);
  assert.equal(crewOf('c0'), undefined, '연결 판단은 멈춘 에이전트를 모른다');
  assert.equal(shown('c0')?.display_name, '도윤');
  assert.equal(`dm:${s.shown.find((c) => c.id === 'c0')?.display_name || '?'}`, 'dm:도윤', '개인 1:1 방 이름(loadPersonal)');
  assert.equal(shown('zz'), undefined, '모르는 에이전트는 종전대로(호출한 쪽 대체 문구)');
  const both = withPaused((id) => (id === 'x' ? { id: 'x', display_name: '연결' } : undefined), [{ id: 'x', display_name: '멈춤 옛 값' }]);
  assert.equal(both('x').display_name, '연결', '연결된 행이 먼저');
});

test('④ 1:1 방 머리 \'멈춤\' — 방의 에이전트 한 명이 멈췄고 연결된 에이전트가 없을 때만', () => {
  const paused = [row('p1', 'paused')]; const connected = [row('a1', 'active')];
  const m = (...ids) => [{ member_kind: 'user', member_id: ME }, ...ids.map((id) => ({ member_kind: 'crew', member_id: id }))];
  assert.equal(pausedRoomCrew({ kind: 'dm' }, m('p1'), { connected, paused })?.id, 'p1');
  assert.equal(pausedRoomCrew({ kind: 'dm' }, m('a1'), { connected, paused }), null, '연결된 에이전트 방');
  assert.equal(pausedRoomCrew({ kind: 'dm' }, m('p1', 'a1'), { connected, paused }), null, '에이전트 둘(그룹)');
  assert.equal(pausedRoomCrew({ kind: 'private' }, m('p1'), { connected, paused }), null, '채널은 표시 없음');
  assert.equal(pausedRoomCrew({ kind: 'dm' }, [{ member_kind: 'user', member_id: ME }, { member_kind: 'user', member_id: OTHER }], { connected, paused }), null, '사람 1:1');
  assert.equal(pausedRoomCrew(null, m('p1'), { connected, paused }), null);
});

test('⑤ 문구 — ko·en, 기존 멈춤 안내 말투, 결제 권유 없음', () => {
  assert.equal(tm('agents.paused.tag', 'ko'), '멈춤');
  assert.equal(tm('agents.paused.tag', 'en'), 'Paused');
  for (const lang of ['ko', 'en']) assert.doesNotMatch(tm('agents.paused.tag', lang), /Pro|결제|업그레이드|Upgrade/i);
});

test('⑦ 조직의 모르는 크루 이름 — 모아서 한 번, 같은 id는 세션 동안 다시 읽지 않는다(빈 답·실패도)', async () => {
  const reads = []; let tick = null; const got = [];
  const asker = crewNameAsker(async (ids) => { reads.push(ids); if (ids.includes('boom')) throw new Error('net'); return ids.filter((id) => id.startsWith('p')).map((id) => ({ id, status: 'paused' })); }, (rows) => got.push(...rows), (f) => { tick = f; });
  asker.ask('p1'); asker.ask('p1'); asker.ask('x1'); asker.ask(null);
  tick(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(reads, [['p1', 'x1']], '한 틱에 모은 id를 한 번에');
  assert.deepEqual(got.map((r) => r.id), ['p1']);
  tick = null; asker.ask('p1'); asker.ask('x1');
  assert.equal(tick, null, '이미 물은 id(답이 없던 x1 포함)는 다시 예약하지 않는다');
  asker.ask('boom'); tick(); await new Promise((r) => setImmediate(r)); tick = null; asker.ask('boom');
  assert.equal(tick, null, '실패한 id도 다시 묻지 않는다(재시도 폭주 없음)'); assert.equal(reads.length, 2);
});

test('⑦ readPausedCrewNames — 표시 열만, 멈춘 행만, 옛 서버(face 없음)는 face 없이 한 번 더, 오류는 []', async () => {
  const calls = [];
  const db = (answers) => ({ from(t) { assert.equal(t, 'msgr_crews'); return { select(c) { this.c = c; return this; }, in(col, ids) { calls.push([this.c, col, ids]); return Promise.resolve(answers.shift()); } }; } });
  const rows = [{ id: 'p', status: 'paused', display_name: '도윤' }, { id: 'd', status: 'detached', display_name: 'x' }, { id: 'a', status: 'active', display_name: 'y' }];
  assert.deepEqual((await readPausedCrewNames(db([{ data: rows, error: null }]), ['p', 'd', 'a'])).map((r) => r.id), ['p']);
  assert.deepEqual(calls[0], ['id, owner_user_id, display_name, role_text, status, face, avatar_url', 'id', ['p', 'd', 'a']], '계산 열(msgr_crew_seen)·commands 없음');
  calls.length = 0;
  assert.deepEqual((await readPausedCrewNames(db([{ data: null, error: { message: 'column msgr_crews.face does not exist' } }, { data: rows, error: null }]), ['p'])).map((r) => r.id), ['p']);
  assert.equal(calls[1][0], 'id, owner_user_id, display_name, role_text, status, avatar_url');
  assert.deepEqual(await readPausedCrewNames(db([{ data: null, error: { message: 'permission denied' } }]), ['p']), []);
  assert.deepEqual(await readPausedCrewNames({ from() { throw new TypeError('Failed to fetch'); } }, ['p']), []);
  assert.deepEqual(await readPausedCrewNames(db([]), []), [], '물을 id가 없으면 요청 0');
  calls.length = 0;
  const many = Array.from({ length: 250 }, (_, i) => `id${i}`);
  const answers = [0, 1, 2].map(() => ({ data: [], error: null }));
  answers[1] = { data: null, error: { message: 'timeout' } };
  answers[2] = { data: [{ id: 'id249', status: 'paused' }], error: null };
  assert.deepEqual((await readPausedCrewNames(db(answers), many)).map((r) => r.id), ['id249'], '한 묶음이 실패해도 다른 묶음은 받는다');
  assert.deepEqual(calls.map((c) => c[2].length), [100, 100, 50], 'id는 100개씩 나눠 묻는다(URL 길이 한도)');
});

test('⑥ 화면 배선 — 조직 목록 조회는 그대로, 표시 자리는 표시용 찾기, 목록 숫자는 연결 기준', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.equal((app.match(/\.eq\('org_id', id\)\.in\('status', \['active', 'available'\]\)/g) ?? []).length, 2, '조직 목록 조회 두 갈래(face 있음·없음) 모두 active·available 그대로 — 전송량');
  assert.doesNotMatch(app, /SPACE_CREW_STATUSES/, '조직 목록 조회에 paused를 더하지 않는다');
  assert.match(app, /const split = splitSpaceCrews\(fetchedCrews, uid\);/);
  assert.match(app, /const crs = split\.connected;/, '연결 목록(레일 "에이전트 · N"·멘션·초대) = active만');
  assert.match(app, /const roomCrews = withoutCopies\(roomSplit\.connected\);/, '개인 공간 고르기·멘션 후보 = active만');
  assert.match(app, /dm:\$\{roomSplit\.shown\.find\(\(c\) => c\.id === r\.crew_dm\)\?\.display_name \|\| '\?'\}/, '개인 1:1 방 이름 = 멈춘 에이전트도');
  assert.match(app, /const crewAsker = useMemo\(\(\) => crewNameAsker\(\(ids\) => readPausedCrewNames\(supabase, ids\),/, '조직의 모르는 id는 따로 한 번');
  assert.match(app, /const crewShown = withPaused\(crewOf, pausedKnown, isPersonal \? null : \(id\) => \{ if \(loadedOrg\.current === orgId\) crewAsker\.ask\(id\); \}\);/, '개인 공간은 묻지 않고, 조직은 목록을 다 읽은 뒤에만');
  assert.match(app, /<Channel key=\{chId\}[^\n]*crewOf=\{crewShown\}/, '대화창 글쓴이·인용·수신 표시');
  assert.match(app, /<Inbox [^\n]*crews=\{shownCrews\}/); assert.match(app, /<SearchPage [^\n]*crews=\{shownCrews\}/);
  assert.match(app, /const byId = new Map\(\[\.\.\.\(myAgents \?\? \[\]\), \.\.\.crews, \.\.\.myAvailable, \.\.\.pausedKnown\]/, '얼굴 — 저장한 얼굴로');
  assert.match(app, /spaceSnap\.current = \{[^}]*pausedCrews[^}]*\}/, '공간 전환 저장본');
  assert.match(app, /setPausedCrews\(d\.pausedCrews \?\? \[\]\)/, '공간 전환 복원·비우기');
});
