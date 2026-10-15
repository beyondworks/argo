// 메신저를 쓴 계정에는 프로필 행이 있다(앱↔메신저 연결 감사 D2 — 20261015110000_msgr_profile_from_presence). 실행: bash scripts/billing-pg-drill.sh test/msgr-profile-from-presence-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-profile-from-presence-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
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


const U = { x: '11111111-1111-4111-8111-111111111111', y: '22222222-2222-4222-8222-222222222222', z: '33333333-3333-4333-8333-333333333333', w: '44444444-4444-4444-8444-444444444444' };
// x = 메신저를 처음 연 사용자(행 없음), y = 이미 프로필을 저장한 사용자, z = 적용 전에 메신저를 쓴 사용자(채우기 대상), w = 검색하는 사람
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
});

const MIG = '20261015110000_msgr_profile_from_presence.sql';
const prof = (uid) => sql(`select coalesce(handle,'-')||'|'||coalesce(display_name,'-')||'|'||email_search||'|'||handle_search||'|'||accept_requests from public.msgr_profiles where user_id = '${uid}'`);
const xmin = (uid) => sql(`select xmin from public.msgr_profiles where user_id = '${uid}'`);
const ping = (uid) => asUser(uid, `select public.msgr_presence_ping('desktop')`);

test('메신저를 처음 열면(presence 첫 행) 빈 프로필 행이 생긴다 — 본체 자동 켜기·설정 카드의 "메신저에 로그인한 적 있음" 판정이 참이 된다', { skip }, () => {
  assert.equal(sql(`select count(*) from public.msgr_profiles where user_id = '${U.x}'`), '0', '전제: 메신저 로그인만 한 사용자는 행이 없다(D2)');
  ping(U.x);
  assert.equal(prof(U.x), '-|-|true|true|true', '빈 행: 아이디·이름 없음, 기본값(이메일 검색·아이디 검색·친구 요청 허용)');
  assert.equal(last(asUser(U.x, `select count(*) from public.msgr_profiles where user_id = '${U.x}'`)), '1', '본인이 자기 행을 읽는다(본체 hasMsgrProfile은 본인 세션으로 읽는다)');
});

test('심박이 이어져도 프로필 행을 다시 쓰지 않는다 — 사용자당 평생 쓰기 1번(주기 쓰기 0)', { skip }, () => {
  const before = xmin(U.x);
  ping(U.x); ping(U.x);
  assert.equal(xmin(U.x), before, '두 번째부터는 presence on conflict do update — AFTER INSERT가 돌지 않는다');
});

test('이미 저장한 프로필은 건드리지 않는다', { skip }, () => {
  asUser(U.y, `insert into public.msgr_profiles (user_id, handle, display_name, email_search, accept_requests) values ('${U.y}', 'yname', '와이', false, false)`);
  const before = xmin(U.y);
  ping(U.y);
  assert.equal(prof(U.y), 'yname|와이|false|true|false', '값 그대로');
  assert.equal(xmin(U.y), before, '쓰기 없음(on conflict do nothing)');
});

test('적용 전에 메신저를 쓴 사용자는 한 번 채운다 — 다시 적용해도 있는 행은 그대로', { skip }, () => {
  sql(`alter table public.msgr_presence disable trigger msgr_presence_profile; insert into public.msgr_presence (user_id, source, seen_at) values ('${U.z}', 'mobile', now() - interval '3 days'); alter table public.msgr_presence enable trigger msgr_presence_profile;`);
  assert.equal(sql(`select count(*) from public.msgr_profiles where user_id = '${U.z}'`), '0', '전제: 트리거 전 사용자');
  const xs = { x: xmin(U.x), y: xmin(U.y) };
  psql(['-c', readFileSync(mig(MIG), 'utf8')]);
  assert.equal(prof(U.z), '-|-|true|true|true', '채움');
  assert.equal(xmin(U.x), xs.x, '이미 있는 행은 다시 쓰지 않는다');
  assert.equal(xmin(U.y), xs.y);
  assert.equal(prof(U.y), 'yname|와이|false|true|false');
});

test('빈 행은 행 없음과 동작이 같다 — 이메일로 찾을 수 있고, 친구 요청을 받는다', { skip }, () => {
  const found = last(asUser(U.w, `select count(*) from public.msgr_find_user('x@example.test')`));
  assert.equal(found, '1', '이메일 검색: coalesce(email_search, true)와 같은 결과');
  const r = asUserRaw(U.w, `select public.msgr_friend_request('${U.x}')`);
  assert.equal(r.status, 0, `친구 요청 허용 — ${r.stderr.trim().slice(0, 160)}`);
  assert.equal(last(asUser(U.w, `select count(*) from public.msgr_find_user('y@example.test')`)), '0', '저장한 설정(email_search false)은 그대로 지켜진다');
});

test('다른 계정의 메신저 사용은 이 계정을 연결하지 않는다 — 행은 심박을 보낸 본인 것만', { skip }, () => {
  ping(U.w);
  assert.equal(sql(`select count(*) from public.msgr_profiles where user_id = '${U.w}'`), '1', '본인(w) 행만 생김');
  assert.equal(sql(`select count(*) from public.msgr_profiles where user_id not in ('${U.x}','${U.y}','${U.z}','${U.w}')`), '0', '심박하지 않은 계정에는 행이 생기지 않는다');
});
