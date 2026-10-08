// 업무 현황(유건 10/8 확정) — 맥 세션·VPS 봇·아르고 크루를 이름으로 한 사람에 묶고, 연결·지금 하는 일·할 일을 사람별로 놓는 규칙.
import test from 'node:test';
import assert from 'node:assert/strict';
import { personKey, cardKey, buildStatus, firstLine, sourceOf, CREW_ONLINE_MS, SESSION_ONLINE_MS, IDLE_MS } from '../src/core/work-status-model.js';

const NOW = Date.parse('2026-10-08T03:00:00Z'); // 한국 2026-10-08 12:00
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();
const crew = (id, name, extra) => ({ id, name, slug: id, hosting: 'local', owner: 'u-me', last_seen_at: iso(10_000), department: null, ...extra });
const sess = (id, name, extra) => ({ id, name, project: 'argo', owner: 'u-me', task_id: null, last_seen_at: iso(60_000), ...extra });
const task = (id, extra) => ({ id, title: id, status: 'todo', priority: 2, due_on: null, note: '', assignee: 'u-me', created_by: 'u-me', created_at: '2026-10-01T00:00:00Z', done_at: null, cancelled_at: null, source: null, hold_reason: null, held_at: null, ...extra });
const data = (over) => ({ admin: true, now: new Date(NOW).toISOString(), crews: [], sessions: [], running: [], runs: [], tasks: [], people: [], ...over });
const keys = (r) => r.people.map((p) => p.key);
const K = (name, owner = 'u-me') => cardKey(owner, name);
const card = (r, name, owner = 'u-me') => r.people.find((p) => p.key === K(name, owner));

// 이유: 같은 사람이 맥 세션·VPS 봇·아르고 크루 세 자리에 있다 — 한 줄로 보여야 한다(유건 확정 2)
test('personKey: " - " 앞부분, 앞뒤 공백 제거, 라틴 소문자', () => {
  assert.equal(personKey('맥가이버 - 정비사'), '맥가이버');
  assert.equal(personKey('맥가이버 - v'), '맥가이버');
  assert.equal(personKey('맥가이버'), '맥가이버');
  assert.equal(personKey('  맥가이버   - 정비사 '), '맥가이버');
  assert.equal(personKey('  맥가이버  '), '맥가이버');
  assert.equal(personKey('Pepper - v'), 'pepper');
  assert.equal(personKey('PEPPER'), 'pepper');
  assert.notEqual(personKey('Pepper'), personKey('페퍼'), '이름이 다르면 다른 사람');
  assert.equal(personKey('맥가이버-v'), '맥가이버-v', '" - "(앞뒤 공백 있는 줄표)만 자른다');
  assert.equal(personKey(' - v'), '- v', '앞부분이 비면 이름 전체');
  assert.equal(personKey(null), '');
  assert.equal(personKey('맥가이버'.normalize('NFD')), '맥가이버', '맥 폴더 이름처럼 풀어 쓴 한글도 같은 사람');
});

test('한 사람 묶기: 맥 세션·VPS 봇·아르고 크루 → 한 줄, 자리별로', () => {
  const r = buildStatus(data({
    crews: [crew('c1', '맥가이버'), crew('c2', '맥가이버 - v', { hosting: 'bot' }), crew('c3', 'Pepper'), crew('c4', '페퍼')],
    sessions: [sess('s1', '맥가이버 - 정비사')],
  }), { me: 'u-me', now: NOW });
  assert.deepEqual(keys(r).sort(), [K('pepper'), K('맥가이버'), K('페퍼')].sort());
  const mac = card(r, '맥가이버');
  assert.equal(mac.name, '맥가이버');
  assert.deepEqual(mac.places.local.map((c) => c.id), ['c1']);
  assert.deepEqual(mac.places.bot.map((c) => c.id), ['c2']);
  assert.deepEqual(mac.places.session.map((s) => s.id), ['s1']);
  assert.equal(mac.mine, true);
  assert.equal(r.summary.people, 3);
});

// 검수 10/8: 크루가 늘 세션보다 먼저 처리돼 우선순위 줄을 지워도 통과하던 테스트 — VPS 봇이 아르고 크루보다 먼저 오게 놓고 아르고 크루 이름이 이기는지 본다
test('보이는 이름: 아르고 크루 → VPS → 세션 제목 순(대소문자 그대로, 먼저 온 자리와 상관없이)', () => {
  const r = buildStatus(data({ crews: [crew('c1', 'Pepper - v', { hosting: 'bot' }), crew('c2', 'pepper')], sessions: [sess('s1', 'PEPPER - 총괄')] }), { now: NOW });
  assert.equal(r.people.length, 1);
  assert.equal(r.people[0].name, 'pepper', '아르고 크루 이름');
  const r2 = buildStatus(data({ crews: [crew('c1', 'Pepper - v', { hosting: 'bot' })], sessions: [sess('s1', 'PEPPER - 총괄')] }), { now: NOW });
  assert.equal(r2.people[0].name, 'Pepper', '아르고 크루가 없으면 VPS 이름이 세션 제목보다 먼저');
});

// 이유: 크루는 오피스·메신저와 같은 90초, 세션은 4분에 한 번 보고하므로 15분 — 경계에서 정확히 나뉘어야 '연결 N/M'이 메신저와 같다
test('연결: 크루 90초·세션 15분 경계(정확히 그 시간이면 끊김)', () => {
  const at = (crewAgo, sessAgo) => buildStatus(data({ crews: crewAgo == null ? [] : [crew('c1', 'A', { last_seen_at: iso(crewAgo) })], sessions: sessAgo == null ? [] : [sess('s1', 'B', { last_seen_at: iso(sessAgo) })] }), { now: NOW });
  assert.equal(at(CREW_ONLINE_MS - 1, null).people[0].online, true);
  assert.equal(at(CREW_ONLINE_MS, null).summary.online, 0);
  assert.equal(at(null, SESSION_ONLINE_MS - 1).people[0].online, true);
  assert.equal(at(null, SESSION_ONLINE_MS).summary.online, 0);
  assert.equal(CREW_ONLINE_MS, 90_000);
  assert.equal(SESSION_ONLINE_MS, 15 * 60_000);
  // 한 자리라도 연결이면 그 사람은 연결 — 마지막으로 보인 때는 가장 늦은 자리
  const r = buildStatus(data({ crews: [crew('c1', 'A', { last_seen_at: iso(3_600_000) })], sessions: [sess('s1', 'A - x', { last_seen_at: iso(5 * 60_000) })] }), { now: NOW });
  assert.equal(r.people[0].online, true);
  assert.equal(r.people[0].lastSeen, NOW - 5 * 60_000);
  assert.deepEqual(r.summary, { doing: 0, hold: 0, overdue: 0, online: 1, people: 1 });
});

test('now를 안 주면 서버 시각(data.now) 기준', () => {
  const r = buildStatus(data({ crews: [crew('c1', 'A', { last_seen_at: iso(10_000) })] }));
  assert.equal(r.people[0].online, true);
});

// 이유: 기한 지남은 한국 날짜 기준(task-model.js kstDay) — 한국 자정 직전·직후에 '어제 기한'이 바뀌는 자리
test('기한 지남: 한국 날짜 기준, 오늘 기한은 지남이 아니다', () => {
  const tasks = [task('yday', { due_on: '2026-10-07', source: { kind: 'session', name: 'A - x' } }), task('today', { due_on: '2026-10-08', source: { kind: 'session', name: 'A - x' } }), task('tmr', { due_on: '2026-10-09', source: { kind: 'session', name: 'A - x' } })];
  const sessions = [sess('s1', 'A - x')];
  const lastMinute = Date.parse('2026-10-08T14:59:59Z'); // 한국 10/8 23:59:59
  let r = buildStatus(data({ tasks, sessions }), { now: lastMinute });
  assert.equal(r.summary.overdue, 1);
  assert.equal(r.people[0].overdue, 1);
  assert.equal(r.people[0].nextDue, '2026-10-08');
  assert.deepEqual(r.people[0].todo.map((x) => [x.id, x.overdue]), [['yday', true], ['today', false], ['tmr', false]]);
  r = buildStatus(data({ tasks, sessions }), { now: lastMinute + 1000 }); // 한국 10/9 0시
  assert.equal(r.summary.overdue, 2);
  assert.equal(r.people[0].nextDue, '2026-10-09');
});

test('할 일 → 사람: 크루가 만든 일은 그 크루, 세션이 남긴 일은 만든 사람의 같은 이름 자리, 그 밖은 에이전트 없이 맡긴 일', () => {
  const r = buildStatus(data({
    crews: [crew('c1', '맥가이버'), crew('c9', '오토', { last_seen_at: iso(86_400_000) })],
    people: [{ id: 'u-me', name: '김유건' }, { id: 'u-jun', name: '박준' }, { id: 'u-left', name: null }],
    tasks: [
      task('byCrew', { source: { kind: 'crew', crew: 'c1', slug: 'mac', name: '엉뚱한 이름' }, status: 'doing' }),
      task('byGone', { source: { kind: 'crew', crew: 'gone', slug: 'shuri', name: '슈리' } }), // 목록에 없는 크루 — 주인을 알 수 없으니 붙이지 않는다
      task('bySlug', { source: { kind: 'crew', crew: 'gone2', slug: 'otto' } }),
      task('bySession', { source: { kind: 'session', name: '맥가이버 - 정비사' }, status: 'hold', hold_reason: '이것부터: 검수' }),
      task('byPerson', { assignee: 'u-jun', status: 'doing' }),
      task('byPage', { source: { kind: 'page', page_id: 'p1' }, assignee: 'u-left' }),
      task('noName', { source: { kind: 'session', name: '  ' } }),
      task('done', { source: { kind: 'session', name: '맥가이버' }, done_at: '2026-10-08T00:00:00Z' }),
      task('cancelled', { source: { kind: 'session', name: '맥가이버' }, cancelled_at: '2026-10-08T00:00:00Z' }),
    ],
  }), { me: 'u-me', now: NOW });
  const mac = card(r, '맥가이버');
  assert.deepEqual(mac.doing.map((x) => x.id), ['byCrew']);
  assert.deepEqual(mac.held.map((x) => x.id), ['bySession']);
  assert.equal(mac.held[0].personName, '맥가이버');
  assert.deepEqual(keys(r).sort(), [K('맥가이버')].sort(), '할 일 출처만으로는 사람 카드가 생기지 않는다(오토는 업무 없음·끊김)');
  assert.deepEqual(r.unowned.doing.map((x) => [x.id, x.assigneeName]), [['byPerson', '박준']]);
  assert.deepEqual(r.unowned.todo.map((x) => [x.id, x.assigneeName]).sort(), [['byGone', '김유건'], ['bySlug', '김유건'], ['byPage', null], ['noName', '김유건']].sort());
  assert.deepEqual(r.held.map((x) => x.id), ['bySession']);
  assert.deepEqual([r.summary.doing, r.summary.hold], [2, 1], '끝낸 일·취소한 일은 세지 않는다');
  assert.equal(r.summary.people, 2, '자리가 있는 사람만 연결 N/M의 M');
});

test('지금 하는 일: 세션이 맡은 열린 할 일, 작업, 답하는 중인 실행', () => {
  const r = buildStatus(data({
    crews: [crew('c1', '맥가이버'), crew('c2', '맥가이버 - v', { hosting: 'bot' }), crew('c3', '페퍼')],
    sessions: [sess('s1', '맥가이버 - 정비사', { task_id: 't1' }), sess('s2', '맥가이버 - 검수', { task_id: 'gone' }), sess('s3', '페퍼 - 총괄', { task_id: 'tDone' })],
    tasks: [task('t1', { title: '업무 현황 화면' }), task('tDone', { title: '끝난 일', done_at: '2026-10-08T00:00:00Z' })],
    runs: [{ id: 'r1', lead_crew_id: 'c1', goal: '경쟁사 조사', status: 'running', created_at: iso(60_000) }, { id: 'r2', lead_crew_id: 'c3', goal: '자료 기다림', status: 'blocked', created_at: iso(60_000) }],
    running: [{ crew_id: 'c1', started_at: iso(5000) }, { crew_id: 'c2', started_at: iso(5000) }, { crew_id: 'c3', started_at: iso(5000) }, { crew_id: 'unknown', started_at: iso(5000) }],
  }), { now: NOW });
  const mac = card(r, '맥가이버'), pep = card(r, '페퍼');
  assert.deepEqual(mac.now.map((x) => [x.kind, x.text]), [['run', '경쟁사 조사'], ['session', '업무 현황 화면'], ['exec', '맥가이버 - v']], '작업 중인 크루(c1)의 실행은 작업과 겹쳐 빼고, 지워진·끝난 할 일은 무시');
  assert.equal(mac.now[1].id, 't1');
  assert.equal(mac.now[2].place, 'bot', '답하는 중인 자리(VPS)');
  assert.deepEqual(pep.now.map((x) => [x.kind, x.text, x.status]), [['run', '자료 기다림', 'blocked'], ['exec', '페퍼', undefined]], '멈춘 작업의 크루는 답하는 중이면 그것도 보인다');
});

test('정렬: 연결된 사람 → 업무가 있는 사람 → 나머지, 같으면 이름순 / 7일 경계 idle·hidden', () => {
  const r = buildStatus(data({
    crews: [
      crew('c1', '하나', { last_seen_at: iso(3 * 86_400_000) }), // 업무 없음·끊김·7일 안 → idle
      crew('c2', '나비', { last_seen_at: iso(20_000) }), // 연결
      crew('c3', '가람', { last_seen_at: iso(20_000) }), // 연결
      crew('c4', '다솜', { last_seen_at: iso(86_400_000) }), // 업무 있음
      crew('c5', '미오', { last_seen_at: iso(IDLE_MS) }), // 정확히 7일 → idle
      crew('c6', '라온', { last_seen_at: iso(IDLE_MS + 1) }), // 7일 넘음 → 수만
      crew('c7', '보라', { last_seen_at: null }), // 본 적 없음 → 수만
    ],
    tasks: [task('t', { source: { kind: 'crew', crew: 'c4' } })],
  }), { now: NOW });
  assert.deepEqual(r.people.map((p) => p.name), ['가람', '나비', '다솜']);
  assert.deepEqual(r.idle.map((p) => p.name), ['미오', '하나']);
  assert.equal(r.hidden, 2);
  assert.equal(r.summary.people, 7);
  assert.equal(r.summary.online, 2);
});

test('같은 칸 안 순서: 기한 빠른 것(없으면 뒤) → 중요도 → 만든 순 / 보류된 업무는 오래 묶인 것부터', () => {
  const src = { kind: 'session', name: 'A' };
  // 검수 10/8: 중요도 비교를 지워도 id 이름순으로 같은 순서가 나와 통과했다 — 중요도 높은 일의 id를 이름순으로 뒤에 둔다
  const r = buildStatus(data({ sessions: [sess('s1', 'A')], tasks: [
    task('none', { source: src }), task('late', { source: src, due_on: '2026-10-20' }), task('aLow', { source: src, due_on: '2026-10-10', priority: 3 }),
    task('zHigh', { source: src, due_on: '2026-10-10', priority: 1 }),
    task('h2', { source: src, status: 'hold', held_at: '2026-10-07T00:00:00Z' }), task('h1', { source: src, status: 'hold', held_at: '2026-10-01T00:00:00Z' }), task('h0', { status: 'hold', held_at: null }),
  ] }), { now: NOW });
  assert.deepEqual(r.people[0].todo.map((x) => x.id), ['zHigh', 'aLow', 'late', 'none']);
  assert.deepEqual(r.held.map((x) => x.id), ['h1', 'h2', 'h0']);
});

// 이유: 일반 멤버에게는 서버가 자기 에이전트·자기 세션·자기 일만 준다 — 그 데이터로도 화면이 같은 규칙으로 서야 한다
test('멤버 모드 데이터: 내 자리만 와도 같은 규칙, 목록에 없는 남의 크루 출처는 에이전트 없이 맡긴 일', () => {
  const r = buildStatus(data({
    admin: false,
    crews: [crew('c1', '오토', { owner: 'u-me' })],
    sessions: [sess('s1', '오토 - 리서치', { owner: 'u-me' })],
    tasks: [task('mineByOther', { source: { kind: 'crew', crew: 'theirs', name: '루나' }, assignee: 'u-me', created_by: 'u-boss' }), task('gave', { assignee: 'u-jun', created_by: 'u-me', status: 'doing' })],
    people: [{ id: 'u-jun', name: '박준' }],
  }), { me: 'u-me', now: NOW });
  assert.deepEqual(keys(r), [K('오토')]);
  assert.equal(r.people[0].mine, true);
  assert.deepEqual(r.unowned.todo.map((x) => x.id), ['mineByOther'], '주인을 알 수 없는 크루 출처');
  assert.deepEqual(r.unowned.doing.map((x) => x.assigneeName), ['박준']);
  const empty = buildStatus(data({ admin: false }), { me: 'u-me', now: NOW });
  assert.deepEqual([empty.people, empty.idle, empty.hidden, empty.held], [[], [], 0, []]);
  assert.deepEqual(empty.summary, { doing: 0, hold: 0, overdue: 0, online: 0, people: 0 });
});

test('빈 응답·모르는 모양에도 깨지지 않는다', () => {
  assert.deepEqual(buildStatus(null, { now: NOW }).summary, { doing: 0, hold: 0, overdue: 0, online: 0, people: 0 });
  assert.equal(firstLine('\n  첫 줄  \n둘째'), '첫 줄');
  assert.equal(firstLine(null), '');
});

// 검수 10/8(위조): office_task_write는 source를 검사하지 않고 저장하고, 세션 이름은 누구나 지을 수 있다. 멤버가 주인의 에이전트 카드에 자기 일·연결·지금 하는 일을 붙이지 못해야 한다
test('위조: 남의 크루 id·같은 이름 세션 출처·같은 이름 세션의 task_id로 남의 카드에 붙지 않는다', () => {
  const base = {
    crews: [crew('c-p', '페퍼', { owner: 'u-boss', last_seen_at: iso(86_400_000) })],
    people: [{ id: 'u-boss', name: '대표' }, { id: 'u-mem', name: '박준' }],
    tasks: [
      task('bossTask', { title: '주인 일', assignee: 'u-boss', created_by: 'u-boss', status: 'doing' }),
      task('fakeCrew', { source: { kind: 'crew', crew: 'c-p', name: '페퍼' }, assignee: 'u-mem', created_by: 'u-mem', status: 'doing' }), // (1) 남의 크루 id
      task('fakeSess', { source: { kind: 'session', name: '페퍼 - 총괄' }, assignee: 'u-mem', created_by: 'u-mem', status: 'hold', hold_reason: '가짜' }), // (2) 같은 이름 세션 출처
    ],
  };
  const fakeSession = sess('s-fake', '페퍼 - 가짜', { owner: 'u-mem', task_id: 'bossTask', last_seen_at: iso(30_000) }); // (3) 같은 이름 세션 + 주인의 일 id
  for (const sessions of [[], [fakeSession]]) {
    const r = buildStatus(data({ ...base, sessions }), { me: 'u-boss', now: NOW });
    const boss = card(r, '페퍼', 'u-boss');
    const shown = boss ?? r.idle.find((p) => p.key === K('페퍼', 'u-boss'));
    assert.ok(shown, '주인의 카드는 그대로 있다');
    assert.deepEqual([shown.online, shown.doing.length, shown.held.length, shown.todo.length, shown.now.length], [false, 0, 0, 0, 0], `주인 카드에 아무것도 안 붙는다(세션 ${sessions.length})`);
    assert.deepEqual(shown.places.session, []);
    assert.deepEqual(r.unowned.doing.map((x) => x.id).sort(), ['bossTask', 'fakeCrew'], '(1) 크루 주인이 만든 사람·맡은 사람이 아니면 에이전트 없이 맡긴 일');
    assert.ok(r.held.every((x) => x.person !== K('페퍼', 'u-boss')));
    const held = r.held.find((x) => x.id === 'fakeSess');
    assert.equal(held.assigneeName, '박준', '보류 카드 담당은 실제 맡은 사람');
    if (!sessions.length) {
      assert.deepEqual(r.unowned.held.map((x) => x.id), ['fakeSess'], '(2) 만든 사람에게 그 이름 자리가 없으면 에이전트 없이 맡긴 일');
      continue;
    }
    const mem = card(r, '페퍼', 'u-mem');
    assert.ok(mem, '멤버의 같은 이름 세션은 멤버 카드(다른 카드)');
    assert.deepEqual([mem.mine, mem.ownerName, mem.online], [false, '박준', true]);
    assert.deepEqual(mem.held.map((x) => x.id), ['fakeSess'], '(2) 만든 사람 자기 카드에만');
    assert.deepEqual(mem.now, [], '(3) 세션 주인이 맡은 사람·만든 사람이 아닌 일은 지금 하는 일이 아니다');
    assert.equal(r.summary.online, 1);
  }
});

test('주인이 다른 같은 이름 크루는 두 카드 — 내 카드 먼저, 남의 카드는 주인 이름(모르면 null)', () => {
  const r = buildStatus(data({
    crews: [crew('c-j', '오토', { owner: 'u-jun' }), crew('c-m', '오토'), crew('c-x', '오토 - v', { owner: 'u-x', hosting: 'bot' })],
    sessions: [sess('s-j', '오토 - 리서치', { owner: 'u-jun', task_id: 'tj' })],
    tasks: [task('tj', { assignee: 'u-jun', created_by: 'u-me', status: 'doing', source: { kind: 'crew', crew: 'c-j' } }), task('tm', { source: { kind: 'crew', crew: 'c-m' } })],
    people: [{ id: 'u-jun', name: '박준' }],
  }), { me: 'u-me', now: NOW });
  assert.deepEqual(keys(r), [K('오토'), K('오토', 'u-jun'), K('오토', 'u-x')]);
  assert.deepEqual(r.people.map((p) => [p.mine, p.ownerName]), [[true, null], [false, '박준'], [false, null]]);
  const jun = card(r, '오토', 'u-jun');
  assert.deepEqual([jun.places.local.map((c) => c.id), jun.places.session.map((s) => s.id)], [['c-j'], ['s-j']], '같은 주인의 크루·세션만 한 카드');
  assert.deepEqual(jun.doing.map((x) => x.id), ['tj'], '크루 주인이 맡은 사람이면 그 카드(만든 사람은 달라도)');
  assert.deepEqual(jun.now.map((x) => [x.kind, x.id]), [['session', 'tj']], '세션 주인이 맡은 사람이면 지금 하는 일');
  assert.deepEqual(card(r, '오토').todo.map((x) => x.id), ['tm']);
  assert.equal(r.summary.people, 3);
});

// 재검증 10/8: 남의 카드에 붙지 않게 막은 위조 일도 보류 카드 출처 줄에 '에이전트 페퍼'처럼 남의 이름이 찍혔다 → 대조에 실패한 출처는 이름 없이
test('출처 표시 sourceOf: 주인 대조를 통과한 일만 이름을 보이고, 실패한 crew·session 출처는 이름 없이', () => {
  assert.deepEqual(sourceOf({ source: { kind: 'crew', crew: 'c1', name: '페퍼' }, person: null, personName: null }), { kind: 'crew', name: null });
  assert.deepEqual(sourceOf({ source: { kind: 'session', name: '페퍼 - 총괄' }, person: null, personName: null }), { kind: 'session', name: null });
  assert.deepEqual(sourceOf({ source: { kind: 'crew', crew: 'c1' }, person: 'u1|페퍼', personName: '페퍼' }), { kind: 'crew', name: '페퍼' });
  assert.deepEqual(sourceOf({ source: { kind: 'session', name: '맥가이버 - 정비사' }, person: 'u1|맥가이버', personName: '맥가이버' }), { kind: 'session', name: '맥가이버 - 정비사' });
  assert.deepEqual(sourceOf({ source: { kind: 'notion', id: 'x' }, person: null }), { kind: 'person', name: null });
  assert.deepEqual(sourceOf({ source: null }), { kind: 'person', name: null });
});
