// 실 Postgres 회귀 — '직접 배치' 순서 열(sort_pos) 마이그레이션(20260929100000_msgr_prefs_sort_pos.sql) 검증.
// msgr_channel_prefs(DM 탭)·msgr_target_prefs(내 에이전트) 둘 다: 본인 행만 쓰고 보되(기존 RLS 그대로),
// msgr_target_prefs는 pinned default true라 sort_pos만 보내면 즐겨찾기로 잘못 켜질 위험(#8) — 그 값이 실제로 지켜지는지도 확인.
// 실행: `npm run test:pg` (scripts/billing-pg-drill.sh — 파일마다 별도 임시 DB) 또는 이 파일만 psqlSpawn 하네스로.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  owner: '11111111-1111-4111-8111-111111111111', member: '33333333-3333-4333-8333-333333333333',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, DM, CREW;
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
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql',
    '20260903120000_msgr.sql', '20260907120000_msgr_crew_inventory.sql', '20260908120000_msgr_bots.sql', '20260908140000_msgr_crew_autodispatch.sql',
    '20260909000000_msgr_bot_external_id.sql', '20260909001000_msgr_crew_folder.sql', '20260909002000_msgr_profiles_friends.sql', '20260909003000_msgr_message_meta.sql',
    '20260909004000_msgr_p0_reads_reactions_prefs.sql', '20260909005000_msgr_avatars.sql', '20260909120000_msgr_execution_claims.sql', '20260909230000_msgr_bot_execution.sql',
    '20260911150000_msgr_channel_manage.sql', '20260911230000_msgr_channel_scope_enforce.sql', '20260912135036_msgr_target_favorites_dm_leave.sql',
    '20260912180000_msgr_pinned_and_push_mute.sql', '20260912200000_msgr_prefs_pin_pos_folder.sql',
    '20260929100000_msgr_prefs_sort_pos.sql', // 이 작업의 마이그레이션
  ]) psql(['-f', mig(f)]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
  assert.equal(last(asUser(U.member, `select public.msgr_accept_invite('${code}')`)), ORG);
  DM = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'dm', 'test', '[{"kind":"user","id":"${U.member}"}]'::jsonb)`));
  CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean', 'mine', 'Mine') returning id`));
});

test('마이그레이션 — 두 테이블 다 sort_pos 열이 있다', { skip }, () => {
  assert.equal(sql(`select count(*) from information_schema.columns where table_schema='public' and table_name='msgr_channel_prefs' and column_name='sort_pos'`), '1');
  assert.equal(sql(`select count(*) from information_schema.columns where table_schema='public' and table_name='msgr_target_prefs' and column_name='sort_pos'`), '1');
});

test('msgr_channel_prefs.sort_pos — 본인 행만 쓰고 본다(기존 RLS 그대로), 남의 행은 0건', { skip }, () => {
  asUser(U.owner, `insert into public.msgr_channel_prefs (channel_id, user_id, sort_pos) values ('${DM}', '${U.owner}', 2) on conflict (channel_id, user_id) do update set sort_pos = excluded.sort_pos`);
  assert.equal(last(asUser(U.owner, `select sort_pos from public.msgr_channel_prefs where channel_id = '${DM}' and user_id = '${U.owner}'`)), '2');
  // 남이 쓴 행은 안 보인다(select 0건) — 본인 것만 저장한 게 다른 사람 화면 순서에 안 새는지
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_channel_prefs where channel_id = '${DM}' and user_id = '${U.owner}'`)), '0');
  // 남의 행을 직접 update해도 0행(RLS가 조용히 막는다 — update 자체는 에러 없이 영향 0행)
  assert.equal(last(asUser(U.member, `with u as (update public.msgr_channel_prefs set sort_pos = 99 where channel_id = '${DM}' and user_id = '${U.owner}' returning 1) select count(*) from u`)), '0');
  assert.equal(sql(`select sort_pos from public.msgr_channel_prefs where channel_id = '${DM}' and user_id = '${U.owner}'`), '2', '남의 update가 실제로는 안 먹었다');
});

test('msgr_target_prefs.sort_pos — pinned을 명시하지 않으면 default true라 즐겨찾기로 잘못 켜진다(#8 위험 실증), 명시하면 안전', { skip }, () => {
  // 위험을 그대로 보여준다: sort_pos만 넣은 새 행은 pinned=true로 들어간다(테이블 기본값)
  asUser(U.member, `insert into public.msgr_target_prefs (user_id, org_id, target_kind, target_id, sort_pos) values ('${U.member}', '${ORG}', 'crew', '${CREW}', 0)`);
  assert.equal(last(asUser(U.member, `select pinned from public.msgr_target_prefs where target_id = '${CREW}'`)), 't', '#8에서 경고한 그대로 — sort_pos만 보내면 즐겨찾기로 잘못 켜진다');
  asUser(U.member, `delete from public.msgr_target_prefs where target_id = '${CREW}'`);
  // App.jsx가 실제로 하는 방식(pinned 명시) — 즐겨찾기 상태가 그대로 유지된다
  asUser(U.member, `insert into public.msgr_target_prefs (user_id, org_id, target_kind, target_id, sort_pos, pinned) values ('${U.member}', '${ORG}', 'crew', '${CREW}', 0, false)`);
  assert.equal(last(asUser(U.member, `select pinned::text || '|' || sort_pos::text from public.msgr_target_prefs where target_id = '${CREW}'`)), 'false|0', 'pinned=false 유지, sort_pos=0 저장');
});

test('msgr_target_prefs — 남의 행은 못 보고 못 바꾼다(RLS 그대로 — USING이 걸러 0행, 에러 아님)', { skip }, () => {
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_target_prefs where target_id = '${CREW}'`)), '0', 'owner 눈엔 0건(RLS select)');
  assert.equal(last(asUser(U.owner, `with u as (update public.msgr_target_prefs set sort_pos = 5 where target_id = '${CREW}' returning 1) select count(*) from u`)), '0', 'owner의 update는 0행(RLS가 대상을 안 보여준다)');
  assert.equal(sql(`select sort_pos from public.msgr_target_prefs where target_id = '${CREW}'`), '0', '실제 값은 그대로 — owner의 update가 안 먹었다');
});
