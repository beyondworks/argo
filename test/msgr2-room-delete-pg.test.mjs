// 대화(방) 삭제(재공개 전 검수 b, 20261023180000 b절) — 옛 msgr 전체 + msgr2를 운영 순서로 적용한 DB(setupFull)에서 본다. 시험용 방만 쓴다.
// 경우: 남의 방·권한 없는 멤버·본체(runner) 기기 = 거부(행 그대로) / 1:1 참가자·만든 사람(방에 있음)·팀 관리자 = 지움 /
//      진행 중인 일 = work_active(끝나면 지움) / 지운 뒤 v2 의존 행·같은 id의 옛 채널·옛 글 0, 일지는 남음(기억 데이터) /
//      반응이 속도 제한보다 많아도 지움(사람 채팅 켬) / 지울 파일 목록 = 이 방 경로만(접두어 msgr/ 뗌) / Storage 지우기(storage.objects 정책) = 지울 수 있는 사람만 /
//      되돌림 파일을 적용하면 함수가 없어지고 다시 적용하면 원래대로.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-room-delete-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-room-delete-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261023180000_msgr2_seat_keep_pro_attach.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261023180000_msgr2_seat_keep_pro_attach.down.sql', import.meta.url));
const id = (n) => `d6000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = id(1), M = id(2), C = id(3), X = id(4), TS = id(10);
let db, oApp, oRun, mApp, mRun, cApp, xApp, PS, AG;
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings (key, value) values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const del = (who, room) => JSON.parse(db.as(who.uid, who.sid, `select public.msgr2_room_delete('${room}')`));
const files = (who, room) => JSON.parse(db.as(who.uid, who.sid, `select public.msgr2_room_delete_files('${room}')`));
const rooms = (room) => db.sql(`select count(*) from public.msgr2_rooms where id = '${room}'`);
const msgs = (room) => db.sql(`select count(*) from public.msgr2_messages where room_id = '${room}'`);
const say = (who, room, body, mentions = []) => db.as(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${room}', 'user', '${who.uid}', ${q(body)}, '{${mentions.join(',')}}') returning id`);
const room = (space, kind, name, by, members) => {
  const r = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key, name, created_by) values ('${space}', '${kind}', ${kind === 'direct' ? q('pk-' + name) : 'null'}, ${q(name)}, ${by ? q(by) : 'null'}) returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ${members.map(([k, m]) => `('${r}', '${k}', '${m}')`).join(', ')}`);
  return r;
};

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  oApp = seedDevice(db, O, 'app'); oRun = seedDevice(db, O, 'runner'); mApp = seedDevice(db, M, 'app'); mRun = seedDevice(db, M, 'runner'); cApp = seedDevice(db, C, 'app'); xApp = seedDevice(db, X, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  // 팀 공간 = 옛 조직과 같은 id(백필 규칙) — 옛 채널을 같은 id로 둔다
  db.sql(`insert into public.msgr_orgs (id, name, slug, owner_user_id) values ('${TS}', 'Team', 'team-del', '${M}')`);
  db.sql(`insert into public.msgr2_spaces (id, kind, name, owner_user_id) values ('${TS}', 'team', '팀', '${M}') on conflict (id) do nothing`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner'), ('${TS}', '${M}', 'owner'), ('${TS}', '${O}', 'member'), ('${TS}', '${C}', 'member'), ('${TS}', '${X}', 'member')
          on conflict (space_id, user_id) do update set role = excluded.role, removed_at = null`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'a', '에이') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${AG}', '${TS}', 'all')`);
});

test('남의 방·권한 없는 멤버·본체(runner) 기기는 지우지 못하고 행은 그대로다', { skip }, () => {
  const R = room(TS, 'private', '비공개', C, [['user', C], ['user', O]]);
  say(cApp, R, '안녕');
  assert.equal(files(xApp, R).code, 'forbidden', '방 밖 팀 멤버 = 파일 목록 거부');
  assert.equal(del(xApp, R).code, 'forbidden', '방 밖 팀 멤버');
  assert.equal(del(oApp, R).code, 'forbidden', '방 안 일반 멤버(만든 사람 아님·관리자 아님)');
  assert.match(db.asErr(O, oRun.sid, `select public.msgr2_room_delete('${R}')`) ?? '', /msgr2_app_device_required/, '본체 기기');
  assert.equal(db.as(X, xApp.sid, `select public._msgr2_storage_gate(${q(`${TS}/${R}/1/0-a.txt`)}, 'delete')`), 'f', 'Storage 지우기 판정(방 밖)');
  assert.equal(rooms(R), '1'); assert.equal(msgs(R), '1');
  // 직접 지우기는 여전히 권한 없음(앱 옛 경로)
  assert.match(db.asErr(C, cApp.sid, `delete from public.msgr2_rooms where id = '${R}'`) ?? '', /permission denied/);
  // 만든 사람이 방을 나가면 못 지운다(관리자는 지운다 — 아래)
  db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${R}' and member_id = '${C}'`);
  assert.equal(del(cApp, R).code, 'forbidden', '나간 만든 사람');
  assert.equal(JSON.parse(db.as(M, mApp.sid, `select public.msgr2_room_delete('${R}')`)).code, 'forbidden', '방 밖 관리자는 읽을 수 없어 못 지운다(비공개 방)');
  assert.equal(rooms(R), '1');
});

test('1:1 참가자·만든 사람(방에 있음)·팀 관리자는 지운다', { skip }, () => {
  const D = room(PS, 'direct', 'oa', O, [['user', O], ['agent', AG]]);
  say(oApp, D, '1:1'); // 에이전트 1:1은 글마다 일이 생긴다 — 제안을 만료시켜 진행 중인 일이 없게
  db.sql(`update public.msgr2_works set expires_at = now() - interval '1 minute' where room_id = '${D}'`);
  assert.equal(del(xApp, D).code, 'forbidden', '1:1 밖 사람');
  const r = del(oApp, D);
  assert.equal(r.ok, true, `1:1 참가자 ${JSON.stringify(r)}`);
  assert.equal(rooms(D), '0'); assert.equal(msgs(D), '0');
  const R1 = room(TS, 'private', '만든방', C, [['user', C], ['user', O]]);
  assert.equal(del(cApp, R1).ok, true, '만든 사람(방에 있음)');
  const R2 = room(TS, 'open', '공개', C, [['user', C]]);
  assert.equal(del(oApp, R2).code, 'forbidden', '공개 방도 일반 멤버는 못 지운다');
  db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${R2}' and member_id = '${C}'`);
  assert.equal(del(cApp, R2).code, 'forbidden', '공개 방에서 나간 만든 사람(읽기는 되지만 방에 없음)');
  assert.equal(JSON.parse(db.as(M, mApp.sid, `select public.msgr2_room_delete('${R2}')`)).ok, true, '팀 관리자(owner)');
  assert.equal(rooms(R1) + rooms(R2), '00');
});

test('진행 중인 일이 있으면 work_active, 일이 끝나면 지운다 — v2 의존 행·옛 채널·옛 글이 모두 없어지고 일지는 남는다', { skip }, () => {
  const R = room(TS, 'private', '일방', M, [['user', M], ['user', O], ['agent', AG]]);
  // 같은 id의 옛 채널·옛 글(백필 전 원본) + 일지
  db.sql(`insert into public.msgr_channels (id, org_id, kind, name, created_by) values ('${R}', '${TS}', 'private', '일방', '${M}')`);
  db.sql(`insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, kind, body) values ('${TS}', '${R}', 'user', '${M}', 'text', '옛 글')`);
  db.sql(`insert into public.msgr_journal_entries (org_id, channel_id, day, line) values ('${TS}', '${R}', current_date, '기록')`);
  const mid = say(mApp, R, '에이 해줘', [AG]);
  assert.equal(JSON.parse(db.as(M, mApp.sid, `select public.msgr2_attachment_add(${mid}, 0, 'a.txt', 'text/plain', 1)`)).ok, true);
  db.as(M, mApp.sid, `insert into public.msgr2_reactions (message_id, user_id, emoji) values (${mid}, '${M}', '👍')`);
  db.as(M, mApp.sid, `select public.msgr2_room_pref_set('${R}', true, null)`);
  const w = db.sql(`select id from public.msgr2_works where room_id = '${R}' order by created_at desc limit 1`);
  assert.ok(w, '전제: 일이 생겼다');
  assert.equal(JSON.parse(db.as(M, mApp.sid, `select public.msgr2_room_delete('${R}')`)).code, 'work_active', '제안 중(offered)');
  assert.equal(files(mApp, R).code, 'work_active', '파일 목록도 같은 거부 — 지우지 못할 방의 파일을 먼저 지우지 않게');
  assert.equal(rooms(R), '1');
  db.sql(`insert into public.msgr2_work_events (work_id, sender, seq, type, envelope_id, envelope) values ('${w}', 'runner', 1, 'work.progress', gen_random_uuid(), '{}'::jsonb)`);
  db.sql(`insert into public.msgr2_work_files (work_id, room_id, name, bytes, storage_path) values ('${w}', '${R}', 'out.txt', 3, 'msgr/${TS}/${R}/w/out.txt')`);
  db.sql(`update public.msgr2_works set state = 'done', has_result = true where id = '${w}'`);
  // 지울 파일 목록: 이 방 경로만, 접두어 msgr/ 뗌. 다른 방 경로를 가리키는 행은 빠진다
  const other = room(TS, 'private', '다른방', M, [['user', M]]);
  db.sql(`insert into public.msgr2_attachments (message_id, room_id, storage_path, name) values (${mid}, '${R}', 'msgr/${TS}/${other}/9/0-x.txt', 'x.txt')`);
  assert.equal(files(mApp, R).code === undefined, true, '전제');
  const list = files(mApp, R).paths;
  assert.ok(list.length === 2 && list.every((p) => p.startsWith(`${TS}/${R}/`)), `파일 목록 = 이 방 경로 2개: ${list}`);
  assert.equal(db.as(M, mApp.sid, `select public._msgr2_storage_gate(${q(list[0])}, 'delete')`), 't', 'Storage 지우기 판정(지울 수 있는 사람)');
  assert.equal(db.as(O, oApp.sid, `select public._msgr2_storage_gate(${q(list[0])}, 'delete')`), 'f', 'Storage 지우기 판정(일반 멤버)');
  // 실제 정책(storage.objects RLS): 일반 멤버는 0행, 지울 수 있는 사람은 지운다(앱의 Storage API remove = 이 delete)
  db.sql(`insert into storage.objects (bucket_id, name) select 'msgr', p from unnest(array[${list.map(q).join(',')}]) p`);
  assert.equal(db.as(O, oApp.sid, `with d as (delete from storage.objects where bucket_id = 'msgr' and name = ${q(list[0])} returning 1) select count(*) from d`), '0', 'Storage 지우기(일반 멤버) = 0행');
  assert.equal(db.as(O, oRun.sid, `with d as (delete from storage.objects where bucket_id = 'msgr' and name = ${q(list[0])} returning 1) select count(*) from d`), '0', 'Storage 지우기(본체 기기) = 0행');
  assert.equal(db.as(M, mRun.sid, `with d as (delete from storage.objects where bucket_id = 'msgr' and name = ${q(list[0])} returning 1) select count(*) from d`), '0', 'Storage 지우기(관리자의 본체 기기) = 0행');
  assert.equal(db.as(M, mApp.sid, `with d as (delete from storage.objects where bucket_id = 'msgr' and name in (${list.map(q).join(',')}) returning 1) select count(*) from d`), '2', 'Storage 지우기(관리자) = 2행');
  const legacy = `${id(77)}/${id(78)}/1/0-old.txt`; // v2 방이 아닌 경로(옛 조직 경로) — 새 허용 정책이 열지 않는다
  db.sql(`insert into storage.objects (bucket_id, name) values ('msgr', ${q(legacy)})`);
  assert.equal(db.as(M, mApp.sid, `with d as (delete from storage.objects where name = ${q(legacy)} returning 1) select count(*) from d`), '0', 'v2 경로가 아니면 새 정책으로 못 지운다');
  const res = JSON.parse(db.as(M, mApp.sid, `select public.msgr2_room_delete('${R}')`));
  assert.equal(res.ok, true, JSON.stringify(res));
  for (const t of ['msgr2_room_members', 'msgr2_messages', 'msgr2_attachments', 'msgr2_reads', 'msgr2_prefs', 'msgr2_topics', 'msgr2_works', 'msgr2_work_files', 'msgr2_approvals', 'msgr2_room_counters', 'msgr2_msg_waits']) {
    assert.equal(db.sql(`select count(*) from public.${t} where room_id = '${R}'`), '0', t);
  }
  assert.equal(db.sql(`select count(*) from public.msgr2_reactions where message_id = ${mid}`), '0', '반응');
  assert.equal(db.sql(`select count(*) from public.msgr2_work_events where work_id = '${w}'`), '0', '일 사건');
  assert.equal(rooms(R), '0', '방');
  assert.equal(db.sql(`select count(*) from public.msgr_channels where id = '${R}'`), '0', '옛 채널');
  assert.equal(db.sql(`select count(*) from public.msgr_messages where channel_id = '${R}'`), '0', '옛 글(옛 FK cascade)');
  assert.equal(db.sql(`select count(*) from public.msgr_journal_entries where line = '기록'`), '1', '일지는 남는다(기억 데이터)');
  assert.equal(rooms(other), '1', '다른 방 그대로');
});

test('반응이 속도 제한보다 많아도 지운다(사람 채팅 켬) — 반응 직접 지우기의 속도 제한은 그대로', { skip }, () => {
  const R = room(TS, 'private', '반응방', M, [['user', M]]);
  const mid = say(mApp, R, '많이');
  db.sql(`insert into public.msgr2_reactions (message_id, user_id, emoji) select ${mid}, gen_random_uuid(), '👍' from generate_series(1, 130)`);
  setting('msgr2_people', 'on');
  try {
    const res = JSON.parse(db.as(M, mApp.sid, `select public.msgr2_room_delete('${R}')`));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(rooms(R), '0');
    assert.equal(db.as(M, mApp.sid, `select coalesce(current_setting('msgr2.room_drop', true), '')`), '', '표지는 트랜잭션 밖으로 남지 않는다');
    // 직접 지우기 속도 제한은 그대로: 표지 없는 반응 지우기는 계속 센다
    const R2 = room(TS, 'private', '반응방2', M, [['user', M]]);
    const m2 = say(mApp, R2, '하나');
    db.sql(`insert into public.msgr2_reactions (message_id, user_id, emoji) select ${m2}, '${M}', e from unnest(array['a','b','c']) e`);
    db.sql(`delete from public.msgr2_rate_hits where user_id = '${M}'`);
    db.as(M, mApp.sid, `delete from public.msgr2_reactions where message_id = ${m2} and emoji = 'a'`);
    assert.equal(db.sql(`select coalesce(sum(n), 0) from public.msgr2_rate_hits where user_id = '${M}' and kind = 'reactions:minute'`), '1', '직접 지우기는 센다');
  } finally { setting('msgr2_people', null); }
});

test('되돌림 파일을 적용하면 삭제 함수·Storage 지우기 정책이 없어지고, 다시 적용하면 원래대로', { skip }, () => {
  db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
  assert.equal(db.sql(`select count(*) from pg_proc where proname in ('msgr2_room_delete', 'msgr2_room_delete_files', '_msgr2_room_deletable', '_msgr2_storage_delete', '_msgr2_room_delete_check')`), '0');
  assert.equal(db.sql(`select count(*) from pg_policies where policyname = 'msgr2_files_delete'`), '0');
  assert.equal(db.sql(`select public._msgr2_storage_gate(${q(`${TS}/${id(99)}/1/0-a.txt`)}, 'delete')`), 't', '없는 방 경로 = v2 경로 아님(종전)');
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  assert.equal(db.sql(`select count(*) from pg_proc where proname in ('msgr2_room_delete', 'msgr2_room_delete_files', '_msgr2_room_deletable', '_msgr2_storage_delete', '_msgr2_room_delete_check')`), '5');
});
