// 친구 링크 — 링크 하나로 친구가 된다. 조직과는 무관하다(유건 2026-09-16).
// 실행: bash scripts/billing-pg-drill.sh test/msgr-friend-link-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-friend-link-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { me: '11111111-1111-4111-8111-111111111111', friend: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 160)}`); };
const myLink = (uid) => last(asUser(uid, `select code from public.msgr_friend_link_mine()`));
const friendState = (x, y) => sql(`select coalesce((select status from public.msgr_friends where a = least('${x}'::uuid,'${y}'::uuid) and b = greatest('${x}'::uuid,'${y}'::uuid)), '(없음)')`);

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
});

test('내 링크는 하나로 유지된다 — 다시 불러도 같은 코드', { skip }, () => {
  const a = myLink(U.me);
  assert.match(a, /^[0-9a-f]{48}$/, '조직 초대와 같은 48자 hex(붙여넣기 파서 공용)');
  assert.equal(myLink(U.me), a, '살아 있는 링크가 있으면 새로 만들지 않는다');
});

test('링크를 열면 그 자리에서 친구가 된다 — 요청 대기 없음', { skip }, () => {
  const code = myLink(U.me);
  assert.equal(friendState(U.me, U.friend), '(없음)');
  assert.equal(last(asUser(U.friend, `select public.msgr_friend_link_accept('${code}')`)), 'friend');
  assert.equal(friendState(U.me, U.friend), 'accepted', '양쪽 동의가 모였으니 바로 친구');
  assert.equal(last(asUser(U.friend, `select public.msgr_friend_link_accept('${code}')`)), 'already', '두 번 열어도 그대로');
  assert.equal(last(asUser(U.me, `select public.msgr_friend_link_accept('${code}')`)), 'self', '내 링크를 내가 열면 아무 일도 없다');
});

test('링크로는 조직에 들어오지 않는다 — 개인과 조직은 다른 문', { skip }, () => {
  const org = last(asUser(U.me, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.me}') returning id`));
  const code = myLink(U.me);
  asUser(U.other, `select public.msgr_friend_link_accept('${code}')`);
  assert.equal(sql(`select count(*) from public.msgr_org_members where org_id = '${org}' and user_id = '${U.other}'`), '0', '조직 멤버가 되지 않는다');
  assert.equal(friendState(U.me, U.other), 'accepted', '친구만 된다');
});

test('만료·회수된 링크는 열리지 않는다', { skip }, () => {
  const code = myLink(U.me);
  asUser(U.me, `select public.msgr_friend_link_revoke()`);
  fails(asUserRaw(U.friend, `select public.msgr_friend_link_accept('${code}')`), /msgr_link_invalid/, '회수된 링크');
  const fresh = myLink(U.me);
  assert.notEqual(fresh, code, '회수 뒤에는 새 코드가 나온다');
  sql(`update public.msgr_friend_links set expires_at = now() - interval '1 day' where code = '${fresh}'`);
  fails(asUserRaw(U.friend, `select public.msgr_friend_link_accept('${fresh}')`), /msgr_link_invalid/, '만료된 링크');
  fails(asUserRaw(U.friend, `select public.msgr_friend_link_accept('${'0'.repeat(48)}')`), /msgr_link_invalid/, '없는 코드');
});

test('차단한 상대는 링크로도 못 들어온다', { skip }, () => {
  asUser(U.me, `select public.msgr_friend_remove('${U.friend}', true)`); // 차단
  const code = myLink(U.me);
  fails(asUserRaw(U.friend, `select public.msgr_friend_link_accept('${code}')`), /msgr_friend_blocked/, '차단 상태');
  sql(`delete from public.msgr_friends where status = 'blocked'`);
});

test('링크 표는 RPC로만 — 남의 링크를 읽거나 만들 수 없다', { skip }, () => {
  fails(asUserRaw(U.other, `select code from public.msgr_friend_links`), /permission denied/, '표 직접 열람');
  fails(asUserRaw(U.other, `insert into public.msgr_friend_links (owner_user_id) values ('${U.me}')`), /permission denied|row-level security/, '남의 링크 발급');
});
