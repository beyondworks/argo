// v2에서 직접 쓰기가 거부되던 화면 동작의 서버 함수(재공개 전 검수 F7, 20261023180000 F7절) — setupFull(옛 msgr 전체 + msgr2)에서 본다. 시험용 방·글만 쓴다.
// 경우: 방 보관·기억·이름(msgr2_room_set) = 1:1 참가자·만든 사람(방에 있음)·관리자만, 남의 방·일반 멤버·본체 기기 거부, 1:1 이름 거부, 같은 값이면 쓰기 0 /
//      내 표시 이름(msgr2_space_display_name_set) = 본인 행만, 40자 넘으면 거부, 빈 값 = 지움 /
//      글 고치기·지우기(msgr2_message_edit·delete) = 내 사람 글만, 남의 글·에이전트 글·지운 글 고치기 거부, 지우기는 지운 표시(행은 남음) /
//      직접 update는 여전히 권한 없음 / 되돌림 파일을 적용하면 함수가 없어진다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-f7-writes-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-f7-writes-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261023180000_msgr2_seat_keep_pro_attach.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261023180000_msgr2_seat_keep_pro_attach.down.sql', import.meta.url));
const id = (n) => `d7000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = id(1), M = id(2), C = id(3), X = id(4);
let db, oApp, oRun, mApp, cApp, xApp, PS, TS, AG;
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const call = (who, sql) => JSON.parse(db.as(who.uid, who.sid, `select ${sql}`));
const set = (who, room, args) => call(who, `public.msgr2_room_set('${room}'${args})`);
const col = (room, c) => db.sql(`select ${c} from public.msgr2_rooms where id = '${room}'`);
const say = (who, room, body) => db.as(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${room}', 'user', '${who.uid}', ${q(body)}) returning id`);
const room = (space, kind, name, by, members) => {
  const r = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key, name, created_by) values ('${space}', '${kind}', ${kind === 'direct' ? q('pk-' + name) : 'null'}, ${q(name)}, ${by ? q(by) : 'null'}) returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ${members.map(([k, m]) => `('${r}', '${k}', '${m}')`).join(', ')}`);
  return r;
};

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  oApp = seedDevice(db, O, 'app'); oRun = seedDevice(db, O, 'runner'); mApp = seedDevice(db, M, 'app'); cApp = seedDevice(db, C, 'app'); xApp = seedDevice(db, X, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  TS = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '팀', '${M}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner'), ('${TS}', '${M}', 'owner'), ('${TS}', '${O}', 'member'), ('${TS}', '${C}', 'member'), ('${TS}', '${X}', 'member')`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'a', '에이') returning id`);
});

test('방 보관·기억·이름: 권한 있는 사람만, 남의 방·일반 멤버·본체 기기는 거부(행 그대로)', { skip }, () => {
  const R = room(TS, 'private', '방', C, [['user', C], ['user', O]]);
  assert.equal(set(xApp, R, ", p_memory => false").code, 'forbidden', '방 밖 멤버');
  assert.equal(set(oApp, R, ", p_name => '바꿈'").code, 'forbidden', '방 안 일반 멤버');
  assert.match(db.asErr(C, seedDevice(db, C, 'runner').sid, `select public.msgr2_room_set('${R}', p_memory => false)`) ?? '', /msgr2_app_device_required/, '본체 기기');
  assert.equal(col(R, 'name') + '/' + col(R, 'memory'), '방/t');
  assert.equal(set(cApp, R, ", p_name => '  새 이름 ', p_memory => false").ok, true, '만든 사람(방에 있음)');
  assert.equal(col(R, 'name') + '/' + col(R, 'memory'), '새 이름/f');
  const x0 = db.xmins('msgr2_rooms');
  assert.equal(set(cApp, R, ", p_name => '새 이름', p_memory => false").changed, false, '같은 값');
  assert.equal(db.xmins('msgr2_rooms'), x0, '같은 값이면 쓰기 0');
  assert.equal(set(cApp, R, ", p_name => ''").code, 'bad_request', '빈 이름');
  assert.equal(set(cApp, R, `, p_name => ${q('가'.repeat(81))}`).code, 'bad_request', '81자');
  assert.equal(set(mApp, R, ", p_archive => true").code, 'forbidden', '비공개 방 밖 관리자(읽을 수 없음)');
  assert.equal(set(cApp, R, ", p_archive => false").code, 'bad_request', '보관 되돌리기는 없다');
  assert.equal(set(cApp, R, ", p_archive => true").ok, true, '보관');
  assert.notEqual(col(R, 'archived_at'), '', '보관 시각');
  assert.equal(set(cApp, R, ", p_memory => true").code, 'archived', '보관한 방은 설정을 바꾸지 않는다');
  const OP = room(TS, 'open', '공개', C, [['user', C]]);
  assert.equal(set(mApp, OP, ", p_name => '관리자가'").ok, true, '팀 관리자(공개 방)');
  assert.match(db.asErr(C, cApp.sid, `update public.msgr2_rooms set name = 'x' where id = '${OP}'`) ?? '', /permission denied/, '직접 update는 여전히 권한 없음');
});

test('1:1: 참가자는 보관·기억을 바꾸고 이름은 바꾸지 못한다, 밖의 사람은 거부', { skip }, () => {
  const D = room(PS, 'direct', 'oa', O, [['user', O], ['agent', AG]]);
  assert.equal(set(xApp, D, ", p_memory => false").code, 'forbidden', '1:1 밖');
  assert.equal(set(oApp, D, ", p_name => '이름'").code, 'bad_request', '1:1 이름');
  assert.equal(set(oApp, D, ", p_memory => false").ok, true, '1:1 기억 끄기');
  assert.equal(col(D, 'memory'), 'f');
  assert.equal(set(oApp, D, ", p_archive => true").ok, true, '1:1 보관');
});

test('내 표시 이름: 본인 행만, 40자 넘으면 거부, 빈 값 = 지움, 같은 값이면 쓰기 0', { skip }, () => {
  const nm = () => db.sql(`select coalesce(display_name, '-') from public.msgr2_space_members where space_id = '${TS}' and user_id = '${O}'`);
  assert.equal(call(oApp, `public.msgr2_space_display_name_set('${TS}', '  오 ')`).ok, true);
  assert.equal(nm(), '오');
  const x0 = db.xmins('msgr2_space_members');
  assert.equal(call(oApp, `public.msgr2_space_display_name_set('${TS}', '오')`).changed, false);
  assert.equal(db.xmins('msgr2_space_members'), x0, '같은 값이면 쓰기 0');
  assert.equal(call(oApp, `public.msgr2_space_display_name_set('${TS}', ${q('가'.repeat(41))})`).code, 'bad_request');
  assert.equal(call(oApp, `public.msgr2_space_display_name_set('${TS}', '')`).ok, true); assert.equal(nm(), '-', '빈 값 = 지움');
  const other = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '남의 팀', '${X}') returning id`);
  assert.equal(call(oApp, `public.msgr2_space_display_name_set('${other}', '침입')`).code, 'forbidden', '멤버가 아닌 공간');
  db.sql(`update public.msgr2_space_members set removed_at = now() where space_id = '${TS}' and user_id = '${C}'`);
  assert.equal(call(cApp, `public.msgr2_space_display_name_set('${TS}', '나감')`).code, 'forbidden', '내보내진 멤버');
});

test('글 고치기·지우기: 내 사람 글만, 남의 글·에이전트 글 거부, 지우기는 지운 표시(행은 남음)', { skip }, () => {
  const R = room(TS, 'private', '글방', M, [['user', M], ['user', O]]);
  const mine = say(oApp, R, '원문');
  const theirs = say(mApp, R, '남의 글');
  const agentMsg = db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_agent_id, body) values ('${R}', 'agent', '${AG}', '에이전트') returning id`);
  const body = (m) => db.sql(`select body || '|' || (edited_at is not null) || '|' || (deleted_at is not null) from public.msgr2_messages where id = ${m}`);
  assert.equal(call(mApp, `public.msgr2_message_edit(${mine}, '남이 고침')`).code, 'forbidden', '남의 글 고치기');
  assert.equal(call(oApp, `public.msgr2_message_edit(${agentMsg}, '주인이 고침')`).code, 'forbidden', '에이전트 글(내 에이전트라도)');
  assert.match(db.asErr(O, oRun.sid, `select public.msgr2_message_edit(${mine}, '본체')`) ?? '', /msgr2_app_device_required/, '본체 기기');
  assert.equal(call(oApp, `public.msgr2_message_edit(${mine}, '  ')`).code, 'bad_request', '빈 본문');
  assert.equal(call(oApp, `public.msgr2_message_edit(${mine}, '고친 글')`).ok, true);
  assert.equal(body(mine), '고친 글|true|false');
  assert.equal(call(oApp, `public.msgr2_message_delete(${theirs})`).code, 'forbidden', '남의 글 지우기');
  assert.equal(body(theirs), '남의 글|false|false');
  assert.equal(call(oApp, `public.msgr2_message_delete(${mine})`).ok, true);
  assert.equal(body(mine), '|true|true', '지운 표시, 행은 남음');
  assert.equal(call(oApp, `public.msgr2_message_edit(${mine}, '되살림')`).code, 'forbidden', '지운 글은 고치지 못한다');
  assert.match(db.asErr(O, oApp.sid, `update public.msgr2_messages set body = 'x' where id = ${mine}`) ?? '', /permission denied/, '직접 update는 여전히 권한 없음');
  db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${R}' and member_id = '${O}'`);
  const again = say(mApp, R, '나간 뒤');
  assert.equal(call(mApp, `public.msgr2_message_edit(${again}, '고침')`).ok, true, '방에 있는 글쓴이');
  assert.equal(call(oApp, `public.msgr2_message_delete(${mine})`).code, 'forbidden', '방을 나간 뒤에는 읽을 수 없어 거부');
});

test('되돌림 파일을 적용하면 F7 함수가 없어지고, 다시 적용하면 원래대로', { skip }, () => {
  const names = "('msgr2_room_set', 'msgr2_space_display_name_set', 'msgr2_message_edit', 'msgr2_message_delete')";
  db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
  assert.equal(db.sql(`select count(*) from pg_proc where proname in ${names}`), '0');
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  assert.equal(db.sql(`select count(*) from pg_proc where proname in ${names}`), '4');
});
