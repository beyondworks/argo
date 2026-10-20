// 메신저 사람 채팅 스위치(msgr2_people) + 첫 글 첨부 기다림(20261020201500_msgr2_people.sql).
// 경우 표(PR 본문)의 칸: 스위치 꺼짐 = A+ lite 그대로 · 켬 = Pro끼리 팀 공간·초대·방·글, 무료 = msgr2_pro_required, 무료를 바로 넣기 = msgr2_member_not_pro,
// 초대 만들기는 요금제를 보지 않고 수락 때 판정 · 사람 방 상한(공간 인원·사람 글 분당) · 회의방 상한은 lite와 무관 · 첨부를 다 올린 뒤에만 일 ·
// 기한이 지나면 다음 사건(다음 글·ready·하루 정리)에서 첨부 없이 일 + 안내 1줄 · 쉬는 동안 쓰기 0 · 백필은 사람 채팅 켬일 때 허용 · 되돌림.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-people-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-people-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261020201500_msgr2_people.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261020201500_msgr2_people.down.sql', import.meta.url));
const P = 'b0000000-0000-4000-8000-000000000001'; // Pro
const Q = 'b0000000-0000-4000-8000-000000000002'; // Pro 2
const F = 'b0000000-0000-4000-8000-000000000003'; // 무료

let db, pApp, qApp, fApp, PS, FS, A1, FA;
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const err = (who, q) => db.asErr(who.uid, who.sid, q) ?? '';
const val = (who, q) => db.as(who.uid, who.sid, q);
const say = (who, room, body, { files = 0, mentions = [] } = {}) => db.as(who.uid, who.sid,
  `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, files_expected, mentions) values ('${room}', 'user', '${who.uid}', '${body}', ${files}, '{${mentions.join(',')}}') returning id`);
const sayErr = (who, room, body) => err(who, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${room}', 'user', '${who.uid}', '${body}')`);
const works = (room) => Number(db.sql(`select count(*) from public.msgr2_works where room_id = '${room}'`));
const waits = () => Number(db.sql('select count(*) from public.msgr2_msg_waits'));
const people = (on) => setting('msgr2_people', on ? 'on' : null);
const agentRoom = (owner, sp, agent) => {
  const r = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${sp}', 'private', '') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${r}', 'user', '${owner}'), ('${r}', 'agent', '${agent}')`);
  return r;
};

before(() => {
  if (!DB) return;
  db = setup(DB);
  db.sql(`create table if not exists public.test_pro (uid uuid primary key);
    create or replace function public.is_pro_for(p uuid) returns boolean language sql stable as $$ select exists (select 1 from public.test_pro where uid = p) $$;
    insert into public.test_pro values ('${P}'), ('${Q}');
    insert into public.msgr_settings values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  db.sql(`delete from public.msgr_settings where key in ('msgr2_lite', 'msgr2_pro_gate')`); // 운영 기본(켬)
  pApp = seedDevice(db, P, 'app'); qApp = seedDevice(db, Q, 'app'); fApp = seedDevice(db, F, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${P}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${P}', 'owner')`);
  FS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${F}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${FS}', '${F}', 'owner')`);
  A1 = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${P}', 'w', 'a1', 'a1') returning id`);
  FA = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${F}', 'w', 'fa', 'fa') returning id`);
});

test('스위치 꺼짐 = A+ lite 그대로 — 팀 공간·초대 거부, 백필 거부', { skip }, () => {
  people(false);
  assert.match(err(pApp, `select public.msgr2_space_create('팀', null)`), /msgr2_lite_only/);
  assert.match(db.raw(['-c', 'select public._msgr2_bf_begin()']).stderr, /msgr2_backfill_lite/);
});

test('켬 — Pro는 팀 공간을 만들고, 무료는 msgr2_pro_required. 백필은 허용(서비스 문맥)', { skip }, () => {
  people(true);
  try {
    const sp = val(pApp, `select public.msgr2_space_create('팀 P', null)`);
    assert.match(sp, /^[0-9a-f-]{36}$/);
    assert.match(err(fApp, `select public.msgr2_space_create('팀 F', null)`), /msgr2_pro_required/);
    assert.equal(db.raw(['-c', 'select public._msgr2_bf_begin()']).status, 0, '사람 채팅 켬 → 백필 허용');
  } finally { people(false); }
});

test('켬 — 초대 만들기는 받는 사람 요금제를 보지 않고, 무료 수락은 msgr2_pro_required(초대는 남는다), Pro가 되면 수락된다', { skip }, () => {
  people(true);
  try {
    const sp = val(pApp, `select public.msgr2_space_create('초대 시험', null)`);
    const inv = JSON.parse(val(pApp, `select public.msgr2_invite_create('${sp}', 'member', '${F}')::text`));
    assert.ok(inv.code, '무료에게도 지정 초대를 만든다');
    assert.match(err(fApp, `select public.msgr2_invite_accept('${inv.code}')`), /msgr2_pro_required/);
    assert.equal(db.sql(`select use_count from public.msgr2_space_invites where id = '${inv.invite_id}'`), '0', '초대는 소비되지 않는다');
    assert.match(err(fApp, `select public.msgr2_invite_create('${sp}', 'member', null)`), /msgr2_pro_required|msgr2_forbidden/, '무료는 초대를 만들지 못한다');
    db.sql(`insert into public.test_pro values ('${F}')`);
    try {
      const r = JSON.parse(val(fApp, `select public.msgr2_invite_accept('${inv.code}')::text`));
      assert.equal(r.space_id ?? sp, sp);
      assert.equal(db.sql(`select count(*) from public.msgr2_space_members where space_id = '${sp}' and user_id = '${F}' and removed_at is null`), '1');
    } finally { db.sql(`delete from public.test_pro where uid = '${F}'`); }
  } finally { people(false); }
});

test('켬 — 무료인 다른 사람을 방에 바로 넣으면 msgr2_member_not_pro, Pro끼리는 방·글이 된다', { skip }, () => {
  people(true);
  try {
    const sp = val(pApp, `select public.msgr2_space_create('방 시험', null)`);
    const inv = JSON.parse(val(pApp, `select public.msgr2_invite_create('${sp}', 'member', '${Q}')::text`));
    val(qApp, `select public.msgr2_invite_accept('${inv.code}')::text`);
    const room = val(pApp, `select public.msgr2_room_create('${sp}', 'private', '둘', '{${Q}}')`);
    assert.match(room, /^[0-9a-f-]{36}$/);
    say(qApp, room, '안녕');
    assert.equal(db.sql(`select count(*) from public.msgr2_messages where room_id = '${room}' and author_user_id = '${Q}'`), '1');
    // 무료 F를 공간 멤버로(서비스 문맥 = 이관된 옛 멤버와 같은 모양) 넣은 뒤 방에 바로 넣기 → 거부
    db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${sp}', '${F}', 'member')`);
    assert.match(err(pApp, `select public.msgr2_room_members_add('${room}', '{${F}}')`), /msgr2_member_not_pro/);
    // 이관된 무료 멤버는 쓰기가 막힌다(읽기 전용 표지 없이 서버 관문으로)
    const open = val(pApp, `select public.msgr2_room_create('${sp}', 'open', '모두')`);
    assert.match(sayErr(fApp, open, '무료 글'), /msgr2_pro_required/);
  } finally { people(false); }
});

test('켬 — 무료는 자기 에이전트 1:1에도 글을 못 쓴다(무료 = 서버 안 씀). 꺼짐(A+)에서는 종전대로 글 + Pro 안내', { skip }, () => {
  const fr = agentRoom(F, FS, FA);
  people(true);
  try { assert.match(sayErr(fApp, fr, '켬'), /msgr2_pro_required/); } finally { people(false); }
  say(fApp, fr, '꺼짐');
  assert.equal(JSON.parse(db.sql(`select meta::text from public.msgr2_messages where room_id = '${fr}' and kind = 'system' order by id desc limit 1`)).limit, 'pro');
});

test('사람 방 상한 — 사람 글 분당·공간 인원(설정은 최대값을 넘지 못한다)', { skip }, () => {
  people(true);
  try {
    const sp = val(pApp, `select public.msgr2_space_create('상한', null)`);
    const room = val(pApp, `select public.msgr2_room_create('${sp}', 'open', '상한 방')`);
    setting('msgr2_limit_user_msg_min', '2');
    const before = Number(db.sql(`select count(*) from public.msgr2_messages where author_kind = 'user' and author_user_id = '${P}' and created_at > now() - interval '1 minute'`));
    for (let i = before; i < 2; i++) say(pApp, room, `글${i}`);
    assert.match(sayErr(pApp, room, '넘침'), /msgr2_limit/);
    setting('msgr2_limit_user_msg_min', '100000');
    assert.equal(db.sql(`select public._msgr2_clamp('msgr2_limit_user_msg_min', 30, 120)`), '120', '설정으로 최대값을 넘지 못한다');
    setting('msgr2_limit_user_msg_min', null);
    setting('msgr2_limit_space_members', '1');
    const inv = JSON.parse(val(pApp, `select public.msgr2_invite_create('${sp}', 'member', '${Q}')::text`));
    assert.match(err(qApp, `select public.msgr2_invite_accept('${inv.code}')`), /msgr2_limit/);
  } finally { setting('msgr2_limit_space_members', null); setting('msgr2_limit_user_msg_min', null); people(false); }
});

test('회의방 상한은 lite와 상관없이 — lite·사람 채팅 모두 꺼져도 봇·6번째 에이전트 거부', { skip }, () => {
  setting('msgr2_lite', 'off');
  try {
    const bot = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name, hosting) values ('${P}', 'w', 'bot1', 'bot1', 'bot') returning id`);
    const r = db.sql(`insert into public.msgr2_rooms (space_id, kind, name, meeting) values ('${PS}', 'private', 'm', true) returning id`);
    db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${r}', 'user', '${P}')`);
    assert.match(err(pApp, `select public.msgr2_room_members_add('${r}', '{}', '{${bot}}')`), /msgr2_meeting_no_bot/);
  } finally { setting('msgr2_lite', null); }
});

test('첫 글 첨부 — files_expected 글은 일을 미루고, 객체가 다 올라온 뒤 ready에서 일 1개, 다시 불러도 0', { skip }, () => {
  const r = agentRoom(P, PS, A1);
  const id = say(pApp, r, '파일 봐 줘', { files: 1 });
  assert.equal(works(r), 0, '넣을 때 일 없음');
  assert.equal(waits(), 1);
  const a = JSON.parse(val(pApp, `select public.msgr2_attachment_add(${id}, 0, 'a.txt', 'text/plain', 3)::text`));
  assert.match(err(pApp, `select public.msgr2_message_ready(${id})`), /msgr2_attachment_missing/, '객체가 없으면 거부(다시 올리고 재시도)');
  db.sql(`insert into storage.objects (bucket_id, name) values ('${a.bucket}', '${a.path}')`);
  assert.deepEqual(JSON.parse(val(pApp, `select public.msgr2_message_ready(${id})::text`)), { ok: true, offers: 1 });
  assert.equal(works(r), 1);
  const offer = JSON.parse(db.sql(`select envelope::text from public.msgr2_work_events e join public.msgr2_works w on w.id = e.work_id where w.room_id = '${r}' and e.type = 'work.offer'`));
  assert.equal(offer.data.attachments.length, 1, 'offer에 첨부가 실린다');
  assert.deepEqual(JSON.parse(val(pApp, `select public.msgr2_message_ready(${id})::text`)), { ok: true, offers: 0 });
  assert.equal(waits(), 0);
  // files_expected = 0(옛 앱)은 종전대로 넣는 순간 일
  say(pApp, r, '파일 없음');
  assert.equal(works(r), 2);
});

test('폴백 — 기한이 지난 기다림은 다음 글·ready·하루 정리에서 첨부 없이 일 + 안내 1줄, 기한 전에는 그대로', { skip }, () => {
  const r = agentRoom(P, PS, A1);
  const id1 = say(pApp, r, '첫 글', { files: 2 });
  say(pApp, r, '바로 다음 글');
  assert.equal(Number(db.sql(`select count(*) from public.msgr2_works where source_message_id = ${id1}`)), 0, '기한 전에는 기다린다');
  db.sql(`update public.msgr2_msg_waits set created_at = now() - interval '3 minutes' where message_id = ${id1}`);
  say(pApp, r, '세 번째 글'); // ① 그 방의 다음 사람 글
  assert.equal(Number(db.sql(`select count(*) from public.msgr2_works where source_message_id = ${id1}`)), 1);
  const note = JSON.parse(db.sql(`select meta::text from public.msgr2_messages where room_id = '${r}' and kind = 'system' and meta->>'code' = 'msg.files_missing'`));
  assert.deepEqual([note.message, note.expected, note.got], [Number(id1), 2, 0]);
  // ③ 하루 정리
  const r2 = agentRoom(P, PS, A1);
  const id2 = say(pApp, r2, '두 번째 방', { files: 1 });
  db.sql(`update public.msgr2_msg_waits set created_at = now() - interval '3 minutes' where message_id = ${id2}`);
  db.sql('select public.msgr2_retention_prune()');
  assert.equal(Number(db.sql(`select count(*) from public.msgr2_works where source_message_id = ${id2}`)), 1);
  // ② 같은 사람의 ready
  const r3 = agentRoom(P, PS, A1);
  const id3 = say(pApp, r3, '세 번째 방', { files: 1 });
  db.sql(`update public.msgr2_msg_waits set created_at = now() - interval '3 minutes' where message_id = ${id3}`);
  const id4 = say(pApp, r2, '다른 방 글', { files: 1 });
  const a4 = JSON.parse(val(pApp, `select public.msgr2_attachment_add(${id4}, 0, 'b.txt', 'text/plain', 1)::text`));
  db.sql(`insert into storage.objects (bucket_id, name) values ('${a4.bucket}', '${a4.path}')`);
  val(pApp, `select public.msgr2_message_ready(${id4})::text`); // 성공한 ready에 얹는다(실패하면 트랜잭션이 되돌아가 폴백도 함께 취소된다 — 그때는 ①·③이 맡는다)
  assert.equal(Number(db.sql(`select count(*) from public.msgr2_works where source_message_id = ${id3}`)), 1);
  db.sql(`delete from public.msgr2_msg_waits`); // 다음 시험을 위해(서비스 정리 — 기억 데이터 아님)
});

test('쉬는 동안 쓰기 0 — 기다림이 없을 때 하루 정리·다음 사건은 메시지·일·기다림 행을 쓰지 않는다', { skip }, () => {
  assert.equal(waits(), 0);
  const snap = () => db.sql(`select (select count(*) from public.msgr2_messages) || ',' || (select count(*) from public.msgr2_works) || ',' || (select coalesce(max(xmin::text::bigint), 0) from public.msgr2_msg_waits)`);
  const a = snap();
  db.sql('select public.msgr2_retention_prune()');
  db.sql('select public._msgr2_flush_waits(null, null)');
  assert.equal(snap(), a);
});

const R = 'b0000000-0000-4000-8000-000000000004'; // Pro 3
const teamWith = (users) => { // P 주인 팀 공간 + 초대 수락으로 users를 넣는다
  const sp = val(pApp, `select public.msgr2_space_create('팀 ${Math.random().toString(36).slice(2, 8)}', null)`);
  for (const u of users) { const inv = JSON.parse(val(pApp, `select public.msgr2_invite_create('${sp}', 'member', '${u.uid}')::text`)); val(u, `select public.msgr2_invite_accept('${inv.code}')::text`); }
  return sp;
};

test('폭주 상한 — 방 사람 인원·방마다 분당 글·하루 초대(설정은 최대값을 넘지 못한다)', { skip }, () => {
  const rApp = seedDevice(db, R, 'app'); db.sql(`insert into public.test_pro values ('${R}') on conflict do nothing`);
  people(true);
  try {
    const sp = teamWith([qApp, rApp]);
    setting('msgr2_limit_room_members', '2');
    const room = val(pApp, `select public.msgr2_room_create('${sp}', 'private', '둘만', '{${Q}}')`);
    assert.match(err(pApp, `select public.msgr2_room_members_add('${room}', '{${R}}')`), /msgr2_limit/, '3번째 사람은 거부');
    setting('msgr2_limit_room_members', '999');
    assert.equal(db.sql(`select public._msgr2_clamp('msgr2_limit_room_members', 50, 50)`), '50', '방 인원은 50을 넘지 못한다');
    setting('msgr2_limit_room_members', null);
    setting('msgr2_limit_room_msg_min', '2');
    say(pApp, room, '하나'); say(qApp, room, '둘');
    assert.match(sayErr(pApp, room, '셋'), /msgr2_limit/, '방마다 분당 상한 — 다른 사람이 써도 센다');
    setting('msgr2_limit_room_msg_min', null);
    setting('msgr2_limit_invites_day', '1');
    const n = Number(db.sql(`select count(*) from public.msgr2_space_invites where created_by = '${P}' and created_at > now() - interval '1 day'`));
    assert.ok(n >= 1);
    assert.match(err(pApp, `select public.msgr2_invite_create('${sp}', 'member', null)`), /msgr2_limit/);
  } finally { ['msgr2_limit_room_members', 'msgr2_limit_room_msg_min', 'msgr2_limit_invites_day'].forEach((k) => setting(k, null)); people(false); }
});

test('퍼짐 — 사람 채팅 켬이면 팀 open 방 글은 인원과 무관하게 공간 토픽 1번(사람마다 보내지 않음), 꺼짐이면 종전대로 사람마다', { skip }, () => {
  people(true);
  try {
    const sp = teamWith([qApp]);
    const open = val(pApp, `select public.msgr2_room_create('${sp}', 'open', '모두')`);
    const before = Number(db.sql('select coalesce(max(id), 0) from realtime.sent'));
    say(pApp, open, '퍼짐 시험');
    const sent = JSON.parse(db.sql(`select coalesce(json_agg(topic), '[]') from realtime.sent where id > ${before} and event = 'msg'`));
    assert.deepEqual(sent, [`v2:s:${sp}`], '공간 토픽 한 번만');
    const priv = val(pApp, `select public.msgr2_room_create('${sp}', 'private', '둘', '{${Q}}')`);
    const b2 = Number(db.sql('select coalesce(max(id), 0) from realtime.sent'));
    say(pApp, priv, '비공개');
    assert.equal(Number(db.sql(`select count(*) from realtime.sent where id > ${b2} and event = 'msg'`)), 2, 'private 방은 사람마다(≤ 50)');
  } finally { people(false); }
});

test('알림 묶음 — 같은 방·같은 글쓴이 text는 10초 안 엣지 1번, 다른 글쓴이는 따로, 자기 글은 받는 사람 0', { skip }, () => {
  db.sql(`create table if not exists public.test_net_calls (id bigserial primary key, body jsonb);
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language sql as $$ insert into public.test_net_calls (body) values (body) returning id $$;
    do $d$ begin if to_regprocedure('public.msgr_push_headers()') is null then
      create function public.msgr_push_headers() returns jsonb language sql as $f$ select '{}'::jsonb $f$; end if; end $d$;`); // 옛 메신저 함수 대역(setup은 msgr2만)
  setting('msgr2_push_url', 'http://edge.test/msgr2-push');
  people(true);
  try {
    const sp = teamWith([qApp]);
    const room = val(pApp, `select public.msgr2_room_create('${sp}', 'private', '알림', '{${Q}}')`);
    const c0 = Number(db.sql('select count(*) from public.test_net_calls'));
    say(pApp, room, '1'); say(pApp, room, '2'); say(pApp, room, '3');
    assert.equal(Number(db.sql('select count(*) from public.test_net_calls')) - c0, 1, 'P의 글 3개 → 엣지 1번');
    say(qApp, room, '답');
    assert.equal(Number(db.sql('select count(*) from public.test_net_calls')) - c0, 2, '다른 글쓴이 답은 바로');
    db.sql(`update public.msgr2_push_gate set at = now() - interval '11 seconds' where room_id = '${room}'`);
    say(pApp, room, '4');
    assert.equal(Number(db.sql('select count(*) from public.test_net_calls')) - c0, 3, '10초가 지나면 다시');
    const own = db.sql(`select count(*) from public.msgr2_push_recipients((select max(id) from public.msgr2_messages where room_id = '${room}' and author_user_id = '${P}')) r where r.user_id = '${P}'`);
    assert.equal(own, '0', '자기 글 알림 0');
  } finally { setting('msgr2_push_url', null); people(false); }
});

test('비상 정지 — msgr2_paused 하나로 사람 글·ready·본체 봉투가 모두 멈추고, 풀면 이어진다', { skip }, () => {
  people(true);
  try {
    const sp = teamWith([qApp]);
    const room = val(pApp, `select public.msgr2_room_create('${sp}', 'private', '정지', '{${Q}}')`);
    setting('msgr2_paused', new Date().toISOString());
    assert.match(sayErr(pApp, room, '멈춤 중'), /service_paused/);
    assert.match(err(pApp, `select public.msgr2_message_ready(1)`), /service_paused/);
    const r = agentRoom(P, PS, A1);
    assert.match(sayErr(pApp, r, '에이전트에게'), /service_paused/);
    setting('msgr2_paused', null);
    say(pApp, room, '다시');
    say(pApp, r, '에이전트 다시');
    assert.equal(works(r), 1, '풀리면 일이 다시 생긴다');
  } finally { setting('msgr2_paused', null); people(false); }
});

test('쉬는 동안 쓰기 0(사람 방이 있어도) — 글이 없으면 msgr2 표 전체·방송 표의 행이 바뀌지 않는다', { skip }, () => {
  people(true);
  try {
    teamWith([qApp]);
    const tables = db.sql("select string_agg(tablename, ',') from pg_tables where schemaname = 'public' and tablename like 'msgr2\\_%'").split(',');
    const snap = () => tables.map((t) => db.sql(`select '${t}:' || count(*) || ':' || coalesce(max(xmin::text::bigint), 0) from public.${t}`)).join('|') + '|sent:' + db.sql('select count(*) from realtime.sent');
    const a = snap();
    db.sql('select public.msgr2_retention_prune()'); // 하루 1번 도는 유일한 주기 작업
    assert.equal(snap(), a);
  } finally { people(false); }
});

test('폭주 상한 보강 — 반응 달기·지우기 분당, 방 만들기 분당·하루, 방 보관 바꾸기 분당(공간당 1,000 상한 돌리기 차단), 꺼짐이면 관문 없음', { skip }, () => {
  people(true);
  try {
    const sp = teamWith([qApp]);
    const room = val(pApp, `select public.msgr2_room_create('${sp}', 'private', '반응', '{${Q}}')`);
    const mid = say(pApp, room, '반응 받을 글');
    setting('msgr2_limit_reactions_min', '2');
    val(qApp, `insert into public.msgr2_reactions (message_id, user_id, emoji) values (${mid}, '${Q}', 'a') returning emoji`);
    val(qApp, `delete from public.msgr2_reactions where message_id = ${mid} and user_id = '${Q}' and emoji = 'a' returning emoji`);
    assert.match(err(qApp, `insert into public.msgr2_reactions (message_id, user_id, emoji) values (${mid}, '${Q}', 'b')`), /msgr2_limit/, '달기·지우기를 함께 센다');
    setting('msgr2_limit_reactions_min', '999');
    assert.equal(db.sql(`select public._msgr2_clamp('msgr2_limit_reactions_min', 60, 120)`), '120');
    setting('msgr2_limit_reactions_min', null);
    db.sql(`delete from public.msgr2_rate_hits where user_id = '${P}'`); // 앞 시험이 만든 방 수를 비운다(속도 세기 칸 — 기억 데이터 아님)
    setting('msgr2_limit_room_create_min', '2');
    val(pApp, `select public.msgr2_room_create('${sp}', 'private', '하나')`);
    val(pApp, `select public.msgr2_room_create('${sp}', 'private', '둘')`);
    assert.match(err(pApp, `select public.msgr2_room_create('${sp}', 'private', '셋')`), /msgr2_limit/);
    setting('msgr2_limit_room_create_min', null);
    db.sql(`update public.msgr2_rate_hits set n = 200 where user_id = '${P}' and kind = 'room_create:day'`);
    assert.match(err(pApp, `select public.msgr2_room_create('${sp}', 'private', '하루 넘침')`), /msgr2_limit/, '하루 200');
    db.sql(`delete from public.msgr2_rate_hits where user_id = '${P}'`);
    // 보관 바꾸기: 1:1을 다시 열면 보관을 푼다(지금 사람 경로는 이것뿐) — 분당 1로 두고 두 번째 풀기 거부
    const dm = JSON.parse(val(pApp, `select public.msgr2_dm_open('${Q}', '${sp}')::text`)).room_id;
    setting('msgr2_limit_room_archive_min', '1');
    db.sql(`update public.msgr2_rooms set archived_at = now() where id = '${dm}'`);
    val(pApp, `select public.msgr2_dm_open('${Q}', '${sp}')::text`);
    db.sql(`update public.msgr2_rooms set archived_at = now() where id = '${dm}'`);
    assert.match(err(pApp, `select public.msgr2_dm_open('${Q}', '${sp}')`), /msgr2_limit/);
    setting('msgr2_limit_room_archive_min', null);
  } finally { ['msgr2_limit_reactions_min', 'msgr2_limit_room_create_min', 'msgr2_limit_room_archive_min'].forEach((k) => setting(k, null)); people(false); }
  // 꺼짐: 관문·세기 쓰기 없음
  const before = db.sql('select count(*) from public.msgr2_rate_hits');
  const r = agentRoom(P, PS, A1); const m2 = say(pApp, r, '꺼짐 반응');
  val(pApp, `insert into public.msgr2_reactions (message_id, user_id, emoji) values (${m2}, '${P}', 'x') returning emoji`);
  assert.equal(db.sql('select count(*) from public.msgr2_rate_hits'), before, '꺼짐이면 세지 않는다');
});

test('속도 세기 칸 — 쉬는 동안 쓰기 0, 하루 정리가 이틀 지난 칸만 지운다', { skip }, () => {
  db.sql(`insert into public.msgr2_rate_hits (user_id, kind, bucket, n) values ('${P}', 'old:minute', now() - interval '3 days', 1), ('${P}', 'new:minute', now(), 1) on conflict do nothing`);
  db.sql('select public.msgr2_retention_prune()');
  assert.equal(db.sql(`select string_agg(kind, ',' order by kind) from public.msgr2_rate_hits where user_id = '${P}' and kind in ('old:minute', 'new:minute')`), 'new:minute');
  const x = db.sql('select count(*) || \':\' || coalesce(max(xmin::text::bigint), 0) from public.msgr2_rate_hits');
  db.sql('select public.msgr2_retention_prune()');
  assert.equal(db.sql('select count(*) || \':\' || coalesce(max(xmin::text::bigint), 0) from public.msgr2_rate_hits'), x);
});

test('속도 상한 되돌림 — 트리거·함수·표가 없어지고 다시 적용된다', { skip }, () => {
  const down = readFileSync(fileURLToPath(new URL('../scripts/rollback/20261020201600_msgr2_rate.down.sql', import.meta.url)), 'utf8');
  const mig = readFileSync(fileURLToPath(new URL('../supabase/migrations/20261020201600_msgr2_rate.sql', import.meta.url)), 'utf8');
  db.psql(['-c', down]);
  assert.equal(db.sql(`select count(*) from pg_trigger where tgname = 'msgr2_rate_guard'`), '0');
  assert.equal(db.sql(`select to_regclass('public.msgr2_rate_hits') is null`), 't');
  assert.ok(!db.sql(`select prosrc from pg_proc where proname = 'msgr2_retention_prune'`).includes('msgr2_rate_hits'));
  db.psql(['-c', mig]);
  assert.equal(db.sql(`select count(*) from pg_trigger where tgname = 'msgr2_rate_guard'`), '2');
});

test('되돌림 — 기다림이 있으면 멈추고, 비우면 A+ 정의로 돌아간다(다시 적용 가능)', { skip }, () => {
  const r = agentRoom(P, PS, A1);
  const id = say(pApp, r, '되돌림 전', { files: 1 });
  assert.notEqual(db.raw(['-c', readFileSync(DOWN, 'utf8')]).status, 0, '기다림이 있으면 멈춘다');
  db.sql(`delete from public.msgr2_msg_waits where message_id = ${id}`);
  db.psql(['-c', readFileSync(DOWN, 'utf8')]);
  assert.equal(db.sql(`select to_regprocedure('public.msgr2_message_ready(bigint)') is null`), 't');
  assert.equal(db.sql(`select count(*) from information_schema.columns where table_name = 'msgr2_messages' and column_name = 'files_expected'`), '0');
  setting('msgr2_people', 'on'); // 되돌린 뒤에는 스위치를 넣어도 lite 그대로
  try { assert.match(err(pApp, `select public.msgr2_space_create('되돌림 뒤', null)`), /msgr2_lite_only/); } finally { setting('msgr2_people', null); }
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  assert.equal(db.sql(`select to_regprocedure('public.msgr2_message_ready(bigint)') is not null`), 't', '다시 적용');
});
