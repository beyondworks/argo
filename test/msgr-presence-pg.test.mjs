// PC를 보고 있는 동안에는 폰 푸시 수신자에서 빠진다(유건 2026-09-16 "양쪽으로 알림 오니까 정신 없다").
// 실행: bash scripts/billing-pg-drill.sh test/msgr-presence-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-presence-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 160)}`); };

let ORG, PUB;
const recipients = (mid) => sql(`select string_agg(left(u::text, 8), ',' order by u::text) from public.msgr_push_recipients((select m from public.msgr_messages m where m.id = ${mid})) u`).trim();
const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));

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
  for (const u of [U.b, U.c]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Work')`));
  // 공개 채널 알림은 이제 **참여자**에게만 간다(20260916190000_msgr_channel_join) — 심박 판정을 보려면 둘을 들여보낸다.
  for (const u of [U.b, U.c]) assert.equal(last(asUser(u, `select public.msgr_join_channel('${PUB}')`)), 't');
});

test('심박이 없으면 종전대로 — 작성자를 뺀 채널 참여자 전원이 푸시 대상', { skip }, () => {
  const m = post(U.a, PUB, '안녕');
  assert.equal(recipients(m), [U.b, U.c].map((x) => x.slice(0, 8)).sort().join(','), '참여한 b·c가 받는다');
});

test('PC를 보고 있는 사람은 폰 푸시에서 빠진다(같은 알림이 양쪽으로 오지 않게)', { skip }, () => {
  asUser(U.b, `select public.msgr_presence_ping('desktop')`);
  const m = post(U.a, PUB, '지금 PC 보는 중');
  assert.equal(recipients(m), U.c.slice(0, 8), 'PC 앞인 b는 빠지고 c만 남는다');
  assert.equal(asUser(U.b, `select public.msgr_on_desktop('${U.b}')`), 't');
});

test('폰을 보고 있으면 폰 알림은 그대로 간다 — 억제는 PC에만 해당', { skip }, () => {
  asUser(U.c, `select public.msgr_presence_ping('mobile')`);
  const m = post(U.a, PUB, '폰 보는 중');
  assert.equal(recipients(m), U.c.slice(0, 8), '폰 심박은 억제 근거가 아니다');
});

test('자리를 뜨면 되살아난다 — 심박이 낡으면 다시 폰으로 간다', { skip }, () => {
  sql(`update public.msgr_presence set seen_at = now() - interval '5 minutes' where user_id = '${U.b}'`);
  const m = post(U.a, PUB, '자리 비움');
  assert.ok(recipients(m).includes(U.b.slice(0, 8)), 'b가 다시 받는다');
});

test('심박 표는 RPC로만 — 사용자가 직접 읽거나 쓰지 못한다(누가 어디서 보는지는 민감하다)', { skip }, () => {
  fails(asUserRaw(U.b, `insert into public.msgr_presence (user_id, source) values ('${U.c}', 'desktop')`), /permission denied|row-level security/, '남의 심박 위조');
  fails(asUserRaw(U.b, `select count(*) from public.msgr_presence`), /permission denied/, '표 직접 열람');
  fails(asUserRaw(U.b, `select public.msgr_presence_ping('watch')`), /msgr_bad_source/, '없는 기기 종류');
  asUser(U.b, `select public.msgr_presence_ping('desktop')`); // 정상 경로는 열려 있다
  assert.equal(sql(`select source from public.msgr_presence where user_id = '${U.b}'`), 'desktop');
});
