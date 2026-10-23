// 메신저 재공개 전 검수 ① 보안 S4·S5·S2 + lite Pro(20261023180000) — 옛 msgr 전체 + msgr2를 운영 순서로 적용한 DB(setupFull)에서 본다.
// 핀(고치기 전에도 통과해야 하는 정상 경로): 본체(runner)의 일 수락·진행·업로드 슬롯·Storage 읽기, 앱 기기의 사람 글·첨부, 기기 없는 세션(옛 v1 앱)의 계정 삭제.
// 고치는 것:
//   S4 runner·폐기 기기 세션의 msgr_delete_me 거부(계정 그대로), 기기 폐기 때 그 로그인 세션(auth.sessions)도 끊김
//   S5 runner 세션의 사람 글 insert·msgr2_attachment_add·msgr2_message_ready 거부
//   S2 공간에서 내보낸(또는 손님 기한이 끝난) 주인의 본체: 진행 중인 일로 progress·accept(리스 연장)·업로드 슬롯·Storage 읽기·실시간 보내기 모두 거부
//   lite: 사람 채팅 꺼짐에서도 Pro가 끝난 계정의 사람 글 = msgr2_pro_required(관문 off면 통과)
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-relaunch-security-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-relaunch-security-pg.test.mjs';
const id = (n) => `d5000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = id(1), M = id(2), F = id(3), D1 = id(4), D2 = id(5), D3 = id(6);
let db, oApp, oRun, mApp, fApp, TS, TR, PS, DM, AG;
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings (key, value) values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const seqs = new Map();
const env = (type, { work, dev = oRun, data = {} } = {}) => { const k = `${work}|${dev.dev}`; const s = (seqs.get(k) ?? 0) + 1; seqs.set(k, s);
  return { v: 1, id: randomUUID(), work: work ?? null, seq: s, type, agent: AG, device: dev.dev, at: new Date().toISOString(), data }; };
const send = (dev, e) => db.send(dev.uid, dev.sid, e);
const say = (who, room, body, mentions = []) => db.as(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${room}', 'user', '${who.uid}', ${q(body)}, '{${mentions.join(',')}}') returning id`);
const sayErr = (who, room, body) => db.asErr(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${room}', 'user', '${who.uid}', ${q(body)})`) ?? '';
const lastWork = (room) => db.sql(`select id from public.msgr2_works where room_id = '${room}' order by created_at desc, id limit 1`);
const users = (u) => db.sql(`select count(*) from auth.users where id = '${u}'`);
/** GoTrue에 살아 있는 세션 + 그 세션의 기기 행 */
const sessionDevice = (uid, kind, extra = {}) => { const d = seedDevice(db, uid, kind, extra); db.sql(`insert into auth.sessions (id, user_id) values ('${d.sid}', '${uid}') on conflict do nothing`); return d; };

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  db.sql('create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now())');
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  db.sql(`create table if not exists public.test_pro (uid uuid primary key);
    create or replace function public.is_pro_for(p_uid uuid) returns boolean language sql stable as $$ select exists (select 1 from public.test_pro where uid = p_uid) $$;
    insert into public.test_pro values ('${O}'), ('${M}') on conflict do nothing`);
  oApp = sessionDevice(O, 'app'); oRun = sessionDevice(O, 'runner'); mApp = sessionDevice(M, 'app'); fApp = sessionDevice(F, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  TS = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '팀', '${M}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner'), ('${TS}', '${M}', 'owner'), ('${TS}', '${O}', 'member')`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'a', '에이') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${AG}', '${TS}', 'all')`);
  DM = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PS}', 'direct', 'o-a') returning id`);
  TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '팀방') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${DM}', 'user', '${O}'), ('${DM}', 'agent', '${AG}'), ('${TR}', 'user', '${O}'), ('${TR}', 'user', '${M}'), ('${TR}', 'agent', '${AG}')`);
});

test('핀(정상 경로): 앱 기기의 사람 글·첨부, 본체의 일 수락·진행·업로드 슬롯·Storage 읽기', { skip }, () => {
  const mid = say(mApp, TR, '에이 해줘', [AG]);
  assert.equal(JSON.parse(db.as(M, mApp.sid, `select public.msgr2_attachment_add(${mid}, 0, 'a.txt', 'text/plain', 1)`)).ok, true, '앱 기기 첨부');
  const w = lastWork(TR);
  assert.equal(send(oRun, env('work.accept', { work: w })).ok, true, '본체 수락');
  assert.equal(send(oRun, env('work.progress', { work: w, data: { stage: 'thinking' } })).ok, true, '본체 진행');
  const slot = JSON.parse(db.as(O, oRun.sid, `select public.msgr2_link_upload_slot('${w}', 'out.txt', 3)`));
  assert.equal(slot.ok, true, '업로드 슬롯');
  assert.equal(db.as(O, oRun.sid, `select public._msgr2_storage_read(${q(slot.path)})`), 't', 'Storage 읽기(리스)');
  assert.equal(db.as(O, oRun.sid, `select public._msgr2_rt_send_ok('v2:wk:${w}')`), 't', '실시간 보내기');
});

test('S5 본체(runner) 세션은 사람 글을 넣지 못하고, 사람 글에 첨부·준비 완료도 못 한다', { skip }, () => {
  assert.match(sayErr(oRun, DM, '주인 행세'), /row-level security|policy/i, '사람 글 넣기 거부');
  const mid = say(oApp, DM, '내 글');
  assert.match(db.asErr(O, oRun.sid, `select public.msgr2_attachment_add(${mid}, 0, 'x.txt', 'text/plain', 1)`) ?? '', /msgr2_app_device_required/);
  assert.match(db.asErr(O, oRun.sid, `select public.msgr2_message_ready(${mid})`) ?? '', /msgr2_app_device_required/);
  assert.equal(db.sql(`select count(*) from public.msgr2_attachments where message_id = ${mid}`), '0');
});

test('S2 공간에서 내보낸 주인의 본체: 진행 중인 일로 진행·수락(리스 연장)·업로드 슬롯·Storage 읽기·실시간 보내기 모두 거부', { skip }, () => {
  say(mApp, TR, '에이 하나 더', [AG]);
  const w = lastWork(TR);
  assert.equal(send(oRun, env('work.accept', { work: w })).ok, true, '전제: 수락');
  const slot = JSON.parse(db.as(O, oRun.sid, `select public.msgr2_link_upload_slot('${w}', 'pre.txt', 3)`));
  assert.equal(db.as(O, oRun.sid, `select public._msgr2_storage_write(${q(slot.path)})`), 't', '전제: 내보내기 전에는 슬롯 경로에 쓴다');
  db.sql(`update public.msgr2_space_members set removed_at = now() where space_id = '${TS}' and user_id = '${O}'`); // 관리자가 내보냄(서비스 문맥)
  assert.equal(send(oRun, env('work.progress', { work: w, data: { stage: 'thinking' } })).code, 'work_closed', '진행');
  assert.equal(send(oRun, env('work.accept', { work: w })).code, 'work_closed', '리스 연장');
  assert.equal(JSON.parse(db.as(O, oRun.sid, `select public.msgr2_link_upload_slot('${w}', 'post.txt', 3)`)).code, 'work_closed', '업로드 슬롯');
  assert.equal(db.as(O, oRun.sid, `select public._msgr2_storage_read(${q(slot.path)})`), 'f', 'Storage 읽기');
  assert.equal(db.as(O, oRun.sid, `select public._msgr2_storage_write(${q(slot.path)})`), 'f', 'Storage 쓰기(리스 갈래)');
  assert.equal(db.as(O, oRun.sid, `select public._msgr2_rt_send_ok('v2:wk:${w}')`), 'f', '실시간 보내기');
  db.sql(`update public.msgr2_space_members set removed_at = null where space_id = '${TS}' and user_id = '${O}'`); // 되돌림(다음 시험)
  assert.equal(send(oRun, env('work.progress', { work: w, data: { stage: 'thinking' } })).ok, true, '다시 멤버면 종전대로');
});

test('S2 손님 기한이 지나도 같다(시각으로 끝나는 멤버십)', { skip }, () => {
  say(mApp, TR, '에이 기한', [AG]);
  const w = lastWork(TR);
  assert.equal(send(oRun, env('work.accept', { work: w })).ok, true);
  db.sql(`update public.msgr2_space_members set expires_at = now() - interval '1 second' where space_id = '${TS}' and user_id = '${O}'`);
  assert.equal(send(oRun, env('work.progress', { work: w, data: { stage: 'thinking' } })).code, 'work_closed');
  db.sql(`update public.msgr2_space_members set expires_at = null where space_id = '${TS}' and user_id = '${O}'`);
});

test('lite(사람 채팅 꺼짐): Pro가 끝난 계정의 옛 기기는 사람 글을 쓰지 못한다, Pro·관문 off는 종전대로', { skip }, () => {
  setting('msgr2_lite', 'on'); setting('msgr2_people', null); setting('msgr2_pro_gate', null);
  try {
    const PF = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${F}') returning id`);
    db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PF}', '${F}', 'owner')`);
    const FA = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${F}', 'w', 'f', '에프') returning id`);
    const FDM = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PF}', 'direct', 'f-a') returning id`);
    db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${FDM}', 'user', '${F}'), ('${FDM}', 'agent', '${FA}')`);
    assert.match(sayErr(fApp, FDM, '무료 글'), /msgr2_pro_required/, 'Pro가 끝난 계정');
    assert.ok(Number(say(oApp, DM, 'Pro 글')) > 0, 'Pro 계정은 종전대로');
    setting('msgr2_pro_gate', 'off');
    assert.ok(Number(say(fApp, FDM, '관문 off')) > 0, '관문 off면 통과');
  } finally { setting('msgr2_lite', 'off'); setting('msgr2_pro_gate', 'off'); }
});

test('S4 계정 삭제: 본체(runner)·폐기 기기 세션은 거부(계정 그대로), 기기 행이 없는 세션(옛 v1 앱)·앱 기기는 종전대로', { skip }, () => {
  for (const u of [D1, D2, D3]) db.sql(`insert into auth.users (id) values ('${u}') on conflict do nothing`);
  const run1 = sessionDevice(D1, 'runner');
  assert.match(db.asErr(D1, run1.sid, 'select public.msgr_delete_me()') ?? '', /msgr2_app_device_required/, 'runner 세션');
  assert.equal(users(D1), '1', '계정 그대로');
  const rev = sessionDevice(D1, 'app', { revoked: true });
  assert.match(db.asErr(D1, rev.sid, 'select public.msgr_delete_me()') ?? '', /msgr2_app_device_required/, '폐기 기기 세션');
  assert.equal(users(D1), '1');
  const v1sid = randomUUID(); // 기기 행이 없는 세션(옛 v1 앱 0.1.63)
  assert.equal(db.asErr(D2, v1sid, 'select public.msgr_delete_me()'), null, '옛 v1 세션은 종전대로 지운다');
  assert.equal(users(D2), '0');
  const app3 = sessionDevice(D3, 'app');
  assert.equal(db.asErr(D3, app3.sid, 'select public.msgr_delete_me()'), null, '앱 기기 세션은 종전대로');
});

test('S4 기기 폐기 때 그 로그인 세션(auth.sessions)도 끊긴다 — 다른 기기 세션은 그대로', { skip }, () => {
  const run2 = sessionDevice(O, 'runner');
  assert.equal(db.sql(`select count(*) from auth.sessions where id = '${run2.sid}'`), '1', '전제');
  assert.equal(db.as(O, oApp.sid, `select public.msgr2_device_revoke('${run2.dev}')`), 't');
  assert.equal(db.sql(`select count(*) from auth.sessions where id = '${run2.sid}'`), '0', '폐기한 기기의 세션 삭제');
  assert.equal(db.sql(`select count(*) from auth.sessions where id = '${oApp.sid}'`), '1', '폐기한 앱 기기 세션은 그대로');
});
