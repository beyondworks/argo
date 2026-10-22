// 본체 조직 기억 회수 — 서버 쪽(20261022180000): msgr2_agent_rooms(방 → 내 에이전트·공간 종류)와 'agent.scope' 빠짐 알림을 실제 Postgres에서 본다.
// 경우: 팀 방·개인 1:1·친구 공간 방 혼합, 넣은 방마다 1행(중복·null 제거), 남의 방·없는 방 = 빈 목록·공간 없음(노출 0), 파견 해제·방에서 빼기·조직 탈퇴·
// 손님 만료(시각·당김)·공간 삭제 = 빈 목록 + 알림(사람마다 트랜잭션당 1번), 방 보관 = 그대로, 은퇴 에이전트 제외, 앱 기기·기기 없음 거절, 500개 상한,
// 쓰기 0(xmin)·stable, 알림 봉투가 약속 v1 검사를 통과하고 옛 본체는 답하지 않음(unsupportedReply null), 되돌림.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-agent-rooms-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateEnvelope, unsupportedReply } from '../packages/agent-link/contract/v1.mjs';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-agent-rooms-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261022180000_msgr2_agent_rooms.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261022180000_msgr2_agent_rooms.down.sql', import.meta.url));
const U = { A: 'e1000000-0000-4000-8000-00000000000a', B: 'e1000000-0000-4000-8000-00000000000b', C: 'e1000000-0000-4000-8000-00000000000c' };
const NONE = 'e1000000-0000-4000-8000-0000000000ff';
let db, runA, appA, runC; const S = {}; const R = {}; const G = {};

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const space = (kind, owner, name = '') => db.sql('insert into public.msgr2_spaces (kind, name, owner_user_id) values (' + q(kind) + ', ' + q(name) + ', ' + q(owner) + ') returning id');
const smember = (sp, u, role = 'member', expires = null) => db.sql('insert into public.msgr2_space_members (space_id, user_id, role, expires_at) values (' + q(sp) + ', ' + q(u) + ', ' + q(role) + ', ' + (expires ? q(expires) : 'null') + ')');
const agent = (owner, slug) => db.sql('insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values (' + q(owner) + ", 'ws', " + q(slug) + ', ' + q(slug) + ') returning id');
const seat = (ag, sp) => db.sql('insert into public.msgr2_agent_seats (agent_id, space_id) values (' + q(ag) + ', ' + q(sp) + ')');
const room = (sp, kind, name, users, agents = []) => {
  const r = db.sql('insert into public.msgr2_rooms (space_id, kind, name) values (' + q(sp) + ', ' + q(kind) + ', ' + q(name) + ') returning id');
  for (const u of users) db.sql('insert into public.msgr2_room_members (room_id, member_kind, member_id) values (' + q(r) + ", 'user', " + q(u) + ')');
  for (const g of agents) db.sql('insert into public.msgr2_room_members (room_id, member_kind, member_id) values (' + q(r) + ", 'agent', " + q(g) + ')');
  return r;
};
const arr = (ids) => "array[" + ids.map((x) => (x === null ? 'null' : q(x))).join(', ') + ']::uuid[]';
const rooms = (dev, ids) => JSON.parse(db.as(dev.uid, dev.sid, "select coalesce(json_agg(t), '[]') from public.msgr2_agent_rooms(" + arr(ids) + ') t'));
const byRoom = (rows) => Object.fromEntries(rows.map((r) => [r.room_id, r]));
const scopeSends = (uid) => Number(db.sql("select count(*) from realtime.sent where topic = 'v2:w:" + uid + "' and event = 'agent.scope'"));
const lastScope = (uid) => JSON.parse(db.sql("select payload::text from realtime.sent where topic = 'v2:w:" + uid + "' and event = 'agent.scope' order by id desc limit 1"));

before(() => {
  if (!DB) return;
  db = setup(DB);
  db.psql(['-c', readFileSync(MIG, 'utf8')]); // setup이 이미 적용했어도 다시 적용해도 같다(create or replace·drop trigger if exists)
  runA = seedDevice(db, U.A, 'runner'); appA = seedDevice(db, U.A, 'app'); runC = seedDevice(db, U.C, 'runner'); seedDevice(db, U.B, 'app');
  S.PA = space('personal', U.A); S.PB = space('personal', U.B); S.PC = space('personal', U.C);
  S.T1 = space('team', U.B, 'Beyond 팀'); S.T2 = space('team', U.B, 'Lumen 연구'); S.T3 = space('team', U.C, 'Orbit');
  smember(S.T1, U.B, 'owner'); smember(S.T1, U.A); smember(S.T2, U.B, 'owner'); smember(S.T2, U.A); smember(S.T3, U.C, 'owner');
  G.A1 = agent(U.A, 'research'); G.A2 = agent(U.A, 'tidy'); G.C1 = agent(U.C, 'orbit');
  seat(G.A1, S.T1); seat(G.A2, S.T1); seat(G.A1, S.T2); seat(G.C1, S.T3);
  R.dm = room(S.PA, 'private', '', [U.A], [G.A1]); // 주인 혼자 1:1
  R.friend = room(S.PB, 'private', '', [U.B], [G.A1]); // 친구(B) 개인 공간에서 내 에이전트와 1:1 — 나는 방 멤버가 아니다
  R.gen = room(S.T1, 'open', '일반', [U.A, U.B], [G.A1, G.A2]);
  R.lab = room(S.T2, 'open', '연구실', [U.A, U.B], [G.A1]);
  R.plan = room(S.T1, 'private', '기획', [U.A, U.B]); // 내 에이전트 없음
  R.old = room(S.T1, 'private', '옛 방', [U.A, U.B], [G.A1]);
  R.others = room(S.T3, 'private', '남의 방', [U.C], [G.C1]);
});

test('혼합: 넣은 방마다 1행 — 팀 방·개인 1:1·친구 공간 방은 내 에이전트와 공간 종류, 내 에이전트 없는 방·남의 방·없는 방은 빈 목록·공간 없음', { skip }, () => {
  const rows = rooms(runA, [R.dm, R.friend, R.gen, R.lab, R.plan, R.others, NONE, R.gen, null]);
  assert.equal(rows.length, 7, '중복·null은 한 번·빼고, 나머지는 방마다 1행');
  const by = byRoom(rows);
  assert.deepEqual([by[R.dm].agents, by[R.dm].space_id, by[R.dm].space_kind], [[G.A1], S.PA, 'personal']);
  assert.deepEqual([by[R.friend].agents, by[R.friend].space_kind], [[G.A1], 'personal'], '친구 공간 방도 내 에이전트가 일하는 방');
  assert.deepEqual([by[R.gen].agents, by[R.gen].space_id, by[R.gen].space_kind], [[G.A1, G.A2].sort(), S.T1, 'team']);
  assert.deepEqual([by[R.lab].agents, by[R.lab].space_id, by[R.lab].space_kind], [[G.A1], S.T2, 'team']);
  for (const k of [R.plan, R.others, NONE]) assert.deepEqual([by[k].agents, by[k].space_id, by[k].space_kind], [[], null, null], `노출 0: ${k}`);
  const c = byRoom(rooms(runC, [R.gen, R.others]));
  assert.deepEqual([c[R.gen].agents, c[R.gen].space_id], [[], null], 'C는 내 에이전트가 없는 남의 팀 방을 알 수 없다');
  assert.deepEqual([c[R.others].agents, c[R.others].space_kind], [[G.C1], 'team']);
});

test('기기: runner·resident만 — 앱 기기는 msgr2_runner_only, 기기 없음은 msgr2_device_invalid, 501개는 msgr2_too_many_rooms', { skip }, () => {
  assert.match(db.asErr(appA.uid, appA.sid, 'select * from public.msgr2_agent_rooms(' + arr([R.gen]) + ')') ?? '', /msgr2_runner_only/);
  assert.match(db.asErr(U.A, '00000000-0000-4000-8000-000000000000', 'select * from public.msgr2_agent_rooms(' + arr([R.gen]) + ')') ?? '', /msgr2_device_invalid/);
  const many = Array.from({ length: 501 }, (_, i) => `e2000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.match(db.asErr(runA.uid, runA.sid, 'select * from public.msgr2_agent_rooms(' + arr(many) + ')') ?? '', /msgr2_too_many_rooms/);
  assert.equal(rooms(runA, many.slice(0, 500)).length, 500, '500개는 된다');
  assert.equal(db.sql("select provolatile from pg_proc where proname = 'msgr2_agent_rooms'"), 's', 'stable');
});

test('읽기만: 여러 번 불러도 방·멤버·파견·공간·에이전트 표 쓰기 0(xmin 그대로), 알림 0', { skip }, () => {
  const snap = () => ['msgr2_rooms', 'msgr2_room_members', 'msgr2_agent_seats', 'msgr2_spaces', 'msgr2_space_members', 'msgr2_agents'].map((tb) => db.xmins(tb)).join('|');
  const before = snap(); const sent = scopeSends(U.A);
  for (let i = 0; i < 3; i++) rooms(runA, [R.dm, R.gen, R.lab, R.plan]);
  assert.equal(snap(), before); assert.equal(scopeSends(U.A), sent);
});

test('방에서 에이전트 빼기: 그 방만 빈 목록, 다른 방은 그대로 + 주인에게 알림 1번(봉투는 약속 v1을 통과하고 옛 본체는 답하지 않는다)', { skip }, () => {
  const sent = scopeSends(U.A);
  db.sql('update public.msgr2_room_members set removed_at = now() where room_id = ' + q(R.gen) + " and member_kind = 'agent' and member_id = " + q(G.A2));
  const by = byRoom(rooms(runA, [R.gen, R.lab]));
  assert.deepEqual(by[R.gen].agents, [G.A1], 'A2만 빠짐'); assert.deepEqual(by[R.lab].agents, [G.A1]);
  assert.equal(scopeSends(U.A), sent + 1);
  const env = lastScope(U.A).envelope;
  assert.deepEqual(validateEnvelope(env, { from: 'server' }), { ok: true });
  assert.deepEqual([env.type, env.work, env.agent, env.device, env.data], ['agent.scope', null, null, null, {}]);
  assert.equal(unsupportedReply(env, { id: env.id, seq: 1, device: runA.dev }), null, '이 type을 모르는 옛 본체는 일 없는 봉투에 답하지 않는다(link.mjs unknownType)');
  assert.equal(scopeSends(U.B), 0, '사람 행이 아닌 에이전트 행 — 다른 사람에게는 보내지 않는다');
});

test('파견 해제: 그 공간의 방 모두 빈 목록(방 멤버 행이 남아 있어도), 다른 공간은 그대로 + 알림', { skip }, () => {
  const sent = scopeSends(U.A);
  db.sql('update public.msgr2_agent_seats set removed_at = now() where agent_id = ' + q(G.A1) + ' and space_id = ' + q(S.T2));
  const by = byRoom(rooms(runA, [R.lab, R.gen, R.dm]));
  assert.deepEqual([by[R.lab].agents, by[R.lab].space_id], [[], null]);
  assert.deepEqual(by[R.gen].agents, [G.A1]); assert.deepEqual(by[R.dm].agents, [G.A1]);
  assert.equal(scopeSends(U.A), sent + 1);
});

test('방 보관은 그대로, 은퇴한 에이전트는 빠진다', { skip }, () => {
  db.sql('update public.msgr2_rooms set archived_at = now() where id = ' + q(R.old));
  assert.deepEqual(byRoom(rooms(runA, [R.old]))[R.old].agents, [G.A1], '보관 방은 읽을 수 있다(기억 유지)');
  db.sql("update public.msgr2_agents set status = 'retired' where id = " + q(G.A2));
  assert.equal(byRoom(rooms(runA, [R.gen]))[R.gen].agents.includes(G.A2), false);
});

test('조직 탈퇴(_msgr2_space_drop): 그 조직 방 전부 빈 목록, 여러 행이 닫혀도 알림은 1번, 개인 방은 그대로', { skip }, () => {
  const sent = scopeSends(U.A);
  db.sql('select public._msgr2_space_drop(' + q(S.T1) + ', ' + q(U.A) + ')');
  const by = byRoom(rooms(runA, [R.gen, R.old, R.dm, R.friend]));
  for (const k of [R.gen, R.old]) assert.deepEqual([by[k].agents, by[k].space_kind], [[], null]);
  assert.deepEqual(by[R.dm].agents, [G.A1]); assert.deepEqual(by[R.friend].agents, [G.A1]);
  assert.equal(scopeSends(U.A), sent + 1, '공간 멤버·방 멤버·파견 행이 한 트랜잭션에서 닫힘 — 사람마다 1번');
});

test('손님 만료: 시각이 지나면 빈 목록(사건 없음 — 알림 0), 기한을 지금 이전으로 당기면 알림', { skip }, () => {
  const T4 = space('team', U.C, 'Guest 팀'); smember(T4, U.C, 'owner'); smember(T4, U.A, 'guest', new Date(Date.now() + 3_600_000).toISOString());
  seat(G.A1, T4); const r = room(T4, 'private', '손님 방', [U.A, U.C], [G.A1]);
  assert.deepEqual(byRoom(rooms(runA, [r]))[r].agents, [G.A1]);
  const sent = scopeSends(U.A);
  db.sql('update public.msgr2_space_members set expires_at = now() - interval \'1 minute\' where space_id = ' + q(T4) + ' and user_id = ' + q(U.A));
  assert.deepEqual(byRoom(rooms(runA, [r]))[r].agents, [], '기한 지난 손님');
  assert.equal(scopeSends(U.A), sent + 1, '기한을 당긴 쓰기는 알림');
  db.sql('update public.msgr2_space_members set expires_at = now() + interval \'1 hour\' where space_id = ' + q(T4) + ' and user_id = ' + q(U.A));
  assert.equal(scopeSends(U.A), sent + 1, '늘리는 쓰기는 알림 없음');
});

test('공간 삭제: 그 공간 방 빈 목록 + 파견된 에이전트 주인마다 알림', { skip }, () => {
  const T5 = space('team', U.C, 'Del 팀'); smember(T5, U.C, 'owner'); smember(T5, U.A); seat(G.A1, T5); seat(G.C1, T5);
  const r = room(T5, 'open', '곧 지움', [U.A, U.C], [G.A1, G.C1]);
  const a0 = scopeSends(U.A), c0 = scopeSends(U.C);
  db.sql('update public.msgr2_spaces set deleted_at = now() where id = ' + q(T5));
  assert.deepEqual(byRoom(rooms(runA, [r]))[r].agents, []); assert.deepEqual(byRoom(rooms(runC, [r]))[r].agents, []);
  assert.equal(scopeSends(U.A), a0 + 1); assert.equal(scopeSends(U.C), c0 + 1);
});

test('되돌림: 함수·트리거가 사라지고 빠짐에도 알림 0, 다시 적용하면 돌아온다', { skip }, () => {
  db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
  assert.equal(db.sql("select count(*) from pg_proc where proname in ('msgr2_agent_rooms', '_msgr2_scope_notify', 'msgr2_scope_on_room_member', 'msgr2_scope_on_seat', 'msgr2_scope_on_space_member', 'msgr2_scope_on_space')"), '0');
  assert.equal(db.sql("select count(*) from pg_trigger where tgname like 'msgr2_scope_%'"), '0');
  const sent = scopeSends(U.A);
  db.sql('update public.msgr2_room_members set removed_at = now() where room_id = ' + q(R.dm) + " and member_kind = 'agent'");
  assert.equal(scopeSends(U.A), sent);
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  assert.equal(db.sql("select count(*) from pg_trigger where tgname like 'msgr2_scope_%'"), '4');
  assert.deepEqual(byRoom(rooms(runA, [R.dm]))[R.dm].agents, [], '되돌림 동안 닫힌 행도 지금 판정에 반영');
});
