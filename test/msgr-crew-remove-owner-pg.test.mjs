// 에이전트 빼기는 주인만(20261002120000, 기능 점검 D8 — 유건 결정 2026-10-02). 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-remove-owner-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-remove-owner-pg.test.mjs';
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

let ORG, PUB, AB, GRP, A1, B1, D1, CO;
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
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.d, U.e]) { const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`)); asUser(u, `select public.msgr_accept_invite('${code}')`); }
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Work')`));
  asUser(U.d, `select public.msgr_join_channel('${PUB}')`);
  D1 = last(asUser(U.d, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.d}', 'ws-4444', 'd1', 'D1', 'local', 'active', 'owner') returning id`));
  sql(`update public.msgr_orgs set service_user_id = '${U.e}' where id = '${ORG}'`); // 회사 에이전트 = 조직 서비스 계정이 소유한 상주 에이전트
  CO = sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.e}', 'ws-node', 'co', 'Company', 'resident', 'active', 'all') returning id`);
  A1 = personalCrew(U.a, 'a1'); B1 = personalCrew(U.b, 'b1');
  befriend(U.a, U.b); befriend(U.a, U.c); befriend(U.b, U.c);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`)); // a가 만든 방(a = 결재자)
  GRP = last(asUser(U.b, `select public.msgr_dm_personal_group(array['${U.a}', '${U.c}']::uuid[], 'B방')`)); // b가 만든 방(b = 방장)
});
const inRoom = (ch, crew) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'crew' and member_id = '${crew}'`) === '1';
const decideAll = (uid, ch) => { for (const id of sql(`select id from public.msgr_channel_crew_requests where channel_id = '${ch}' and status = 'pending'`).split('\n').filter(Boolean)) asUser(uid, `select public.msgr_crew_join_decide('${id}', true)`); };

test('내가 만든 방 — 내 에이전트는 허락 없이 넣고, 내가 뺀다', { skip }, () => {
  assert.equal(join(U.a, AB, A1), 'joined', '허락 없이 바로');
  assert.equal(last(asUser(U.a, `select public.msgr_crew_leave_channel('${AB}', '${A1}')`)), 'removed');
  assert.equal(inRoom(AB, A1), false);
  assert.equal(join(U.a, AB, A1), 'joined', '다시 넣기도 바로');
});

test('방장이 아닌 친구는 남의 에이전트를 못 뺀다 — RPC 거절, 직접 삭제는 지워지지 않는다', { skip }, () => {
  assert.equal(inRoom(AB, A1), true);
  fails(asUserRaw(U.b, `select public.msgr_crew_leave_channel('${AB}', '${A1}')`), /msgr_crew_remove_owner_only/, 'b가 a의 에이전트 빼기(RPC)');
  asUser(U.b, `delete from public.msgr_channel_members where channel_id = '${AB}' and member_kind = 'crew' and member_id = '${A1}'`);
  assert.equal(inRoom(AB, A1), true, '직접 삭제도 RLS가 막는다');
});

test('친구가 방장이어도 남의 에이전트를 못 뺀다 — 넣기는 방장 허락, 빼기는 주인만', { skip }, () => {
  assert.equal(join(U.a, GRP, A1), 'requested', '친구 방에는 허락이 필요');
  decideAll(U.b, GRP);
  assert.equal(inRoom(GRP, A1), true);
  fails(asUserRaw(U.b, `select public.msgr_crew_leave_channel('${GRP}', '${A1}')`), /msgr_crew_remove_owner_only/, '방장 b가 a의 에이전트 빼기(RPC)');
  asUser(U.b, `delete from public.msgr_channel_members where channel_id = '${GRP}' and member_kind = 'crew' and member_id = '${A1}'`);
  assert.equal(inRoom(GRP, A1), true, '방장의 직접 삭제도 막힌다');
  assert.equal(last(asUser(U.a, `select public.msgr_crew_leave_channel('${GRP}', '${A1}')`)), 'removed', '주인은 친구 방에서도 뺄 수 있다');
});

test('공개 채널 내보내기(제외 목록) — 남의 에이전트는 방장도 못 넣고, 회사 에이전트는 방장이 넣는다', { skip }, () => {
  fails(asUserRaw(U.a, `update public.msgr_channels set excluded_crew_ids = array['${D1}']::uuid[] where id = '${PUB}'`), /msgr_crew_remove_owner_only/, '방장 a가 d의 에이전트 제외');
  asUser(U.a, `update public.msgr_channels set excluded_crew_ids = array['${CO}']::uuid[] where id = '${PUB}'`);
  assert.equal(sql(`select array_length(excluded_crew_ids, 1) from public.msgr_channels where id = '${PUB}'`), '1', '회사 에이전트 제외는 된다');
  asUser(U.a, `update public.msgr_channels set excluded_crew_ids = '{}' where id = '${PUB}'`);
  assert.equal(sql(`select coalesce(array_length(excluded_crew_ids, 1), 0) from public.msgr_channels where id = '${PUB}'`), '0', '되돌리기(목록에서 빼기)는 막지 않는다');
});

test('주인이 방을 나가면 그 주인의 에이전트도 빠진다(규칙 14 — 지금 동작 그대로)', { skip }, () => {
  assert.equal(join(U.a, GRP, A1), 'requested'); decideAll(U.b, GRP);
  assert.equal(inRoom(GRP, A1), true);
  asUser(U.a, `delete from public.msgr_channel_members where channel_id = '${GRP}' and member_kind = 'user' and member_id = '${U.a}'`);
  assert.equal(inRoom(GRP, A1), false);
});
