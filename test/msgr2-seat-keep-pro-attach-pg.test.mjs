// 메신저 재공개 전 검수 F1 서버·F4(20261023180000) — 실제 Postgres에서 본다.
// F1: msgr2_seat_ensure = 자리가 없으면 'all'로 만들고, 있으면 주인이 정한 범위('나만'·'지정한 사람')를 그대로 둔다(빠졌던 자리는 되살리되 범위 보존).
//     그 뒤에도 범위 판정이 그대로 걸린다: 팀 멤버가 '나만' 에이전트를 불러도 일이 생기지 않고, 주인은 된다. 옛 길(msgr2_set_seat 'all')이 덮어쓰던 것을 재현해 대조한다.
// F4: Pro가 끝난 계정은 옛 기기로 첨부를 올리지 못한다(msgr2_attachment_add·_msgr2_storage_write 사람 갈래). Pro·관문 off는 종전대로 통과.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-seat-keep-pro-attach-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-seat-keep-pro-attach-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261023180000_msgr2_seat_keep_pro_attach.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261023180000_msgr2_seat_keep_pro_attach.down.sql', import.meta.url));
const O = 'f4000000-0000-4000-8000-000000000001'; // 에이전트 주인(Pro)
const M = 'f4000000-0000-4000-8000-000000000002'; // 팀 멤버(Pro)
const X = 'f4000000-0000-4000-8000-000000000003'; // 지정한 사람
const F = 'f4000000-0000-4000-8000-000000000004'; // Pro가 끝난 멤버(옛 기기는 살아 있다)
let db, oApp, oRun, mApp, xApp, fApp, TS, TR, AG;

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const seatRow = () => JSON.parse(db.sql(`select json_build_object('allow', allow, 'users', allow_users, 'removed', removed_at is not null, 'x', xmin::text) from public.msgr2_agent_seats where agent_id = '${AG}' and space_id = '${TS}'`) || 'null');
const ensure = (dev = oApp) => db.as(dev.uid, dev.sid, `select public.msgr2_seat_ensure('${AG}', '${TS}')`);
const setSeat = (allow, users = []) => db.as(oApp.uid, oApp.sid, `select public.msgr2_set_seat('${AG}', '${TS}', '${allow}', '{${users.join(',')}}'::uuid[])`);
const say = (who, body, mentions = []) => db.as(who.uid, who.sid,
  `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${TR}', 'user', '${who.uid}', ${q(body)}, '{${mentions.join(',')}}') returning id`);
const works = () => Number(db.sql(`select count(*) from public.msgr2_works where room_id = '${TR}'`));
const attach = (who, msg, i = 0) => `select public.msgr2_attachment_add(${msg}, ${i}, 'a.txt', 'text/plain', 10)`;
const canWrite = (who, path) => db.as(who.uid, who.sid, `select public._msgr2_storage_write(${q(path)})`);

before(() => {
  if (!DB) return;
  db = setup(DB); // 이 마이그레이션까지 버전 순서로 적용(관문 스위치는 끈 채)
  db.sql(`create table if not exists public.test_pro (uid uuid primary key);
    create or replace function public.is_pro_for(p uuid) returns boolean language sql stable as $$ select exists (select 1 from public.test_pro where uid = p) $$;
    insert into public.test_pro values ('${O}'), ('${M}'), ('${X}') on conflict do nothing`);
  oApp = seedDevice(db, O, 'app'); oRun = seedDevice(db, O, 'runner'); mApp = seedDevice(db, M, 'app'); xApp = seedDevice(db, X, 'app'); fApp = seedDevice(db, F, 'app');
  TS = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '검수 팀', '${O}') returning id`);
  for (const [u, role] of [[O, 'owner'], [M, 'member'], [X, 'member'], [F, 'member']]) db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${TS}', '${u}', '${role}')`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'ws', 'research', '리서치') returning id`);
  TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'open', '일반') returning id`);
  for (const u of [O, M, X, F]) db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TR}', 'user', '${u}')`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TR}', 'agent', '${AG}')`);
});

test('F1 자리가 없으면 만든다(all) — 다시 불러도 쓰기 0', { skip }, () => {
  assert.equal(seatRow(), null, '전제: 자리 없음');
  assert.equal(ensure(), 'created');
  const a = seatRow();
  assert.equal(a.allow, 'all');
  assert.equal(ensure(), 'kept');
  assert.equal(seatRow().x, a.x, '같은 값이면 쓰지 않는다(xmin 그대로)');
});

test('F1 주인이 정한 "나만"은 방에 다시 넣어도 그대로 — 팀 멤버가 불러도 일이 생기지 않고 주인은 된다', { skip }, () => {
  setSeat('owner');
  const before = seatRow();
  assert.equal(ensure(), 'kept');
  assert.deepEqual([seatRow().allow, seatRow().x], ['owner', before.x], '범위 보존, 쓰기 0');
  const n0 = works();
  say(mApp, '리서치 해줘', [AG]);
  assert.equal(works(), n0, '팀 멤버는 "나만" 에이전트에 일을 못 시킨다');
  say(oApp, '리서치 해줘', [AG]);
  assert.equal(works(), n0 + 1, '주인은 된다(하네스가 일을 실제로 만든다는 확인)');
});

test('F1 "지정한 사람"도 보존 — 지정한 사람만 되고 다른 멤버는 안 된다', { skip }, () => {
  setSeat('list', [X]);
  assert.equal(ensure(), 'kept');
  assert.deepEqual([seatRow().allow, seatRow().users], ['list', [X]]);
  const n0 = works();
  say(mApp, '해줘', [AG]); assert.equal(works(), n0, '지정 밖 멤버');
  say(xApp, '해줘', [AG]); assert.equal(works(), n0 + 1, '지정한 사람');
});

test('F1 빠졌던 자리를 다시 넣으면 되살리되 범위는 그대로(restored)', { skip }, () => {
  setSeat('owner');
  db.as(oApp.uid, oApp.sid, `select public.msgr2_set_seat('${AG}', '${TS}', 'owner', '{}'::uuid[], true)`);
  assert.equal(seatRow().removed, true, '전제: 빠짐');
  assert.equal(ensure(), 'restored');
  assert.deepEqual([seatRow().allow, seatRow().removed], ['owner', false]);
});

test('F1 대조: 옛 길(msgr2_set_seat all)은 덮어쓴다 — 앱이 이 길을 쓰지 않게 고친 이유', { skip }, () => {
  setSeat('owner');
  setSeat('all');
  assert.equal(seatRow().allow, 'all', '옛 길로 방에 넣으면 "나만"이 사라진다(검수 재현)');
  setSeat('owner'); // 다음 시험을 위해 되돌림
});

test('F1 검사는 msgr2_set_seat와 같다 — 주인 아님·앱 기기 아님은 거절, 행 그대로', { skip }, () => {
  const x0 = seatRow().x;
  assert.match(db.asErr(M, mApp.sid, `select public.msgr2_seat_ensure('${AG}', '${TS}')`) ?? '', /msgr2_forbidden/);
  assert.match(db.asErr(O, oRun.sid, `select public.msgr2_seat_ensure('${AG}', '${TS}')`) ?? '', /msgr2_app_device_required/);
  assert.equal(seatRow().x, x0);
});

test('F4 Pro가 끝난 계정은 옛 기기로 첨부를 올리지 못한다 — 행 0, Storage 쓰기 거부. Pro는 된다', { skip }, () => {
  setting('msgr2_pro_gate', null); // 운영 기본(켬)
  try {
    const fm = say(fApp, '파일 보냄'); // 사람 채팅 스위치가 꺼진 상태라 글 자체는 들어간다(이 PR 범위 밖 — 보고에 적음)
    assert.match(db.asErr(F, fApp.sid, attach(fApp, fm)) ?? '', /msgr2_pro_required/);
    assert.equal(db.sql(`select count(*) from public.msgr2_attachments where message_id = ${fm}`), '0', '첨부 행 0');
    const pm = say(mApp, '파일 보냄');
    const r = JSON.parse(db.as(M, mApp.sid, attach(mApp, pm)));
    assert.equal(r.ok, true, 'Pro는 종전대로');
    assert.equal(canWrite(mApp, r.path), 't', 'Pro의 Storage 쓰기 허용');
    // Pro였을 때 만든 첨부 행이 있어도, 끝난 뒤에는 Storage에 쓰지 못한다
    db.sql(`delete from public.test_pro where uid = '${M}'`);
    assert.equal(canWrite(mApp, r.path), 'f', 'Pro가 끝나면 Storage 쓰기 거부');
    db.sql(`insert into public.test_pro values ('${M}')`);
  } finally { setting('msgr2_pro_gate', 'off'); }
});

test('F4 관문 스위치 off면 종전대로 통과(무료도)', { skip }, () => {
  setting('msgr2_pro_gate', 'off');
  const fm = say(fApp, '파일 보냄 2');
  const r = JSON.parse(db.as(F, fApp.sid, attach(fApp, fm)));
  assert.equal(r.ok, true);
  assert.equal(canWrite(fApp, r.path), 't');
});

test('되돌림: ensure가 사라지고 무료 첨부가 다시 통과 — 다시 적용하면 원래대로', { skip }, () => {
  setting('msgr2_pro_gate', null);
  try {
    db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
    assert.equal(db.sql("select count(*) from pg_proc where proname = 'msgr2_seat_ensure'"), '0');
    const fm = say(fApp, '되돌림 뒤');
    assert.equal(JSON.parse(db.as(F, fApp.sid, attach(fApp, fm))).ok, true, '되돌린 판은 Pro를 보지 않는다(직전 본문)');
    db.psql(['-c', readFileSync(MIG, 'utf8')]);
    const fm2 = say(fApp, '다시 적용 뒤');
    assert.match(db.asErr(F, fApp.sid, attach(fApp, fm2)) ?? '', /msgr2_pro_required/);
    assert.equal(ensure(), 'kept');
  } finally { setting('msgr2_pro_gate', 'off'); }
});

test('자리 범위(검수 2차): msgr2_seat_scope는 활동 중인 자리만 고친다 — 파견 해제한 자리는 되살리지 않고 not_found, 같은 값이면 쓰기 0', { skip }, () => {
  const scope = (allow, users = [], dev = oApp) => db.as(dev.uid, dev.sid, `select public.msgr2_seat_scope('${AG}', '${TS}', '${allow}', '{${users.join(',')}}'::uuid[])`);
  const scopeErr = (allow, dev = oApp) => db.asErr(dev.uid, dev.sid, `select public.msgr2_seat_scope('${AG}', '${TS}', '${allow}', '{}'::uuid[])`) ?? '';
  ensure();
  assert.equal(scope('list', [X, X]), 'saved');
  assert.deepEqual([seatRow().allow, seatRow().users, seatRow().removed], ['list', [X], false], '명단 중복 제거');
  const x0 = seatRow().x;
  assert.equal(scope('list', [X]), 'kept'); assert.equal(seatRow().x, x0, '같은 값이면 쓰기 0');
  assert.match(scopeErr('all', mApp), /msgr2_forbidden/, '주인 아님');
  assert.match(scopeErr('all', oRun), /msgr2_app_device_required/, '본체 기기');
  db.as(O, oApp.sid, `select public.msgr2_set_seat('${AG}', '${TS}', 'all', '{}'::uuid[], true)`); // 파견 해제
  assert.equal(seatRow().removed, true);
  assert.match(scopeErr('owner'), /msgr2_seat_not_found/, '빠진 자리 범위 바꾸기');
  assert.deepEqual([seatRow().allow, seatRow().removed], ['list', true], '되살리지 않고 범위도 그대로');
  const other = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'never', '안 넣음') returning id`);
  assert.match(db.asErr(O, oApp.sid, `select public.msgr2_seat_scope('${other}', '${TS}', 'owner', '{}'::uuid[])`) ?? '', /msgr2_seat_not_found/, '자리가 없으면 만들지 않는다');
  // 다시 파견(ensure)은 되살리고 범위는 보존 — 범위 저장은 그 뒤에 된다
  assert.equal(ensure(), 'restored'); assert.equal(scope('owner'), 'saved'); assert.equal(seatRow().allow, 'owner');
  // 대조: 옛 길 msgr2_set_seat은 빠진 자리를 되살린다(설치된 v2 앱의 다시 파견 — 바꾸지 않음)
  db.as(O, oApp.sid, `select public.msgr2_set_seat('${AG}', '${TS}', 'all', '{}'::uuid[], true)`);
  setSeat('all'); assert.equal(seatRow().removed, false, '옛 길은 종전대로 되살림');
});
