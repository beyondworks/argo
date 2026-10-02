// msgr_channel_latest — 폰 채널 탭 줄 재료(20261001170000): 내가 참여한 채널마다 마지막 글·참여 인원. 실행: bash scripts/billing-pg-drill.sh test/msgr-channel-latest-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-channel-latest-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
let ORG, DM_AB, DM_AC, PUB, PRIV;
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
  PRIV = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','private','Secret','[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
  DM_AB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','dm','dm:b','[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
  DM_AC = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','dm','dm:c','[{"kind":"user","id":"${U.c}"}]'::jsonb)`));
});
const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));
const rows = (uid) => asUser(uid, `select channel_id||'|'||coalesce(last_id::text,'-')||'|'||members from public.msgr_channel_latest('${ORG}') order by channel_id`).split('\n').filter(Boolean);
const sorted = (xs) => [...xs].sort();

test('내가 참여한 채널만 한 행씩 — 마지막 글·참여 인원, 1:1 대화 제외, 삭제 글 건너뜀, 보관 채널 제외, anon 불가', { skip }, () => {
  // 공개 채널은 만든 사람도 참여 행이 없다(서버는 kind<>'public'만 넣는다) — 참여해야 목록에 뜬다(#555)
  asUser(U.a, `select public.msgr_join_channel('${PUB}')`);
  assert.deepEqual(sorted(rows(U.a)), sorted([`${PUB}|-|1`, `${PRIV}|-|2`]), '글이 없어도 행은 있다(시각 없음) — DM은 빠진다');
  assert.deepEqual(rows(U.c), [], 'c는 어느 채널에도 참여하지 않았다');
  asUser(U.c, `select public.msgr_join_channel('${PUB}')`);
  const p1 = post(U.a, PUB, '공지'); const p2 = post(U.c, PUB, '확인'); const s1 = post(U.b, PRIV, '비밀'); post(U.a, DM_AB, 'dm 글');
  assert.deepEqual(sorted(rows(U.a)), sorted([`${PUB}|${p2}|2`, `${PRIV}|${s1}|2`]), '채널당 최신 글 하나, 인원 = 참여한 사람');
  assert.deepEqual(rows(U.c), [`${PUB}|${p2}|2`], 'c는 비공개 채널을 못 본다(RLS)');
  asUser(U.c, `update public.msgr_messages set deleted_at = now() where id = ${p2}`);
  assert.deepEqual(rows(U.c), [`${PUB}|${p1}|2`], '삭제 글은 건너뛰고 그 전 글');
  sql(`update public.msgr_channels set archived_at = now() where id = '${PRIV}'`);
  assert.deepEqual(rows(U.a), [`${PUB}|${p1}|2`], '보관한 채널은 빠진다');
  const anon = psqlRaw(['-A', '-t', '-c', `set role anon; select * from public.msgr_channel_latest('${ORG}')`]);
  assert.notEqual(anon.status, 0, 'anon 실행 불가');
});
