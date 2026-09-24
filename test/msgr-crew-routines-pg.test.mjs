// 업무 > 자동화 1단계 — msgr_crew_routines·msgr_crew_routine_edits RLS·RPC 통합 테스트(실 Postgres).
// 순수 로직(해시 스킵·나중 수정 우선·채널 필터)은 test/msgr-crew-routines.test.mjs. 실행: npm run test:pg 또는
// scripts/billing-pg-drill.sh test/msgr-crew-routines-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const sqlRaw = (q) => psqlRaw(['-A', '-t', '-c', q]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };

let ORG, CREW, OTHER_CREW, CH;
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
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const migrationDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(migrationDir).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort()) {
    const source = readFileSync(mig(f), 'utf8');
    psql(['-c', source.replace(/^create extension if not exists pg_net;$/m, '')]);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const uid of [U.admin, U.member]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  OTHER_CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean', 'theirs', 'Theirs') returning id`));
  CH = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Work')`));
});

const rowsSql = `p_org=>'${ORG}',p_crew=>'${CREW}',p_rows=>'[{"ext_id":"r1","title":"아침 보고","prompt":"오늘 할 일 정리","schedule":{"type":"daily","time":"09:00"},"enabled":true}]'::jsonb`;

test('routines — 소유자 sync·읽기, 다른 조직원은 0행', { skip }, () => {
  assert.equal(last(asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`)) !== '', true);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_crew_routines where crew_id = '${CREW}'`)), '1');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_crew_routines where crew_id = '${CREW}'`)), '0', '조직원(비소유자)은 안 보인다');
  assert.equal(last(asUser(U.guest, `select count(*) from public.msgr_crew_routines where crew_id = '${CREW}'`)), '0', '다른 조직원도 안 보인다');
});

test('routines — 비소유자 sync는 42501, 남의 크루 지정 불가', { skip }, () => {
  fails(asUserRaw(U.member, `select public.msgr_crew_routines_sync(${rowsSql})`), /42501|msgr_routine_forbidden/, '남의 크루로 sync');
});

test('routines — 같은 내용으로 다시 sync하면 쓰기 0(xmin 불변)', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const before = last(asUser(U.owner, `select xmin::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const after = last(asUser(U.owner, `select xmin::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  assert.equal(after, before, '같은 값이면 행을 다시 쓰지 않는다');
});

test('routines — sync 스냅샷에서 빠진 ext_id는 삭제된다', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  asUser(U.owner, `select public.msgr_crew_routines_sync(p_org=>'${ORG}',p_crew=>'${CREW}',p_rows=>'[]'::jsonb)`);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_crew_routines where crew_id='${CREW}'`)), '0');
});

test('edits — 소유자만 편집 걸 수 있고, 이전 pending은 superseded로 접힌다', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  fails(asUserRaw(U.member, `select public.msgr_crew_routine_edit('${rid}','update','{"title":"침입"}'::jsonb)`), /42501|msgr_routine_forbidden/, '비소유자 편집 거절');
  const e1 = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','update','{"title":"1차"}'::jsonb))->>'id' as id) x`));
  const e2 = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','update','{"title":"2차"}'::jsonb))->>'id' as id) x`));
  assert.equal(last(asUser(U.owner, `select status from public.msgr_crew_routine_edits where id='${e1}'`)), 'superseded');
  assert.equal(last(asUser(U.owner, `select status from public.msgr_crew_routine_edits where id='${e2}'`)), 'pending');
  const pending = last(asUser(U.owner, `select edit_id::text from public.msgr_crew_routine_edits_pending('${ORG}')`));
  assert.equal(pending, e2, 'PC는 최신 편집만 가져온다');
  fails(asUserRaw(U.member, `select public.msgr_crew_routine_edit_done('${e2}','applied')`), /42501|msgr_routine_forbidden/, '비소유자 done 거절');
  asUser(U.owner, `select public.msgr_crew_routine_edit_done('${e2}','applied')`);
  assert.equal(last(asUser(U.owner, `select status from public.msgr_crew_routine_edits where id='${e2}'`)), 'applied');
});

test('edits — 다른 조직원은 edits 표도 0행', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  asUser(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"title":"1"}'::jsonb)`);
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_crew_routine_edits where routine_id='${rid}'`)), '0');
});

test('retention — 30일 지난 applied/superseded 편집은 정리 대상(직접 실행)', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  const eid = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','update','{"title":"x"}'::jsonb))->>'id' as id) x`));
  sql(`update public.msgr_crew_routine_edits set status='applied', applied_at=now()-interval '31 days' where id='${eid}'`);
  sql(`delete from public.msgr_crew_routine_edits where status in ('applied','superseded') and coalesce(applied_at,created_at) < now() - interval '30 days'`);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_crew_routine_edits where id='${eid}'`)), '0');
});
