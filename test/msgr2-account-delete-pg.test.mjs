// 메신저 v2 계정 삭제 정리(20261026120000, 감사 결함 4) — 옛 msgr 전체 + msgr2를 운영 순서로 적용한 DB(setupFull)에서 본다.
// 승인 범위(유건 2026-10-26 "응 지우고 팀 글을 익명으로 바꾸기", 총괄 확정): 탈퇴자 v2 멤버십 닫기·에이전트 은퇴,
// 탈퇴자가 쓴 글 중 개인 공간 방의 글만 지운 글로(친구 글·탈퇴자 소유 개인 공간의 친구 글은 그대로), 팀 방 글은 지우지 않고 "탈퇴한 사용자"로 익명화, 소급 없음.
// 경우 표 칸 = 아래 test 이름(팀 멤버 탈퇴·개인 공간만·진행 중 일·다른 사용자 불변·팀 주인 막힘·재호출 멱등·기기 행 없는 옛 세션·잠금 유지·되돌림).
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-account-delete-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-account-delete-pg.test.mjs';
const UP = fileURLToPath(new URL('../supabase/migrations/20261026120000_msgr2_account_delete.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261026120000_msgr2_account_delete.down.sql', import.meta.url));
const id = (n) => `d6000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let db;
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const users = (u) => db.sql(`select count(*) from auth.users where id = '${u}'`);
const msg = (mid) => JSON.parse(db.sql(`select to_jsonb(m) from public.msgr2_messages m where id = ${mid}`));
const xmin = (t, where) => db.sql(`select coalesce(string_agg(xmin::text, ',' order by ctid), '') from public.${t} where ${where}`);

// 시드(서비스 문맥) — 사람 한 명분: 개인 공간 + 앱 기기
const person = (u) => {
  const dev = seedDevice(db, u, 'app');
  const ps = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('personal', '', '${u}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${ps}', '${u}', 'owner')`);
  return { uid: u, sid: dev.sid, ps };
};
const team = (owner, name, members = []) => {
  const s = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', ${q(name)}, '${owner}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${s}', '${owner}', 'owner')`);
  for (const m of members) db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${s}', '${m}', 'member')`);
  return s;
};
const room = (space, kind, people, pair = null) => {
  const r = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key, name) values ('${space}', '${kind}', ${pair ? q(pair) : 'null'}, 'r') returning id`);
  for (const u of people) db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${r}', 'user', '${u}')`);
  return r;
};
const say = (u, r, body) => db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, meta) values ('${r}', 'user', '${u}', ${q(body)}, '{"k":1}') returning id`);
const agent = (owner, slug, hosting = 'local') => db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name, hosting) values ('${owner}', 'ws', '${slug}', '${slug}', '${hosting}') returning id`);
const seat = (ag, space, r) => {
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id) values ('${ag}', '${space}')`);
  if (r) db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${r}', 'agent', '${ag}')`);
};
const work = (r, ag, owner, from, state) => db.sql(`insert into public.msgr2_works (room_id, agent_id, owner_user_id, from_kind, from_id, root_user_id, tier, state, expires_at)
  values ('${r}', '${ag}', '${owner}', 'user', '${from}', '${from}', 'team', '${state}', now() + interval '30 minutes') returning id`);
const deleteMe = (p) => db.asErr(p.uid, p.sid, 'select public.msgr_delete_me()');
/** 사람 문맥(auth.uid) + 계정 삭제 표지로 한 문장을 돌리고 되돌린다 — 잠금 트리거 판정만 본다 */
const asFlag = (uid, flag, text) => db.raw(['-A', '-t', '-c', `begin; select set_config('argo.uid', '${uid}', true), set_config('argo.msgr_account_delete', '${flag}', true); ${text}; rollback;`]);

// 등장인물: O 팀 주인(남음) · X 탈퇴자(팀 멤버) · F 친구(남음) · Y 다른 팀 주인(막힘) · M Y 팀 멤버 · Z 혼자인 팀 주인 · V 기기 행 없는 옛 세션
const O = id(1), X = id(2), F = id(3), Y = id(4), M = id(5), Z = id(6), V = id(7);
let x, y, z, T, TR, XF, FG, AX, AF, BX, wX, wF, wXdone, tm, xp, xd, fp, fg, xg, ot, yTeamMsg, zSolo;

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  person(O); x = person(X); const f = person(F); y = person(Y); person(M); z = person(Z);
  T = team(O, 'Team O', [X, F]);
  TR = room(T, 'open', [O, X, F]);
  XF = room(x.ps, 'direct', [X, F], `${X}:${F}`); // 탈퇴자 소유 개인 공간의 1:1
  FG = room(f.ps, 'private', [F, X]); // 친구 소유 개인 공간의 방(탈퇴자도 멤버)
  // 글은 에이전트를 방에 넣기 전에(사람 글이 일을 만들지 않게)
  tm = say(X, TR, 'team note by X'); ot = say(O, TR, 'team note by O');
  xp = say(X, XF, 'private hello from X'); fp = say(F, XF, 'reply from F in X space');
  xg = say(X, FG, 'X in F space'); fg = say(F, FG, 'F in own space');
  xd = say(X, XF, 'already deleted'); db.sql(`update public.msgr2_messages set body = '', deleted_at = now() - interval '1 day' where id = ${xd}`);
  // 에이전트: X 로컬(팀 파견·방 멤버), X 봇(토큰), F 로컬(팀 파견)
  AX = agent(X, 'ax'); seat(AX, T, TR);
  BX = agent(X, 'bx', 'bot');
  db.sql(`insert into public.msgr2_bots (agent_id, owner_user_id, kind, host, ext_id, token_hash, token_hint) values ('${BX}', '${X}', 'hermes', 'h', 'e', 'h-${randomUUID()}', 'hint')`);
  AF = agent(F, 'af'); seat(AF, T, TR);
  wX = work(TR, AX, X, O, 'running'); // O가 X 에이전트에 맡긴 일(진행 중)
  wXdone = work(TR, AX, X, O, 'done');
  wF = work(TR, AF, F, X, 'running'); // X가 F 에이전트에 맡긴 일
  const T2 = team(Y, 'Team Y', [M]); yTeamMsg = say(Y, room(T2, 'open', [Y, M]), 'Y in team'); // 막힘: M이 활동 중인 팀의 주인 Y
  zSolo = team(Z, 'Solo Z'); // 혼자인 팀 주인 Z
});

test('팀 멤버 탈퇴: 팀 방 글은 본문 그대로 "탈퇴한 사용자"(system·작성자 없음·meta.deleted_user), 멤버십·방 멤버 닫힘, 에이전트 은퇴(파견·방 멤버 닫힘, 봇 토큰 폐기), 계정 삭제, 글 방송 0', { skip }, () => {
  const sentBefore = db.sql(`select count(*) from realtime.sent where event = 'msg'`);
  assert.equal(deleteMe(x), null, 'msgr_delete_me 성공');
  assert.equal(users(X), '0', '계정 삭제');
  const t = msg(tm);
  assert.deepEqual([t.author_kind, t.author_user_id, t.body, t.deleted_at, t.meta], ['system', null, 'team note by X', null, { k: 1, deleted_user: true }], '팀 글 익명화(본문·meta 유지)');
  assert.equal(db.sql(`select count(*) from public.msgr2_space_members where user_id = '${X}' and removed_at is null`), '0', '공간 멤버십 모두 닫힘(팀·개인)');
  assert.equal(db.sql(`select count(*) from public.msgr2_room_members where member_kind = 'user' and member_id = '${X}' and removed_at is null`), '0', '방 멤버(남의 개인 공간 방 포함) 닫힘');
  assert.equal(db.sql(`select string_agg(status, ',' order by slug) from public.msgr2_agents where owner_user_id = '${X}'`), 'retired,retired', '로컬·봇 에이전트 은퇴');
  assert.equal(db.sql(`select count(*) from public.msgr2_agent_seats where agent_id = '${AX}' and removed_at is null`), '0', '파견 닫힘');
  assert.equal(db.sql(`select count(*) from public.msgr2_room_members where member_kind = 'agent' and member_id = '${AX}' and removed_at is null`), '0', '에이전트 방 멤버 닫힘');
  assert.equal(db.sql(`select count(*) from public.msgr2_bots where agent_id = '${BX}' and revoked_at is null`), '0', '봇 토큰 폐기');
  assert.equal(db.sql(`select count(*) from realtime.sent where event = 'msg'`), sentBefore, '글 익명화·지운 표시는 글마다 방송하지 않는다');
});

test('개인 공간만: 탈퇴자가 개인 공간 방에 쓴 글은 지운 글(본문·멘션·meta 비움, deleted_at) + 익명화, 친구 글은 그대로(탈퇴자 소유 개인 공간 안의 친구 글 포함), 이미 지운 글의 시각은 그대로', { skip }, () => {
  for (const mid of [xp, xg]) {
    const m = msg(mid);
    assert.deepEqual([m.author_kind, m.author_user_id, m.body, m.meta, m.mentions], ['system', null, '', { deleted_user: true }, []], `개인 공간 글 ${mid} 지움`);
    assert.ok(m.deleted_at, '지운 시각');
  }
  assert.ok(Date.parse(msg(xd).deleted_at) < Date.now() - 3600_000, '이미 지운 글은 처음 지운 시각 그대로');
  for (const [mid, body] of [[fp, 'reply from F in X space'], [fg, 'F in own space']]) {
    const m = msg(mid);
    assert.deepEqual([m.author_kind, m.author_user_id, m.body, m.deleted_at], ['user', F, body, null], `친구 글 ${mid} 그대로`);
  }
  assert.equal(db.sql(`select count(*) from public.msgr2_rooms where id in ('${XF}', '${FG}')`), '2', '방은 남는다(친구가 계속 읽는다)');
  assert.equal(db.sql(`select count(*) from public.msgr2_room_members where room_id = '${XF}' and member_id = '${F}' and removed_at is null`), '1', '친구는 탈퇴자 소유 공간의 1:1에 그대로');
});

test('진행 중 일: 탈퇴자 에이전트가 맡은 진행 중인 일은 취소, 끝난 일은 그대로, 탈퇴자가 친구 에이전트에 맡긴 일은 그대로 진행', { skip }, () => {
  assert.equal(db.sql(`select state from public.msgr2_works where id = '${wX}'`), 'cancelled');
  assert.equal(db.sql(`select state from public.msgr2_works where id = '${wXdone}'`), 'done');
  assert.equal(db.sql(`select state from public.msgr2_works where id = '${wF}'`), 'running');
});

test('다른 사용자 불변: 다른 사람이 탈퇴해도 남은 사람의 글·멤버십·에이전트·파견·방 멤버 행은 다시 쓰이지 않는다(xmin 그대로)', { skip }, () => {
  const keep = [['msgr2_messages', `author_user_id in ('${O}', '${F}', '${Y}')`], ['msgr2_space_members', `user_id in ('${O}', '${F}', '${Y}', '${M}')`],
    ['msgr2_agents', `owner_user_id = '${F}'`], ['msgr2_agent_seats', `agent_id = '${AF}'`], ['msgr2_room_members', `member_id in ('${O}', '${F}', '${Y}', '${M}', '${AF}')`]];
  const before = keep.map(([t, w]) => xmin(t, w));
  assert.equal(deleteMe(z), null, '혼자인 팀의 주인은 지울 수 있다');
  assert.equal(users(Z), '0');
  assert.deepEqual(keep.map(([t, w]) => xmin(t, w)), before);
  assert.equal(msg(ot).author_user_id, O, 'O의 팀 글 작성자 그대로');
  assert.equal(db.sql(`select count(*) from public.msgr2_space_members where space_id = '${zSolo}' and removed_at is null`), '0', 'Z의 혼자 팀 멤버십 닫힘');
});

test('팀 주인 막힘 유지: 다른 활동 멤버가 있는 v2 팀의 주인은 msgr_owner_transfer_required, 계정·글·멤버십·에이전트 모두 그대로(트랜잭션째 되돌림)', { skip }, () => {
  const ya = agent(Y, 'ya');
  const keep = [['msgr2_messages', `id = ${yTeamMsg}`], ['msgr2_space_members', `user_id = '${Y}'`], ['msgr2_agents', `id = '${ya}'`]];
  const before = keep.map(([t, w]) => xmin(t, w));
  assert.match(deleteMe(y) ?? '', /msgr_owner_transfer_required: Team Y/);
  assert.equal(users(Y), '1');
  assert.deepEqual(keep.map(([t, w]) => xmin(t, w)), before);
  assert.equal(msg(yTeamMsg).author_user_id, Y);
});

test('재호출 멱등: 이미 정리한 사람을 다시 정리해도 바뀌는 행이 없다(쓰기 0, 반환 0건)', { skip }, () => {
  const keep = ['msgr2_messages', 'msgr2_space_members', 'msgr2_room_members', 'msgr2_agents', 'msgr2_agent_seats', 'msgr2_works', 'msgr2_bots'];
  const before = keep.map((t) => xmin(t, 'true'));
  assert.deepEqual(JSON.parse(db.sql(`select public._msgr2_account_delete('${X}')`)), { deleted_msgs: 0, anonymized_msgs: 0, spaces: 0, agents: 0 });
  assert.deepEqual(keep.map((t) => xmin(t, 'true')), before);
});

test('기기 행 없는 옛 세션(옛 v1 앱): 종전대로 지우고 v2 정리도 한다', { skip }, () => {
  db.sql(`insert into auth.users (id) values ('${V}') on conflict do nothing`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${T}', '${V}', 'member')`);
  const vm = say(V, TR, 'v1 era note');
  assert.equal(db.asErr(V, randomUUID(), 'select public.msgr_delete_me()'), null);
  assert.equal(users(V), '0');
  assert.deepEqual([msg(vm).author_kind, msg(vm).author_user_id, msg(vm).body], ['system', null, 'v1 era note']);
  assert.equal(db.sql(`select count(*) from public.msgr2_space_members where user_id = '${V}' and removed_at is null`), '0');
});

test('잠금 유지: 표지가 있어도 남의 글 작성자·내 글의 다른 열·다른 작성자 종류로는 못 바꾸고, 표지가 없으면 내 글도 못 바꾼다', { skip }, () => {
  const mine = say(O, TR, 'O again'); const other = say(F, TR, 'F again');
  assert.match(asFlag(O, '1', `update public.msgr2_messages set author_kind = 'system', author_user_id = null where id = ${other}`).stderr, /msgr2_immutable_author_kind/, '남의 글');
  assert.match(asFlag(O, '1', `update public.msgr2_messages set author_kind = 'system', author_user_id = null, room_id = '${XF}' where id = ${mine}`).stderr, /msgr2_immutable_room_id/, '다른 열');
  assert.match(asFlag(O, '', `update public.msgr2_messages set author_kind = 'system', author_user_id = null where id = ${mine}`).stderr, /msgr2_immutable_author_kind/, '표지 없음');
  assert.match(asFlag(O, '1', `update public.msgr2_messages set author_kind = 'agent', author_user_id = null, author_agent_id = '${AF}' where id = ${mine}`).stderr, /msgr2_immutable_author_kind/, '에이전트 글로 바꾸기');
  const ok = asFlag(O, '1', `update public.msgr2_messages set author_kind = 'system', author_user_id = null where id = ${mine}`);
  assert.equal(ok.status, 0, `표지 + 내 글 + system·null만 열린다 ${ok.stderr}`);
});

test('되돌림 → 다시 적용: 되돌리면 계정 삭제가 v2를 건드리지 않고(옛 동작), 다시 적용하면 정리한다(두 번 적용해도 그대로)', { skip }, () => {
  db.psql(['-c', readFileSync(DOWN, 'utf8')]);
  assert.equal(db.sql(`select to_regprocedure('public._msgr2_account_delete(uuid)') is null`), 't', '새 함수 없음');
  const a = person(id(20)); db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${T}', '${a.uid}', 'member')`);
  const am = say(a.uid, TR, 'after down');
  assert.equal(deleteMe(a), null);
  assert.deepEqual([msg(am).author_kind, msg(am).author_user_id], ['user', a.uid], '옛 동작: v2 글 그대로');
  assert.match(asFlag(O, '1', `update public.msgr2_messages set author_kind = 'system', author_user_id = null where id = ${ot}`).stderr, /msgr2_immutable_author_kind/, '되돌린 잠금은 표지가 있어도 막는다');
  db.psql(['-c', readFileSync(UP, 'utf8')]);
  db.psql(['-c', readFileSync(UP, 'utf8')]);
  const b = person(id(21)); db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${T}', '${b.uid}', 'member')`);
  const bm = say(b.uid, TR, 'after up');
  assert.equal(deleteMe(b), null);
  assert.deepEqual([msg(bm).author_kind, msg(bm).author_user_id, msg(bm).body], ['system', null, 'after up'], '다시 적용하면 익명화');
});
