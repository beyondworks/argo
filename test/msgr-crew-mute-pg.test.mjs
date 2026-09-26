// 크루(AI 에이전트)·봇 숨기기(뮤트) — App Store 1.2 대응(2026-09-26). 저장은 기존 사람 차단 표(msgr_user_blocks)를
// blocked_crew 열로 확장(xor). 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-mute-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-mute-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, CREW;
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
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  CREW = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.a}', 'lean', 'mine', 'Mine') returning id`));
});

test('사람 차단(기존)과 크루 뮤트(신규)가 같은 표에 공존한다 — xor 제약, 사람 목록·크루 목록이 서로 섞이지 않는다', { skip }, () => {
  asUser(U.a, `select public.msgr_friend_remove('${U.b}', true)`); // 기존 사람 차단 경로 회귀 확인
  assert.equal(sql(`select count(*) from public.msgr_user_blocks where blocker='${U.a}' and blocked='${U.b}'`), '1');
  asUser(U.a, `select public.msgr_mute_crew('${CREW}')`);
  assert.equal(sql(`select count(*) from public.msgr_user_blocks where blocker='${U.a}' and blocked_crew='${CREW}'`), '1');
  const blocked = JSON.parse(`[${asUser(U.a, `select json_agg(row_to_json(t)) from (select user_id from public.msgr_my_blocked()) t`).trim() || 'null'}]`)[0] ?? [];
  assert.equal(blocked?.length ?? 0, 1, '사람 차단 목록에 크루가 섞이지 않는다');
  const muted = JSON.parse(`[${asUser(U.a, `select json_agg(row_to_json(t)) from (select crew_id from public.msgr_my_muted_crews()) t`).trim() || 'null'}]`)[0] ?? [];
  assert.equal(muted?.length ?? 0, 1, '크루 뮤트 목록에 사람이 섞이지 않는다');
});

test('표는 RPC 밖에서 직접 못 건드린다(권한 없음) — 사람·크루를 동시에 채우는 xor 위반은 그 아래 제약이 잡는다', { skip }, () => {
  const r = asUserRaw(U.a, `insert into public.msgr_user_blocks (blocker, blocked, blocked_crew) values ('${U.a}', '${U.b}', '${CREW}')`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /permission denied for table msgr_user_blocks/, '일반 사용자는 RPC로만 접근 — 직접 삽입은 권한 자체가 없다');
  const raw = psqlRaw(['-c', `insert into public.msgr_user_blocks (blocker, blocked, blocked_crew) values ('${U.a}', '${U.b}', '${CREW}')`]);
  assert.notEqual(raw.status, 0, '슈퍼유저로도 xor 제약은 통과 못 한다');
  assert.match(raw.stderr, /msgr_user_blocks_target_xor/);
});

test('뮤트 해제 후에는 목록에서 사라진다', { skip }, () => {
  asUser(U.a, `select public.msgr_mute_crew('${CREW}')`);
  assert.equal(sql(`select count(*) from public.msgr_user_blocks where blocker='${U.a}' and blocked_crew='${CREW}'`), '1');
  asUser(U.a, `select public.msgr_unmute_crew('${CREW}')`);
  assert.equal(sql(`select count(*) from public.msgr_user_blocks where blocker='${U.a}' and blocked_crew='${CREW}'`), '0');
});

test('없는 크루를 뮤트하면 거부된다(FK·존재 확인)', { skip }, () => {
  const r = asUserRaw(U.a, `select public.msgr_mute_crew('99999999-9999-4999-8999-999999999999')`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /msgr_crew_not_found/);
});

test('뮤트는 그 사용자만의 설정이다 — 다른 사용자의 뮤트 목록에는 안 보인다', { skip }, () => {
  asUser(U.a, `select public.msgr_mute_crew('${CREW}')`);
  const bMuted = JSON.parse(`[${asUser(U.b, `select json_agg(row_to_json(t)) from (select crew_id from public.msgr_my_muted_crews()) t`).trim() || 'null'}]`)[0] ?? [];
  assert.equal(bMuted?.length ?? 0, 0);
});
