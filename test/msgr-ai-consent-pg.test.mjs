// App Store 5.1.2 재설계(2026-09-27, 유건 결정 "처음 한 번 필수 동의") — msgr_ai_consent 표·RPC를 실제 배포될
// 마이그레이션 그대로 적용해 검증. 실행: bash scripts/billing-pg-drill.sh test/msgr-ai-consent-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-ai-consent-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG;
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
});

test('기본값은 미동의 — 새 사용자는 행이 없어도 org 단위 확인이 false다', { skip }, () => {
  const crew = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.a}', 'lean', 'mine', 'Mine') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${ORG}', '${U.c}', 'member', 'c') on conflict do nothing`);
  assert.equal(asUser(U.a, `select public.msgr_org_ai_consent_ok('${ORG}', '${U.c}')`), 'f');
});

test('동의하면 본인은 msgr_my_ai_consent로 시각을 본다, 남은 msgr_org_ai_consent_ok로만 존재 여부를 본다(같은 조직·본인 소유 활성 크루가 있을 때만)', { skip }, () => {
  const before = Date.now();
  asUser(U.a, `select public.msgr_set_ai_consent(true)`);
  const at = asUser(U.a, `select public.msgr_my_ai_consent()`);
  assert.ok(Date.parse(at) >= before - 2000, '동의 시각이 방금 찍혔다');
});

test('철회하면 다시 미동의로 — false는 시각을 지운다(최신 상태만, 이력 없음)', { skip }, () => {
  asUser(U.a, `select public.msgr_set_ai_consent(true)`);
  const withdrawn = asUser(U.a, `select public.msgr_set_ai_consent(false)`);
  assert.equal(withdrawn.trim(), '', 'false로 철회하면 시각을 반환하지 않는다(null)');
  assert.equal(asUser(U.a, `select coalesce(public.msgr_my_ai_consent()::text, '(null)')`), '(null)');
});

test('로그인 안 한 세션은 동의를 남기지 못한다', { skip }, () => {
  const r = psqlRaw(['-A', '-t', '-c', `set role authenticated; select public.msgr_set_ai_consent(true)`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /msgr_auth_required/);
});

test('검수 L3: msgr_ai_consent 표는 RLS로 전면 차단 — RPC를 거치지 않은 직접 select/insert는 본인도 못 한다', { skip }, () => {
  asUser(U.a, `select public.msgr_set_ai_consent(true)`);
  const r1 = asUserRaw(U.a, `select consent_at from public.msgr_ai_consent where user_id = '${U.a}'`);
  assert.notEqual(r1.status, 0, '본인 행도 직접 select 불가(RPC로만)');
  const r2 = asUserRaw(U.a, `insert into public.msgr_ai_consent (user_id, consent_at) values ('${U.a}', now())`);
  assert.notEqual(r2.status, 0, '직접 upsert 불가 — RPC(msgr_set_ai_consent)로만');
});

test('검수 L2: 친구여도 남의 동의 시각을 직접 조회할 수 없다(친구 읽기 정책이 없는 별도 표)', { skip }, () => {
  asUser(U.a, `select public.msgr_set_ai_consent(true)`);
  sql(`insert into public.msgr_friends (a, b, status, requested_by) values (least('${U.a}'::uuid,'${U.b}'::uuid), greatest('${U.a}'::uuid,'${U.b}'::uuid), 'accepted', '${U.a}') on conflict do nothing`);
  const r = asUserRaw(U.b, `select consent_at from public.msgr_ai_consent where user_id = '${U.a}'`);
  assert.notEqual(r.status, 0, '친구 사이 프로필 읽기 정책이 있는 msgr_profiles와 달리 이 표는 아예 못 읽는다');
});

test('검수 L4: msgr_ai_consent_ok는 authenticated에게 실행 권한이 없다(service_role 전용) — 아무나 남의 동의 여부를 못 묻는다', { skip }, () => {
  const r = asUserRaw(U.a, `select public.msgr_ai_consent_ok('${U.b}')`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /permission denied for function msgr_ai_consent_ok/);
});

test('검수 L4: msgr_org_ai_consent_ok는 같은 조직에 활성 크루를 둔 사람만, 대상도 그 조직 멤버여야 물을 수 있다', { skip }, () => {
  const crew = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.a}', 'lean', 'ask', 'Ask') returning id`));
  asUser(U.b, `select public.msgr_set_ai_consent(true)`);
  // U.b는 크루가 없는 남 — 이 조직에 크루가 없으니 U.a의 동의를 못 묻는다
  assert.equal(asUser(U.b, `select public.msgr_org_ai_consent_ok('${ORG}', '${U.a}')`), 'f');
  // U.a는 이 조직에 활성 크루가 있지만 U.b는 이 조직 멤버가 아니다 — 여전히 false
  assert.equal(asUser(U.a, `select public.msgr_org_ai_consent_ok('${ORG}', '${U.b}')`), 'f');
  // U.b가 조직 멤버가 되고 동의하면 그제야 true
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${ORG}', '${U.b}', 'member', 'b') on conflict do nothing`);
  assert.equal(asUser(U.a, `select public.msgr_org_ai_consent_ok('${ORG}', '${U.b}')`), 't');
});

test('검수 L5: 내 크루는 숨길 수 없다 — msgr_mute_crew가 자기 소유 크루면 거절한다', { skip }, () => {
  const own = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.a}', 'lean', 'own', 'Own') returning id`));
  const r = asUserRaw(U.a, `select public.msgr_mute_crew('${own}')`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /msgr_crew_mute_own/);
});

test('검수 L4: 내가 속하지 않은 조직·대화에 없는 크루는 숨길 수 없다', { skip }, () => {
  const other = last(asUser(U.b, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.b}') returning id`));
  const foreign = last(asUser(U.b, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${other}', '${U.b}', 'lean', 'foreign', 'Foreign') returning id`));
  const r = asUserRaw(U.a, `select public.msgr_mute_crew('${foreign}')`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /msgr_crew_not_visible/);
});

test('검수 L4: 같은 조직 멤버면(채널 공유 없이도) 숨길 수 있다', { skip }, () => {
  const crew = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.a}', 'lean', 'visible', 'Visible') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${ORG}', '${U.b}', 'member', 'b') on conflict do nothing`);
  const r = asUserRaw(U.b, `select public.msgr_mute_crew('${crew}')`);
  assert.equal(r.status, 0, r.stderr);
});
