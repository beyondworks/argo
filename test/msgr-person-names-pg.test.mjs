// 사람 이름 한 규칙(20261001110000) — 프로필 이름(공백 제외) → 이메일 앞부분. 유건 제보(2026-10-01) '배너 알림에 친구 이름이 ?'의 같은 계열:
// 프로필 행이 없는 사람은 데스크톱 다른 공간 알림·맥 네이티브 알림·개인 그룹방 구성원 이름이 '?'·id 앞 8자리로 보였다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-person-names-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-person-names-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555', x: '66666666-6666-4666-8666-666666666666' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));
const postRaw = (uid, ch, body) => asUserRaw(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`);

let GROUP;
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
  // a: 프로필 없음(jaewan@), b: 프로필 이름 '비', c: 프로필 이름 공백, e: a의 친구 아님·b의 친구(그룹방 구성원), d: 아무 관계 없음, x: 차단한 사이
  sql(`update auth.users set email = 'jaewan.kim@example.test' where id = '${U.a}'`);
  sql(`insert into public.msgr_profiles (user_id, display_name) values ('${U.b}', '비'), ('${U.c}', '   ') on conflict (user_id) do update set display_name = excluded.display_name`);
  const friend = (p, q, status = 'accepted') => sql(`insert into public.msgr_friends (a, b, status, requested_by) values (least('${p}'::uuid, '${q}'::uuid), greatest('${p}'::uuid, '${q}'::uuid), '${status}', '${p}') on conflict (a, b) do update set status = excluded.status`);
  friend(U.a, U.b); friend(U.a, U.c); friend(U.b, U.e); friend(U.a, U.x, 'blocked');
  GROUP = last(asUser(U.b, `select public.msgr_dm_personal_group(array['${U.a}','${U.e}']::uuid[], null)`));
});
const names = (uid, ids) => Object.fromEntries(asUser(uid, `select user_id || '|' || coalesce(name, '∅') from public.msgr_people_names(array[${ids.map((i) => `'${i}'`).join(',')}]::uuid[])`).split('\n').filter(Boolean).map((l) => l.split('|')));

test('내부 이름 함수는 로그인 사용자가 직접 부를 수 없다(이메일 조회 통로가 되지 않게)', { skip }, () => {
  fails(asUserRaw(U.a, `select public.msgr_person_label('${U.d}')`), /permission denied/, 'msgr_person_label 직접 호출');
});

test('이름 규칙 — 프로필 이름 → (없거나 공백이면) 이메일 앞부분', { skip }, () => {
  const n = names(U.a, [U.a, U.b, U.c]);
  assert.equal(n[U.a], 'jaewan.kim', '나 자신 — 프로필 행이 없으면 이메일 앞부분');
  assert.equal(n[U.b], '비', '프로필 이름이 먼저');
  assert.equal(n[U.c], 'c', '공백 프로필 이름은 빈 값으로 보고 이메일 앞부분');
});

test('보이는 범위 — 나·친구·같은 방 사람만. 모르는 사람·차단한 사이는 빠진다', { skip }, () => {
  const n = names(U.a, [U.b, U.e, U.d, U.x]);
  assert.equal(n[U.b], '비', '친구');
  assert.equal(n[U.e], 'e', '친구는 아니지만 같은 그룹방 구성원');
  assert.equal(n[U.d], undefined, '아무 관계 없는 사람은 돌려주지 않는다');
  assert.equal(n[U.x], undefined, '차단한 사이(같은 방도 없음)는 돌려주지 않는다');
  assert.deepEqual(names(U.d, [U.a]), {}, '반대 방향도 — 모르는 사람은 내 이름을 못 본다');
});

test('개인 방 목록 — 구성원 이름이 프로필이 없어도 채워진다(친구 아닌 구성원이 id 앞 8자리로 보이던 결함)', { skip }, () => {
  const members = JSON.parse(last(asUser(U.e, `select members from public.msgr_dm_personal_list(true) where channel_id = '${GROUP}'`)));
  const byId = Object.fromEntries(members.map((m) => [m.id, m.name]));
  assert.equal(byId[U.a], 'jaewan.kim', 'e가 보는 a(친구 아님·프로필 없음)의 이름');
  assert.equal(byId[U.b], '비');
  assert.equal(byId[U.e], 'e');
});

test('한 번에 최대 200명 — 큰 배열도 오류 없이 앞 200개만 본다', { skip }, () => {
  const many = Array.from({ length: 250 }, (_, i) => `'00000000-0000-4000-8000-${String(i).padStart(12, '0')}'`).join(',');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_people_names(array[${many}, '${U.b}']::uuid[])`), '0', '201번째 이후(b)는 보지 않는다');
});
