// 봇 넘김 한도(유건 2026-09-29): 한도에 걸린 답이 통째로 버려져 사장이 아무 답도 못 봤다(페퍼 - v 1609, 멘션 9명 → 409).
// 규칙: ① 한도를 넘어도 답은 저장하고 전달만 하지 않는다(meta.handoff_dropped·handoff_reason) ② 봇 소유자·조직 관리자가 직접 시킨 턴은
// 조직의 활성 에이전트 수까지 멘션 가능, 에이전트끼리 넘길 때는 5명 그대로 ③ 스레드 10홉 상한은 그대로(넘으면 ①처럼 저장).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asAnon = (q) => sql(`set role anon; ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, PUB, BOT, OTHERS;
before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated;
    grant usage on schema realtime to authenticated;
  `]);
  // Supabase's outbound HTTP extension is stubbed; all Messenger SQL, RLS and triggers run unchanged.
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  for (const f of readdirSync(fileURLToPath(new URL('../supabase/migrations/', import.meta.url))).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort())
    psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.admin}', 'admin'), ('${ORG}', '${U.member}', 'member')`);
  BOT = JSON.parse(last(asUser(U.owner, `select msgr_bot_create('${ORG}','hermes','pepper','moderator')`)));
  OTHERS = Array.from({ length: 11 }, (_, i) => JSON.parse(last(asUser(U.owner, `select msgr_bot_create('${ORG}','hermes','peer${i}','peer')`))).crew_id);
  sql(`update msgr_crews set allow='all', last_seen_at=now(), dm_delivery_protocol=1 where org_id='${ORG}'`);
  PUB = last(asUser(U.owner, `select msgr_create_channel('${ORG}','public','ops','[]')`));
  for (const id of [BOT.crew_id, ...OTHERS]) sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${PUB}','crew','${id}') on conflict do nothing`);
  for (const id of [U.admin, U.member]) sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${PUB}','user','${id}') on conflict do nothing`);
});

const post = (author, text = 'go') => last(asUser(author, `insert into public.msgr_messages(channel_id, author_kind, author_user_id, body, mentions) values ('${PUB}', 'user', '${author}', '${text}', '[{"kind":"crew","id":"${BOT.crew_id}"}]') returning id`));
const claim = (src) => JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${BOT.token}') x`)).map((u) => u.message).find((m) => m.message_id === Number(src));
const finish = (m, n, disposition = 'handoff') => asAnon(`select public.msgr_bot_finish('${BOT.token}', '${PUB}', 'answer', ${m.message_id}, '${m.execution_attempt}', '${disposition}', '${JSON.stringify(OTHERS.slice(0, n).map((id) => ({ kind: 'crew', id })))}')`);
const claimAny = (src) => JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${BOT.token}') x`)).map((u) => u.message).find((m) => m.message_id === Number(src));
const finishIn = (ch, m, mentions) => asAnon(`select public.msgr_bot_finish('${BOT.token}', '${ch}', 'answer', ${m.message_id}, '${m.execution_attempt}', 'handoff', '${JSON.stringify(mentions)}')`);
const row = (id) => JSON.parse(sql(`select jsonb_build_object('mentions', jsonb_array_length(mentions), 'disposition', meta->>'disposition', 'dropped', meta->'handoff_dropped', 'reason', meta->>'handoff_reason') from msgr_messages where id = ${id}`));

test('소유자가 직접 시킨 턴 — 활성 에이전트 수까지 멘션해 넘긴다(9명 공지가 409로 사라지던 사고)', { skip }, () => {
  const m = claim(post(U.owner)); assert.ok(m, '봇이 받았다');
  assert.deepEqual(row(finish(m, 7)), { mentions: 7, disposition: 'handoff', dropped: null, reason: null });
});

test('조직 관리자가 직접 시킨 턴도 같다', { skip }, () => {
  const m = claim(post(U.admin)); assert.ok(m);
  assert.equal(row(finish(m, 6)).mentions, 6);
});

test('일반 멤버가 시킨 턴은 5명까지 — 넘으면 답은 저장하고 넘김만 뺀다(사라지지 않는다)', { skip }, () => {
  const m = claim(post(U.member)); assert.ok(m);
  assert.deepEqual(row(finish(m, 6)), { mentions: 0, disposition: 'done', dropped: 6, reason: 'mentions' });
  assert.equal(sql(`select state from msgr_executions where source_msg_id = ${m.message_id} and crew_id = '${BOT.crew_id}'`), 'completed', '실행도 닫힌다(10분 뒤 "결과 미도착" 안내가 뜨지 않게)');
  const ok = claim(post(U.member)); assert.equal(row(finish(ok, 5)).mentions, 5, '5명은 그대로 넘긴다');
});

test('스레드 10홉을 넘은 넘김도 답은 저장한다(reason=hop)', { skip }, () => {
  const src = post(U.owner); const m = claim(src);
  for (let i = 0; i < 10; i++) sql(`insert into msgr_messages(channel_id, author_kind, crew_id, kind, body, reply_to, thread_root, client_msg_id) values ('${PUB}','crew','${OTHERS[0]}','text','h${i}',${src},${src},'hop:${src}:${i}')`);
  assert.deepEqual(row(finish(m, 1)), { mentions: 0, disposition: 'done', dropped: 1, reason: 'hop' });
});

test('에이전트가 넘긴 턴(원문이 크루 글)은 소유자 뿌리여도 5명까지 — 에이전트끼리 부르며 폭주하지 않게', { skip }, () => {
  const root = post(U.owner); const first = claim(root); finish(first, 0, 'done');
  const relay = sql(`insert into msgr_messages(channel_id, author_kind, crew_id, kind, body, reply_to, thread_root, client_msg_id, mentions, meta) values ('${PUB}','crew','${OTHERS[0]}','text','@pepper next',${root},${root},'peer-relay:${root}','[{"kind":"crew","id":"${BOT.crew_id}"}]','{"disposition":"handoff","hop":1}') returning id`).split('\n').pop();
  const m = claim(relay); assert.ok(m, '크루 넘김 글도 봇이 받는다');
  assert.deepEqual(row(finish(m, 6)), { mentions: 0, disposition: 'done', dropped: 6, reason: 'mentions' });
});

// 검수 #752 HIGH-1: 에이전트가 DM에서 넘기면 전달 트리거가 받는 쪽 1:1에 "사람 글"(meta.relay.via_crew_id)을 새로 만든다 —
// 이걸 사람이 시킨 턴으로 보면 에이전트끼리의 넘김이 5명 상한을 벗어나 전달마다 불어났다(재현: 6명 넘김 → 전달 6건, depth 2).
test('DM 전달로 받은 에이전트의 넘김(via_crew_id)은 사람 지시가 아니다 — 5명 상한', { skip }, () => {
  const X = OTHERS[10];
  const dm = sql(`select msgr_dm_for_crew('${ORG}','${U.owner}','${X}')`);
  const root = last(asUser(U.owner, `insert into public.msgr_messages(channel_id, author_kind, author_user_id, body, mentions) values ('${dm}','user','${U.owner}','do it','[{"kind":"crew","id":"${X}"}]') returning id`));
  sql(`insert into msgr_messages(channel_id, author_kind, crew_id, kind, body, reply_to, thread_root, client_msg_id, mentions, meta) values ('${dm}','crew','${X}','text','@pepper go',${root},${root},'reply:${X}:${root}','[{"kind":"crew","id":"${BOT.crew_id}"}]','{"disposition":"handoff","hop":0}')`);
  const r = JSON.parse(sql(`select jsonb_build_object('id',id,'channel',channel_id,'via',meta->'relay'->>'via_crew_id') from msgr_messages where client_msg_id='relay:'||(select id from msgr_messages where client_msg_id='reply:${X}:${root}')||':${BOT.crew_id}'`));
  assert.equal(r.via, X, '전제: 에이전트 경유 전달 글');
  const m = claimAny(r.id); assert.ok(m);
  const out = finishIn(r.channel, m, OTHERS.slice(0, 6).map((id) => ({ kind: 'crew', id })));
  assert.deepEqual(row(out), { mentions: 0, disposition: 'done', dropped: 6, reason: 'mentions' });
  assert.equal(sql(`select count(*) from msgr_messages where client_msg_id like 'relay:${out}:%'`), '0', '전달이 불어나지 않는다');
});

// 검수 #752 MEDIUM-2: 채널에서는 스레드 10홉 상한 때문에 10명 이상에게 넘기면 10번째 답부터 받기가 거절돼 사라졌다 —
// 채널의 확대 상한은 9명(넘김 1 + 답 9 = 10 안). DM 넘김은 각자의 1:1로 전달되어 이 상한이 없다(이번 사고는 DM, 9명).
test('채널에서 소유자 턴의 확대 상한은 9명 — 10명이면 저장만(답 유실 방지)', { skip }, () => {
  const m = claim(post(U.owner)); assert.ok(m);
  assert.deepEqual(row(finish(m, 10)), { mentions: 0, disposition: 'done', dropped: 10, reason: 'mentions' });
  const ok = claim(post(U.owner)); assert.equal(row(finish(ok, 9)).mentions, 9);
});

test('DM에서 소유자 턴은 활성 에이전트 수까지(10명)', { skip }, () => {
  const dm = sql(`select msgr_dm_for_crew('${ORG}','${U.owner}','${BOT.crew_id}')`);
  const src = last(asUser(U.owner, `insert into public.msgr_messages(channel_id, author_kind, author_user_id, body, mentions) values ('${dm}','user','${U.owner}','모두에게 전달','[{"kind":"crew","id":"${BOT.crew_id}"}]') returning id`));
  const m = claimAny(src); assert.ok(m, '봇이 DM 글을 받는다');
  assert.equal(row(finishIn(dm, m, OTHERS.slice(0, 10).map((id) => ({ kind: 'crew', id })))).mentions, 10);
});

// 검수 #752 LOW-4: 같은 크루를 반복해 상한을 채우거나, 안내 숫자에 중복이 섞이지 않게 서로 다른 크루 수로 센다
test('중복 멘션은 한 번으로 센다', { skip }, () => {
  const m = claim(post(U.member)); assert.ok(m);
  const dup = [...Array(6)].map(() => ({ kind: 'crew', id: OTHERS[0] }));
  assert.equal(row(finishIn(PUB, m, dup)).disposition, 'handoff', '서로 다른 크루는 1명 — 상한(5) 안');
});

// 재검수 #752 MEDIUM-1: 서로 다른 크루 수만 세면 같은 크루 2만 번 반복 배열이 통과해 반복문·저장이 커졌다(호출 12초) — 중복을 없앤 배열로 바꿔 저장
test('대량 중복 멘션은 중복을 없앤 배열로 저장한다', { skip }, () => {
  const m = claim(post(U.owner)); assert.ok(m);
  const out = finishIn(PUB, m, [...Array(2000)].map(() => ({ kind: 'crew', id: OTHERS[1] })));
  assert.deepEqual(row(out), { mentions: 1, disposition: 'handoff', dropped: null, reason: null });
});

// 재검수 #752 MEDIUM-2: 같은 방에서 답하는 넘김(채널·크루 여럿인 그룹 대화)은 스레드 10홉 안이어야 답이 다 저장된다 —
// 확대 상한 = 9 - 이미 쌓인 크루 글 수. 활성 수까지는 크루가 하나뿐인 1:1 DM(대상이 각자의 1:1로 전달)만.
test('그룹 대화(크루 여럿인 dm)는 채널과 같은 9명 상한', { skip }, () => {
  const g = last(asUser(U.owner, `select msgr_create_channel('${ORG}','dm','dm:group','${JSON.stringify([BOT.crew_id, ...OTHERS].map((id) => ({ kind: 'crew', id })))}')`));
  const src = last(asUser(U.owner, `insert into public.msgr_messages(channel_id, author_kind, author_user_id, body, mentions) values ('${g}','user','${U.owner}','모두','[{"kind":"crew","id":"${BOT.crew_id}"}]') returning id`));
  const m = claimAny(src); assert.ok(m, '그룹 대화 글을 봇이 받는다');
  assert.deepEqual(row(finishIn(g, m, OTHERS.slice(0, 10).map((id) => ({ kind: 'crew', id })))), { mentions: 0, disposition: 'done', dropped: 10, reason: 'mentions' });
});

test('채널 스레드에 이미 크루 답이 쌓였으면 그만큼 상한이 줄어든다(9 - hop)', { skip }, () => {
  const src = post(U.owner); const m = claim(src); assert.ok(m);
  for (let i = 0; i < 3; i++) sql(`insert into msgr_messages(channel_id, author_kind, crew_id, kind, body, reply_to, thread_root, client_msg_id) values ('${PUB}','crew','${OTHERS[i]}','text','pre${i}',${src},${src},'pre:${src}:${i}')`);
  assert.deepEqual(row(finish(m, 7)), { mentions: 0, disposition: 'done', dropped: 7, reason: 'mentions' }, '9 - 3 = 6명까지');
});
