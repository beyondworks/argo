// msgr_dm_latest — DM 채널당 마지막 메시지 1행(RLS로 내가 읽는 DM만, 삭제 글 제외, 보관 채널 제외). 실행: bash scripts/billing-pg-drill.sh test/msgr-dm-latest-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-dm-latest-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
let ORG, DM_AB, DM_AC, PUB;
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
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.b, U.c]) { const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`)); assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG); }
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Work')`));
  DM_AB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','dm','dm:b','[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
  DM_AC = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','dm','dm:c','[{"kind":"user","id":"${U.c}"}]'::jsonb)`));
});
const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));
const rows = (uid) => asUser(uid, `select channel_id||'|'||last_id from public.msgr_dm_latest('${ORG}') order by last_id`).split('\n').filter(Boolean);

test('DM 채널당 마지막 글 1행 — 공개 채널 제외, 삭제 글 건너뜀, 글 없는 DM은 행 없음, RLS로 남의 DM은 안 보인다', { skip }, () => {
  post(U.a, PUB, '잡담');
  assert.deepEqual(rows(U.a), [], '글 없는 DM은 행이 없다');
  const m1 = post(U.a, DM_AB, 'ab 1'); const m2 = post(U.b, DM_AB, 'ab 2'); const m3 = post(U.c, DM_AC, 'ac 1');
  assert.deepEqual(rows(U.a), [`${DM_AB}|${m2}`, `${DM_AC}|${m3}`], '채널당 최신 id 하나');
  assert.deepEqual(rows(U.b), [`${DM_AB}|${m2}`], 'b는 자기 DM만(RLS)');
  asUser(U.b, `update public.msgr_messages set deleted_at = now() where id = ${m2}`);
  assert.deepEqual(rows(U.a), [`${DM_AB}|${m1}`, `${DM_AC}|${m3}`], '삭제 글은 건너뛰고 그 전 글');
  sql(`update public.msgr_channels set archived_at = now() where id = '${DM_AC}'`);
  assert.deepEqual(rows(U.a), [`${DM_AB}|${m1}`], '보관한 DM은 빠진다');
  const anon = psqlRaw(['-A', '-t', '-c', `set role anon; select * from public.msgr_dm_latest('${ORG}')`]);
  assert.notEqual(anon.status, 0, 'anon 실행 불가');
});
