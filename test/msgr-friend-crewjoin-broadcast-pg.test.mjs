// 친구·에이전트 넣기 요청 실시간 방송(20261002115000, 기능 점검 D5·D6) — 받는 사람과 내용(종류와 id만)을 고정한다. 실행: bash scripts/billing-pg-drill.sh test/msgr-friend-crewjoin-broadcast-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-friend-crewjoin-broadcast-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555' };
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const post = (uid, ch, body, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
const personalCrew = (uid, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${uid}', 'ws-${uid.slice(0, 4)}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
const join = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_join('${ch}', '${crew}')`));

let ORG, PUB, AB, B1, D1;
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
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  // 방송 기록 — 실제 Realtime 대신 표에 적는다(받는 토픽·종류·내용 확인용)
  sql(`create table if not exists public._sent (n bigint generated always as identity, event text, topic text, payload jsonb)`);
  sql(`create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ insert into public._sent (event, topic, payload) values (event, topic, payload) $$`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.d, U.e]) { const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`)); asUser(u, `select public.msgr_accept_invite('${code}')`); }
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Work')`));
  asUser(U.d, `select public.msgr_join_channel('${PUB}')`);
  D1 = last(asUser(U.d, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.d}', 'ws-4444', 'd1', 'D1', 'local', 'active', 'owner') returning id`));
  B1 = personalCrew(U.b, 'b1');
});
const sent = (event) => sql(`select topic || ' ' || payload::text from public._sent where event = '${event}' order by n`).split('\n').filter(Boolean);
const clear = () => sql('delete from public._sent');

test('D5 친구 요청·수락·삭제 — 두 사람 각자의 u:에 상대 id만 보내고, 같은 상태로의 갱신은 보내지 않는다', { skip }, () => {
  clear();
  asUser(U.a, `select public.msgr_friend_request('${U.c}')`);
  assert.deepEqual(sent('friend').sort(), [`u:${U.a} {"other": "${U.c}"}`, `u:${U.c} {"other": "${U.a}"}`].sort(), '요청');
  clear(); asUser(U.c, `select public.msgr_friend_decide('${U.a}', true)`);
  assert.equal(sent('friend').length, 2, '수락');
  clear(); sql(`update public.msgr_friends set status = status where a = least('${U.a}'::uuid, '${U.c}'::uuid)`);
  assert.equal(sent('friend').length, 0, '같은 상태 갱신은 보내지 않는다');
  clear(); asUser(U.a, `select public.msgr_friend_remove('${U.c}', false)`);
  assert.equal(sent('friend').length, 2, '삭제');
  for (const r of sql(`select payload::text from public._sent`).split('\n').filter(Boolean)) assert.deepEqual(Object.keys(JSON.parse(r)), ['other'], '이름·상태 없음');
  clear(); asUser(U.b, `select public.msgr_friend_request('${U.c}')`); asUser(U.c, `select public.msgr_friend_remove('${U.b}', true)`);
  assert.ok(sent('friend').every((r) => !/blocked/.test(r)), '차단도 상태를 싣지 않는다');
});

test('D6 개인 방 넣기 요청 — 요청한 친구와 방 결재자(만든 사람)에게만, 처리도 같은 두 사람에게', { skip }, () => {
  befriend(U.a, U.b);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
  clear();
  assert.equal(join(U.b, AB, B1), 'requested');
  const got = sent('crew_join');
  assert.deepEqual(got.map((r) => r.split(' ')[0]).sort(), [`u:${U.a}`, `u:${U.b}`].sort());
  const p = JSON.parse(got[0].slice(got[0].indexOf(' ') + 1));
  assert.deepEqual(Object.keys(p).sort(), ['channel_id', 'crew_id', 'id', 'org_id', 'status']);
  assert.equal(p.status, 'pending'); assert.equal(p.crew_id, B1); assert.equal(p.org_id, null);
  const req = sql(`select id from public.msgr_channel_crew_requests where channel_id = '${AB}' and crew_id = '${B1}' and status = 'pending'`);
  clear(); asUser(U.a, `select public.msgr_crew_join_decide('${req}', true)`);
  assert.deepEqual(sent('crew_join').map((r) => r.split(' ')[0]).sort(), [`u:${U.a}`, `u:${U.b}`].sort(), '처리 결과도 두 사람에게');
  assert.ok(sent('crew_join').every((r) => r.includes('"approved"')));
});

test('D6 조직 채널 넣기 요청 — 요청자와 방장(만든 사람·조직 관리자)에게만, 다른 멤버는 받지 않는다', { skip }, () => {
  clear();
  const r = join(U.d, PUB, D1);
  assert.equal(r, 'requested', '방장이 아닌 멤버의 에이전트는 요청으로(기본 정책 approval)');
  const to = sent('crew_join').map((x) => x.split(' ')[0]);
  assert.ok(to.includes(`u:${U.d}`) && to.includes(`u:${U.a}`), to.join(','));
  assert.ok(!to.includes(`u:${U.e}`), '다른 멤버는 받지 않는다');
});
