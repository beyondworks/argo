// 메신저 v2 휴대폰 알림(U7) — 받는 사람 판정·트리거·멱등 장부·보존을 실제 Postgres에서. 옛 메신저 마이그레이션 전체 + msgr2를 운영 순서로 적용한 판(setupFull).
// pg_net은 대역: net.http_post를 부르면 그 호출을 표에 남긴다(주소·본문).
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-push-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-push-pg.test.mjs';
const O = '60000000-0000-4000-8000-000000000001'; // 주인
const M = '60000000-0000-4000-8000-000000000002'; // 팀 멤버(방 멤버)
const G = '60000000-0000-4000-8000-000000000003'; // 팀 손님(방 멤버)
const X = '60000000-0000-4000-8000-000000000004'; // 팀 멤버지만 그 비공개 방 멤버 아님
const R = '60000000-0000-4000-8000-000000000005'; // 방에서 빠진 사람
let db, PS, TS, DM, TR, OPEN, AG;
const tok = (n) => n.toString(16).padStart(64, 'a');

const recipients = (mid) => db.sql(`select coalesce(string_agg(user_id::text || ':' || push_token, ',' order by user_id, push_token), '') from public.msgr2_push_recipients(${mid})`).split(',').filter(Boolean);
const usersOf = (mid) => [...new Set(recipients(mid).map((x) => x.split(':')[0]))].sort();
const calls = () => Number(db.sql('select count(*) from public._push_calls'));
const lastCall = () => JSON.parse(db.sql(`select to_jsonb(c) from public._push_calls c order by id desc limit 1`));
const post = (room, { author = O, kind = 'text', body = '안녕', meta = '{}', agent = null } = {}) => db.sql(agent
  ? `insert into public.msgr2_messages (room_id, author_kind, author_agent_id, kind, body, meta) values ('${room}', 'agent', '${agent}', '${kind}', '${body}', '${meta}'::jsonb) returning id`
  : `insert into public.msgr2_messages (room_id, author_kind, author_user_id, kind, body, meta) values ('${room}', 'user', '${author}', '${kind}', '${body}', '${meta}'::jsonb) returning id`);
const appWithToken = (uid, n, opts) => { const d = seedDevice(db, uid, 'app', opts); db.sql(`update public.msgr2_devices set push_token = '${tok(n)}' where id = '${d.dev}'`); return d; };

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  db.sql(`create table if not exists public._push_calls (id bigserial primary key, url text, body jsonb, headers jsonb);
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language plpgsql as $$ begin insert into public._push_calls (url, body, headers) values (url, body, headers); return 1; end $$;
    insert into public.msgr_settings (key, value) values ('msgr2_push_url', 'https://edge.test/msgr2-push') on conflict (key) do update set value = excluded.value`);
  for (const u of [O, M, G, X, R]) db.sql(`insert into auth.users (id) values ('${u}') on conflict do nothing`);
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  TS = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '팀', '${O}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner'), ('${TS}', '${O}', 'owner'), ('${TS}', '${M}', 'member'), ('${TS}', '${G}', 'guest'), ('${TS}', '${X}', 'member'), ('${TS}', '${R}', 'member')`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'a', '에이') returning id`);
  DM = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PS}', 'direct', 'o-a-push') returning id`);
  TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '팀방') returning id`);
  OPEN = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'open', '전체') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${DM}', 'user', '${O}'), ('${DM}', 'agent', '${AG}'),
    ('${TR}', 'user', '${O}'), ('${TR}', 'user', '${M}'), ('${TR}', 'user', '${G}'), ('${TR}', 'user', '${R}'), ('${OPEN}', 'user', '${O}')`);
  db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${TR}' and member_id = '${R}'`);
  for (const [u, n] of [[O, 1], [M, 2], [G, 3], [X, 4], [R, 5]]) appWithToken(u, n);
});

test('1:1: 에이전트 답 → 주인 앱 기기에 알림(트리거가 엣지를 한 번 부른다), 주인 자신의 글은 받는 사람 0(엣지가 0건으로 끝낸다)', { skip }, () => {
  const c0 = calls();
  const mid = post(DM, { agent: AG, body: '초안 올렸어요' });
  assert.deepEqual(usersOf(mid), [O]);
  assert.equal(calls(), c0 + 1);
  assert.deepEqual(lastCall().body, { message_id: Number(mid) });
  assert.equal(lastCall().url, 'https://edge.test/msgr2-push');
  const own = post(DM, { author: O });
  assert.deepEqual(usersOf(own), [], '본인 제외');
  assert.equal(calls(), c0 + 2, '트리거는 받는 사람을 계산하지 않는다 — 대상 글이면 엣지를 한 번 부르고, 엣지가 받는 사람 0으로 끝낸다');
});

test('팀 비공개 방: 방 멤버(멤버·손님)는 받고, 방 멤버 아닌 팀원·빠진 사람·보낸 사람은 못 받는다', { skip }, () => {
  const mid = post(TR, { author: M });
  assert.deepEqual(usersOf(mid), [O, G].sort());
});

test('팀 open 방: 방 멤버가 아니어도 owner·admin·member는 받는다(읽기 판정과 같다), 손님은 open 방을 읽지 못해 못 받는다', { skip }, () => {
  const mid = post(OPEN, { author: O });
  assert.deepEqual(usersOf(mid), [M, X, R].sort());
});

test('기기: 폐기·만료·세대 지남·푸시 토큰 없음·본체(runner) 기기는 빼고, 한 사람의 앱 기기 여럿은 모두', { skip }, () => {
  const U = '60000000-0000-4000-8000-0000000000aa';
  db.sql(`insert into auth.users (id) values ('${U}') on conflict do nothing; insert into public.msgr2_space_members (space_id, user_id, role) values ('${TS}', '${U}', 'member');
    insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TR}', 'user', '${U}')`);
  appWithToken(U, 10); appWithToken(U, 11);
  appWithToken(U, 12, { revoked: true }); appWithToken(U, 13, { expired: true });
  const noTok = seedDevice(db, U, 'app'); void noTok;
  const run = seedDevice(db, U, 'runner'); db.sql(`update public.msgr2_devices set push_token = '${tok(14)}' where id = '${run.dev}'`);
  const mid = post(TR, { author: O });
  const mine = recipients(mid).filter((x) => x.startsWith(U)).map((x) => x.split(':')[1]).sort();
  assert.deepEqual(mine, [tok(10), tok(11)]);
  // 사용자 폐기 세대를 올리면(모든 기기 폐기) 옛 세대 기기는 빠진다
  db.sql(`insert into public.msgr2_user_gen (user_id, gen) values ('${U}', 1) on conflict (user_id) do update set gen = public.msgr2_user_gen.gen + 1`);
  assert.equal(recipients(post(TR, { author: O })).filter((x) => x.startsWith(U)).length, 0);
});

test('음소거한 방·지금 그 방을 보고 있는 사람(최근 60초 읽음 갱신)은 빼고, 오래전에 읽은 사람은 받는다', { skip }, () => {
  db.sql(`insert into public.msgr2_prefs (room_id, user_id, muted) values ('${TR}', '${G}', true) on conflict (room_id, user_id) do update set muted = true`);
  db.sql(`insert into public.msgr2_reads (room_id, user_id, last_read_id, updated_at) values ('${TR}', '${O}', 1, now()) on conflict (room_id, user_id) do update set updated_at = now()`);
  let mid = post(TR, { author: M });
  assert.deepEqual(usersOf(mid).filter((u) => [O, G].includes(u)), [], '음소거·보는 중 제외');
  db.sql(`update public.msgr2_reads set updated_at = now() - interval '5 minutes' where room_id = '${TR}' and user_id = '${O}'`);
  db.sql(`update public.msgr2_prefs set muted = false where room_id = '${TR}' and user_id = '${G}'`);
  mid = post(TR, { author: M });
  assert.deepEqual(usersOf(mid).filter((u) => [O, G].includes(u)), [O, G].sort());
});

test('대상 글: text와 승인 요청 카드만 — 시스템 글·진행 카드·지운 글은 알림·엣지 호출 없음', { skip }, () => {
  const c0 = calls();
  const card = post(TR, { author: M, kind: 'card', body: '메일 발송', meta: '{"code":"approval.request"}' });
  assert.ok(usersOf(card).length > 0); assert.equal(calls(), c0 + 1);
  post(TR, { author: M, kind: 'card', meta: '{"code":"work.progress"}' });
  db.sql(`insert into public.msgr2_messages (room_id, author_kind, kind, body, meta) values ('${TR}', 'system', 'system', '', '{"code":"topic.resolved"}')`);
  assert.equal(calls(), c0 + 1);
  const gone = post(TR, { author: M });
  db.sql(`update public.msgr2_messages set deleted_at = now() where id = ${gone}`);
  assert.deepEqual(usersOf(gone), [], '지운 글은 받는 사람 없음(엣지가 다시 계산한다)');
});

test('보내지 않는 때: 백필 중(서비스 문맥 + msgr2.backfill = on)·v2 중단 스위치·주소 설정 없음', { skip }, () => {
  const c0 = calls();
  db.psql(['-c', `set msgr2.backfill = 'on'; insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${TR}', 'user', '${M}', '옛 글')`]);
  assert.equal(calls(), c0, '백필 중');
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_paused', '2026-10-18T00:00:00Z') on conflict (key) do update set value = excluded.value`);
  post(TR, { author: M });
  assert.equal(calls(), c0, '중단 스위치');
  db.sql(`delete from public.msgr_settings where key = 'msgr2_paused'`);
  db.sql(`update public.msgr_settings set value = '' where key = 'msgr2_push_url'`);
  post(TR, { author: M });
  assert.equal(calls(), c0, '주소 없음');
  db.sql(`update public.msgr_settings set value = 'https://edge.test/msgr2-push' where key = 'msgr2_push_url'`);
  post(TR, { author: M });
  assert.equal(calls(), c0 + 1, '되돌리면 다시 부른다');
});

test('푸시가 실패해도 글 저장은 그대로(트리거 예외를 삼킨다)', { skip }, () => {
  db.sql(`create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
    language plpgsql as $$ begin raise exception 'pg_net down'; end $$`);
  try {
    const mid = post(TR, { author: M, body: '저장돼야 함' });
    assert.equal(db.sql(`select body from public.msgr2_messages where id = ${mid}`), '저장돼야 함');
  } finally {
    db.sql(`create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language plpgsql as $$ begin insert into public._push_calls (url, body, headers) values (url, body, headers); return 1; end $$`);
  }
});

test('멱등 장부: 같은 글은 한 번만 잡힌다(엣지가 409로 건너뛴다), 사람·본체 세션은 장부·받는 사람 함수에 손대지 못한다', { skip }, () => {
  db.sql(`insert into public.msgr2_push_sent (message_id) values (900001)`);
  assert.match(db.raw(['-c', `insert into public.msgr2_push_sent (message_id) values (900001)`]).stderr, /duplicate key|unique/);
  const app = seedDevice(db, M, 'app');
  assert.match(db.asErr(M, app.sid, `select * from public.msgr2_push_recipients(1)`) ?? '', /permission denied/);
  assert.match(db.asErr(M, app.sid, `select * from public.msgr2_push_sent`) ?? '', /permission denied/);
});

test('보존: 장부 7일 지난 행만 지우고 최근 행은 남긴다, 정리를 다시 불러도 그대로', { skip }, () => {
  db.sql(`insert into public.msgr2_push_sent (message_id, claimed_at) values (900100, now() - interval '8 days'), (900101, now() - interval '1 day')`);
  db.sql('select public.msgr2_push_prune()');
  assert.equal(db.sql(`select string_agg(message_id::text, ',' order by message_id) from public.msgr2_push_sent where message_id in (900100, 900101)`), '900101');
  const x0 = db.xmins('msgr2_push_sent');
  db.sql('select public.msgr2_push_prune()');
  assert.equal(db.xmins('msgr2_push_sent'), x0, '지울 것이 없으면 쓰기 0');
});

test('유휴 쓰기 0: 받는 사람 계산은 읽기만(기기·읽음·장부 표 xmin 그대로)', { skip }, () => {
  const before = ['msgr2_devices', 'msgr2_reads', 'msgr2_push_sent'].map((t) => db.xmins(t));
  const mid = post(TR, { author: M });
  for (let i = 0; i < 3; i++) recipients(mid);
  assert.deepEqual(['msgr2_devices', 'msgr2_reads', 'msgr2_push_sent'].map((t) => db.xmins(t)), before);
});

test('트리거는 받는 사람을 계산하지 않는다 — 받는 사람 함수가 실패해도 대상 글이면 엣지를 한 번 부른다(판정은 엣지에서 한 번만)', { skip }, () => {
  db.sql(`alter function public.msgr2_push_recipients(bigint) rename to msgr2_push_recipients_real`);
  db.sql(`create function public.msgr2_push_recipients(p_message bigint) returns table (user_id uuid, push_token text) language plpgsql as $$ begin raise exception 'recipients called'; end $$`);
  try {
    const c0 = calls();
    post(TR, { author: M, body: '트리거 판정 확인' });
    assert.equal(calls(), c0 + 1, '받는 사람 함수를 불렀다면 예외를 삼켜 호출이 0이었을 것이다');
  } finally {
    db.sql(`drop function public.msgr2_push_recipients(bigint); alter function public.msgr2_push_recipients_real(bigint) rename to msgr2_push_recipients`);
  }
});

test('큰 방: 800명 open 방에도 글 넣기는 받는 사람 수와 무관하게 빠르다(측정을 남긴다)', { skip }, (t) => {
  const BIG = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'open', '큰방') returning id`);
  db.sql(`with u as (select gen_random_uuid() as id from generate_series(1, 800)),
    a as (insert into auth.users (id) select id from u returning id),
    m as (insert into public.msgr2_space_members (space_id, user_id, role) select '${TS}', id, 'member' from a returning user_id)
    insert into public.msgr2_devices (user_id, kind, app, app_version, session_id, push_token, expires_at)
      select user_id, 'app', 'messenger', '0.1.200', gen_random_uuid(), md5(user_id::text) || md5(user_id::text), now() + interval '30 days' from m`);
  const time = (room) => Number(db.sql(`do $$ declare t0 timestamptz := clock_timestamp(); begin
      insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${room}', 'user', '${O}', '측정');
      perform set_config('argo.t_ms', (extract(epoch from clock_timestamp() - t0) * 1000)::text, false); end $$; select current_setting('argo.t_ms')`).split('\n').pop());
  for (let i = 0; i < 3; i++) { time(BIG); time(DM); } // 예열
  const big = Math.min(...[0, 1, 2, 3, 4].map(() => time(BIG)));
  const small = Math.min(...[0, 1, 2, 3, 4].map(() => time(DM)));
  t.diagnostic(`글 넣기(최솟값 5회): 800명 open 방 ${big.toFixed(2)}ms · 1:1 방 ${small.toFixed(2)}ms (검수 실측: 받는 사람을 트리거에서 계산하면 800명 방 173ms)`);
  assert.ok(big < 50, `800명 방 글 넣기 ${big}ms — 받는 사람을 트리거에서 계산하고 있다`);
  assert.ok(recipients(db.sql(`select max(id) from public.msgr2_messages where room_id = '${BIG}'`)).length >= 800, '판정은 엣지에서 그대로(800명 이상)');
});

test('보존 정리: pg_net 응답 삭제가 실패해도(권한 없음 등) 장부 7일 정리는 롤백되지 않는다', { skip }, () => {
  db.sql(`create table if not exists net._http_response (id bigint)`); // created 열이 없어 삭제가 실패하는 대역
  try {
    db.sql(`insert into public.msgr2_push_sent (message_id, claimed_at) values (900200, now() - interval '9 days')`);
    db.sql('select public.msgr2_push_prune()');
    assert.equal(db.sql(`select count(*) from public.msgr2_push_sent where message_id = 900200`), '0');
  } finally { db.sql('drop table net._http_response'); }
});

test('되돌림: 장부에 행이 있으면 멈추고 아무것도 지우지 않는다 — 비운 뒤에는 트리거·함수·표가 사라지고 글 쓰기는 그대로', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const down = readFileSync(new URL('../scripts/rollback/20261018030000_msgr2_push.down.sql', import.meta.url), 'utf8');
  const r = db.raw(['-v', 'ON_ERROR_STOP=1', '-c', down]);
  assert.notEqual(r.status, 0, '행이 있으면 실패');
  assert.equal(db.sql(`select count(*) from pg_trigger where tgname = 'msgr2_push_after_insert'`), '1', '실패하면 그대로');
  db.sql('truncate public.msgr2_push_sent');
  const ok = db.raw(['-v', 'ON_ERROR_STOP=1', '-c', down]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(db.sql(`select count(*) from pg_trigger where tgname = 'msgr2_push_after_insert'`), '0');
  assert.equal(db.sql(`select to_regclass('public.msgr2_push_sent') is null`), 't');
  assert.equal(db.sql(`select to_regprocedure('public.msgr2_push_recipients(bigint)') is null`), 't');
  const c0 = calls();
  post(TR, { author: M, body: '되돌린 뒤' });
  assert.equal(calls(), c0, '되돌린 뒤에는 호출 없음, 글은 저장');
});
