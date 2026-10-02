// 친구 숨김(20261002090000): 내 행만 읽고 쓰고, 같은 값은 다시 쓰지 않고, 사용자당 500행 상한. 친구 관계는 그대로.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-friend-hide-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-friend-hide-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const tryAs = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); assert.equal(last(asUser(y, `select public.msgr_friend_request('${x}')`)), 'friend'); };
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
  befriend(U.a, U.b); befriend(U.a, U.d);
});
const hiddenOf = (uid) => asUser(uid, 'select user_id from public.msgr_my_hidden_users()').split('\n').filter(Boolean);

test('본인은 친구를 숨기고 되돌린다 — 친구 관계는 그대로, 같은 값은 다시 쓰지 않는다', { skip }, () => {
  asUser(U.a, `select public.msgr_hide_user('${U.b}')`);
  assert.deepEqual(hiddenOf(U.a), [U.b]);
  const x1 = sql(`select xmin from public.msgr_user_hides where owner = '${U.a}' and hidden = '${U.b}'`);
  asUser(U.a, `select public.msgr_hide_user('${U.b}')`);
  assert.equal(sql(`select xmin from public.msgr_user_hides where owner = '${U.a}' and hidden = '${U.b}'`), x1, '이미 숨긴 친구를 또 숨겨도 행을 다시 쓰지 않는다');
  assert.ok(asUser(U.a, `select user_id||'|'||status from public.msgr_my_friends()`).includes(`${U.b}|accepted`), '숨겨도 친구 관계는 그대로');
  assert.ok(asUser(U.b, `select user_id||'|'||status from public.msgr_my_friends()`).includes(`${U.a}|accepted`), '상대 쪽 친구 목록도 그대로(상대는 모른다)');
  asUser(U.a, `select public.msgr_unhide_user('${U.b}')`);
  assert.deepEqual(hiddenOf(U.a), [], '다시 보이기 한 번으로 되돌린다');
});

test('남의 숨김은 읽지도 쓰지도 못한다 — 표 직접 접근·RPC 모두', { skip }, () => {
  asUser(U.a, `select public.msgr_hide_user('${U.b}')`);
  assert.deepEqual(hiddenOf(U.b), [], 'b의 목록에 a의 숨김은 없다');
  assert.equal(asUser(U.b, 'select count(*) from public.msgr_user_hides'), '0', 'RLS — b는 a의 행을 못 읽는다');
  assert.equal(asUser(U.c, 'select count(*) from public.msgr_user_hides'), '0');
  assert.notEqual(tryAs(U.b, `insert into public.msgr_user_hides (owner, hidden) values ('${U.a}', '${U.d}')`).status, 0, '직접 insert 불가(남의 행)');
  assert.notEqual(tryAs(U.a, `insert into public.msgr_user_hides (owner, hidden) values ('${U.a}', '${U.d}')`).status, 0, '본인도 직접 insert 불가 — RPC로만(상한·친구 확인)');
  assert.notEqual(tryAs(U.b, `delete from public.msgr_user_hides where owner = '${U.a}'`).status, 0, '직접 delete 불가');
  assert.notEqual(tryAs(U.b, `update public.msgr_user_hides set hidden = '${U.d}' where owner = '${U.a}'`).status, 0, '직접 update 불가');
  asUser(U.b, `select public.msgr_unhide_user('${U.b}')`); // b가 'b 숨김 해제'를 불러도 자기 행만 지운다
  assert.deepEqual(hiddenOf(U.a), [U.b], 'a의 숨김은 남아 있다');
  const r = tryAs(U.a, `select public.msgr_hide_user('${U.c}')`);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /msgr_not_friend/, '친구가 아니면 숨길 수 없다(임의 uuid 흔적 금지)');
  assert.match(tryAs(U.a, `select public.msgr_hide_user('${U.a}')`).stderr, /msgr_hide_invalid/, '자기 자신은 숨길 수 없다');
  assert.notEqual(psqlRaw(['-A', '-t', '-c', 'set role anon; select * from public.msgr_my_hidden_users()']).status, 0, 'anon 실행 불가');
  asUser(U.a, `select public.msgr_unhide_user('${U.b}')`);
});

test('사용자당 500행 상한 — 넘으면 msgr_hide_limit, 이미 숨긴 친구를 또 숨기는 것은 상한과 무관', { skip }, () => {
  sql(`insert into auth.users (id, email) select gen_random_uuid(), 'filler'||g||'@example.test' from generate_series(1, 499) g`);
  sql(`insert into public.msgr_user_hides (owner, hidden) select '${U.a}', id from auth.users where email like 'filler%'`);
  asUser(U.a, `select public.msgr_hide_user('${U.b}')`); // 500번째
  assert.equal(asUser(U.a, 'select count(*) from public.msgr_my_hidden_users()'), '500');
  asUser(U.a, `select public.msgr_hide_user('${U.b}')`); // 이미 숨김 — 그대로 통과
  const r = tryAs(U.a, `select public.msgr_hide_user('${U.d}')`);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /msgr_hide_limit/);
  sql(`delete from public.msgr_user_hides where owner = '${U.a}'`);
});
