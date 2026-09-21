// UGC 신고·차단(20260921090000_msgr_ugc_report.sql) — App Store 1.2: 신고는 읽을 수 있는 남의 글만, 관리자만 처리, 표는 RPC로만.
// 차단 목록·해제는 차단한 사람만. 실행: bash scripts/billing-pg-drill.sh test/msgr-ugc-report-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-ugc-report-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const rows = (s) => s.split('\n').filter(Boolean); // psql -c는 여러 문장 중 마지막 결과만 찍는다
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));

let ORG, PUB, MSG_A, MSG_B;
before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth; grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select null::void $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  // 조직 회귀 대조군 — a·b는 같은 조직 멤버, c는 조직 밖
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
  assert.equal(last(asUser(U.b, `select public.msgr_accept_invite('${code}')`)), ORG);
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','general','[]'::jsonb)`));
  MSG_A = post(U.a, PUB, '문제 글');
  MSG_B = post(U.b, PUB, '내 글');
});

test('채널을 읽는 멤버는 남의 글을 신고하고, 관리자와 본인이 목록에서 본다', { skip }, () => {
  const rid = last(asUser(U.b, `select public.msgr_report_message(${MSG_A}, '  욕설  ')`));
  assert.match(rid, /^[0-9a-f-]{36}$/);
  assert.equal(sql(`select org_id::text || '|' || reason || '|' || status from public.msgr_reports where id = '${rid}'`), `${ORG}|욕설|open`, '조직·다듬은 사유·open으로 저장');
  assert.deepEqual(rows(asUser(U.a, `select id from public.msgr_reports_list()`)), [rid], '관리자(소유자)는 조직 신고를 본다');
  assert.deepEqual(rows(asUser(U.b, `select id from public.msgr_reports_list()`)), [rid], '신고자는 자기 신고를 본다');
  assert.deepEqual(rows(asUser(U.c, `select id from public.msgr_reports_list()`)), [], '조직 밖 사람은 못 본다');
});

test('자기 글·시스템 글·읽을 수 없는 글은 신고되지 않는다', { skip }, () => {
  fails(asUserRaw(U.b, `select public.msgr_report_message(${MSG_B})`), /msgr_report_own/, '자기 글');
  const sys = sql(`insert into public.msgr_messages (channel_id, author_kind, kind, body, client_msg_id) values ('${PUB}', 'system', 'system', '입장', gen_random_uuid()::text) returning id`).split('\n').pop();
  fails(asUserRaw(U.b, `select public.msgr_report_message(${sys})`), /msgr_report_no_message/, '시스템 글');
  fails(asUserRaw(U.c, `select public.msgr_report_message(${MSG_A})`), /msgr_report_no_message/, '조직 밖 사람 — 존재 여부도 드러내지 않는다(검수 L1)');
  fails(asUserRaw(U.b, `select public.msgr_report_message(999999)`), /msgr_report_no_message/, '없는 글');
});

test('신고 표는 직접 읽거나 쓸 수 없다 — RPC로만', { skip }, () => {
  fails(asUserRaw(U.a, `select count(*) from public.msgr_reports`), /permission denied/, '직접 select');
  fails(asUserRaw(U.b, `insert into public.msgr_reports (message_id, channel_id, reporter_user_id) values (${MSG_A}, '${PUB}', '${U.b}')`), /permission denied/, '직접 insert');
});

test('처리는 조직 관리자만 한다', { skip }, () => {
  const rid = last(asUser(U.b, `select public.msgr_report_message(${MSG_A})`));
  fails(asUserRaw(U.b, `select public.msgr_report_resolve('${rid}')`), /msgr_report_forbidden/, '일반 멤버');
  asUser(U.a, `select public.msgr_report_resolve('${rid}')`);
  assert.equal(sql(`select status || '|' || resolved_by from public.msgr_reports where id = '${rid}'`), `resolved|${U.a}`);
});

test('차단 목록과 해제는 차단한 사람만 다룬다', { skip }, () => {
  asUser(U.b, `select public.msgr_friend_remove('${U.a}', true)`);
  assert.deepEqual(rows(asUser(U.b, `select user_id from public.msgr_my_blocked()`)), [U.a], '차단한 사람의 목록에 뜬다');
  assert.deepEqual(rows(asUser(U.a, `select user_id from public.msgr_my_blocked()`)), [], '차단당한 사람의 목록에는 없다');
  asUser(U.a, `select public.msgr_friend_unblock('${U.b}')`);
  assert.equal(sql(`select count(*) from public.msgr_friends where status = 'blocked'`), '1', '차단당한 쪽은 풀 수 없다');
  asUser(U.b, `select public.msgr_friend_unblock('${U.a}')`);
  assert.equal(sql(`select count(*) from public.msgr_friends where status = 'blocked'`), '0', '차단한 쪽이 풀면 사라진다');
  assert.deepEqual(rows(asUser(U.b, `select user_id from public.msgr_my_blocked()`)), []);
});

test('개인 공간 글 신고는 신고자만 보고, 조직 관리자 처리 대상이 아니다', { skip }, () => {
  asUser(U.a, `select public.msgr_friend_request('${U.d}')`);
  asUser(U.d, `select public.msgr_friend_decide('${U.a}', true)`);
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.d}')`));
  const m = post(U.d, ch, '개인 글');
  const rid = last(asUser(U.a, `select public.msgr_report_message(${m})`));
  assert.equal(sql(`select coalesce(org_id::text, 'NULL') from public.msgr_reports where id = '${rid}'`), 'NULL');
  assert.ok(rows(asUser(U.a, `select id from public.msgr_reports_list()`)).includes(rid), '신고자는 본다');
  assert.ok(!rows(asUser(U.d, `select id from public.msgr_reports_list()`)).includes(rid), '신고당한 사람은 못 본다');
  fails(asUserRaw(U.a, `select public.msgr_report_resolve('${rid}')`), /msgr_report_forbidden/, '개인 공간 처리');
});

test('운영자는 개인 공간 신고까지 보고 처리하며, 신고가 들어오면 푸시 요청이 한 번 나간다(검수 H1)', { skip }, () => {
  sql(`create table if not exists public.fake_http (id serial, url text, body jsonb)`);
  sql(`create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $f$ insert into public.fake_http (url, body) values (url, body) returning id::bigint $f$`);
  sql(`insert into public.msgr_settings (key, value) values ('push_url', 'https://push.example.test/fn') on conflict (key) do update set value = excluded.value`);
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.d}')`));
  const before = Number(sql(`select count(*) from public.fake_http`));
  const noOp = last(asUser(U.a, `select public.msgr_report_message(${post(U.d, ch, '운영자 없을 때')})`));
  assert.equal(Number(sql(`select count(*) from public.fake_http`)), before, '운영자가 없으면 요청하지 않는다');
  sql(`insert into public.msgr_report_operators (user_id) values ('${U.c}')`);
  assert.equal(last(asUser(U.c, `select public.msgr_is_report_operator()`)), 't');
  assert.equal(last(asUser(U.b, `select public.msgr_is_report_operator()`)), 'f');
  const rid = last(asUser(U.a, `select public.msgr_report_message(${post(U.d, ch, '운영자에게 갈 글')})`));
  assert.equal(sql(`select url || '|' || (body->>'report_id') from public.fake_http order by id desc limit 1`), `https://push.example.test/fn|${rid}`, '신고 id로 푸시 요청');
  assert.ok(rows(asUser(U.c, `select id from public.msgr_reports_list()`)).includes(noOp), '운영자는 개인 공간 신고를 본다');
  assert.ok(!rows(asUser(U.b, `select id from public.msgr_reports_list()`)).includes(rid), '다른 사람은 못 본다');
  asUser(U.c, `select public.msgr_report_resolve('${rid}')`);
  assert.equal(sql(`select status from public.msgr_reports where id = '${rid}'`), 'resolved', '운영자가 처리한다');
  fails(asUserRaw(U.b, `select count(*) from public.msgr_report_operators`), /permission denied/, '운영자 표는 직접 못 읽는다');
  const n0 = Number(sql(`select count(*) from public.fake_http`));
  const prior = Number(sql(`select count(*) from public.msgr_reports where reporter_user_id = '${U.b}' and created_at > now() - interval '1 hour'`));
  assert.ok(prior < 5, `앞 테스트의 신고가 상한을 이미 채우면 이 검사는 무의미하다(prior=${prior})`);
  for (let i = 0; i < 8; i++) asUser(U.b, `select public.msgr_report_message(${post(U.a, PUB, `도배 ${i}`)})`);
  assert.equal(Number(sql(`select count(*) from public.fake_http`)) - n0, 5 - prior, '한 사람의 신고 푸시는 시간당 5건까지(검수 M1)');
  assert.ok(Number(sql(`select count(*) from public.msgr_reports where reporter_user_id = '${U.b}'`)) >= 8, '넘친 신고도 저장은 된다');
});

test('차단당한 사람이 역차단·해제로 상대의 차단을 지우지 못한다(검수 C1)', { skip }, () => {
  asUser(U.c, `select public.msgr_friend_remove('${U.a}', true)`); // c가 a를 차단
  asUser(U.a, `select public.msgr_friend_remove('${U.c}', true)`); // a가 역차단
  assert.deepEqual(rows(asUser(U.c, `select user_id from public.msgr_my_blocked()`)), [U.a], 'c의 차단은 남는다');
  assert.deepEqual(rows(asUser(U.a, `select user_id from public.msgr_my_blocked()`)), [U.c], 'a의 차단도 따로 보인다');
  asUser(U.a, `select public.msgr_friend_unblock('${U.c}')`);
  assert.deepEqual(rows(asUser(U.c, `select user_id from public.msgr_my_blocked()`)), [U.a], 'a가 풀어도 c의 차단은 그대로');
  assert.equal(sql(`select count(*) from public.msgr_friends where a = least('${U.a}'::uuid, '${U.c}'::uuid) and b = greatest('${U.a}'::uuid, '${U.c}'::uuid) and status = 'blocked' and requested_by = '${U.c}'`), '1', '서버 차단 행은 c 소유로 남는다');
  fails(asUserRaw(U.a, `select public.msgr_friend_request('${U.c}')`), /msgr_friend_blocked/, '친구 요청은 계속 막힌다');
  asUser(U.c, `select public.msgr_friend_unblock('${U.a}')`);
  assert.equal(sql(`select count(*) from public.msgr_friends where status = 'blocked'`), '0', '둘 다 풀어야 서버 차단이 사라진다');
});

test('신고 시점 본문·작성자를 보존하고, 같은 글의 열린 신고는 하나만 쌓인다(검수 M1·L2)', { skip }, () => {
  const m = post(U.a, PUB, '지울 증거');
  const r1 = last(asUser(U.b, `select public.msgr_report_message(${m})`));
  assert.equal(last(asUser(U.b, `select public.msgr_report_message(${m})`)), r1, '반복 신고는 같은 신고를 돌려준다');
  sql(`update public.msgr_messages set body = '', deleted_at = now() where id = ${m}`);
  assert.equal(last(asUser(U.a, `select message_body || '|' || author_user_id from public.msgr_reports_list() where id = '${r1}'`)), `지울 증거|${U.a}`, '작성자가 지워도 증거가 남는다');
  sql(`delete from public.msgr_messages where id = ${m}`);
  assert.equal(sql(`select count(*) from public.msgr_reports where id = '${r1}'`), '1', '글 행이 사라져도 신고는 남는다');
  const ch = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','temp','[]'::jsonb)`));
  const r2 = last(asUser(U.b, `select public.msgr_report_message(${post(U.a, ch, '채널째 지울 글')})`));
  sql(`delete from public.msgr_channels where id = '${ch}'`);
  assert.equal(sql(`select coalesce(channel_id::text, 'NULL') || '|' || body_snapshot from public.msgr_reports where id = '${r2}'`), 'NULL|채널째 지울 글', '채널을 지워도 신고·증거는 남는다(검수 N2)');
});

test('차단한 사람의 글은 차단한 수신자에게 푸시하지 않는다(나머지 수신자는 그대로)', { skip }, () => {
  const ch = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','push-block','[]'::jsonb)`));
  asUser(U.b, `select public.msgr_join_channel('${ch}')`);
  const rcpt = (mid) => last(sql(`select array_to_string(public.msgr_push_recipients_of(${mid}), ',')`)).split(',').filter(Boolean);
  const before = post(U.a, ch, '차단 전');
  assert.ok(rcpt(before).includes(U.b), 'b는 a의 글 푸시를 받는다');
  asUser(U.b, `select public.msgr_friend_remove('${U.a}', true)`);
  const after = post(U.a, ch, '차단 뒤');
  assert.ok(!rcpt(after).includes(U.b), 'b가 a를 차단하면 a의 글 푸시는 b에게 안 간다');
  const back = post(U.b, ch, 'b의 글');
  assert.ok(rcpt(back).includes(U.a), '차단당한 쪽(a)은 b의 글 푸시를 계속 받는다(차단은 한 방향)');
  asUser(U.b, `select public.msgr_friend_unblock('${U.a}')`);
});

test('차단한 사람의 글은 안 읽음 수(채널별·공간별·폰 배지)에서 빠진다', { skip }, () => {
  const ch = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','unread-block','[]'::jsonb)`));
  asUser(U.b, `select public.msgr_join_channel('${ch}')`);
  const counts = () => ({
    chan: Number(last(asUser(U.b, `select coalesce((select n from public.msgr_unread('${ORG}') where channel_id = '${ch}'), 0)`))),
    org: Number(last(asUser(U.b, `select coalesce((select n from public.msgr_unread_totals() where org_id = '${ORG}'), 0)`))),
    badge: Number(sql(`select public.msgr_push_unread_total('${U.b}')`)),
  });
  const b0 = counts();
  last(asUser(U.a, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id, mentions) values ('${ch}', 'user', '${U.a}', 'text', '멘션', gen_random_uuid()::text, '[{"kind":"user","id":"${U.b}"}]'::jsonb) returning id`));
  const b1 = counts();
  assert.equal(b1.chan, b0.chan + 1, '차단 전에는 채널 안 읽음에 들어간다');
  assert.equal(b1.badge, b0.badge + 1, '차단 전에는 폰 배지에 들어간다(멘션)');
  asUser(U.b, `select public.msgr_friend_remove('${U.a}', true)`);
  const b2 = counts();
  assert.equal(b2.chan, b0.chan, '차단 뒤 채널 안 읽음에서 빠진다');
  const fromA = Number(last(asUser(U.b, `select coalesce(sum(n), 0) from (select least(99, count(*)) n from public.msgr_messages m left join public.msgr_reads r on r.channel_id = m.channel_id and r.user_id = '${U.b}' join public.msgr_channels c on c.id = m.channel_id where c.org_id = '${ORG}' and c.archived_at is null and m.author_user_id = '${U.a}' and m.deleted_at is null and m.id > coalesce(r.last_read_id, 0) and public.msgr_can_read_channel(c.id) group by m.channel_id) s`)));
  assert.ok(fromA >= 1);
  assert.equal(b2.org, b1.org - fromA, '공간별 합계에서 차단한 사람의 글이 전부 빠진다(다른 채널 글 포함)');
  assert.equal(b2.badge, b0.badge, '폰 배지에서도 빠진다');
  fails(asUserRaw(U.b, `select count(*) from public.msgr_user_blocks`), /permission denied/, '차단 표는 여전히 직접 못 읽는다');
  assert.equal(last(asUser(U.b, `select public.msgr_i_blocked('${U.a}')`)), 't');
  assert.equal(last(asUser(U.a, `select public.msgr_i_blocked('${U.b}')`)), 'f', '도우미는 내 차단만 답한다(남의 차단 여부를 캐지 못한다)');
  asUser(U.b, `select public.msgr_friend_unblock('${U.a}')`);
});
