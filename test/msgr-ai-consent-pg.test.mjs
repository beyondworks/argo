// App Store 5.1.2(2025-11 신설, 제3자 AI 공개·동의) — msgr_set_ai_consent/msgr_my_ai_consent/msgr_ai_consent_ok를
// 실제 배포될 마이그레이션 그대로 적용해 검증. 실행: bash scripts/billing-pg-drill.sh test/msgr-ai-consent-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-ai-consent-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);

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

test('기본값은 미동의 — 새 사용자는 msgr_profiles 행이 없어도 ai_consent_ok가 false다', { skip }, () => {
  assert.equal(sql(`select public.msgr_ai_consent_ok('${U.a}')`), 'f');
});

test('동의하면 시각이 찍히고, 본인은 msgr_my_ai_consent로 그 시각을 본다, 남은 msgr_ai_consent_ok로만 존재 여부를 본다', { skip }, () => {
  const before = Date.now();
  asUser(U.a, `select public.msgr_set_ai_consent(true)`);
  const at = asUser(U.a, `select public.msgr_my_ai_consent()`);
  assert.ok(Date.parse(at) >= before - 2000, '동의 시각이 방금 찍혔다');
  assert.equal(sql(`select public.msgr_ai_consent_ok('${U.a}')`), 't');
});

test('철회하면 다시 미동의로 — msgr_set_ai_consent(false)는 시각을 지운다(재동의 이력은 안 남긴다, 최신 상태만)', { skip }, () => {
  asUser(U.a, `select public.msgr_set_ai_consent(true)`);
  assert.equal(sql(`select public.msgr_ai_consent_ok('${U.a}')`), 't');
  const withdrawn = asUser(U.a, `select public.msgr_set_ai_consent(false)`);
  assert.equal(withdrawn.trim(), '', 'false로 철회하면 시각을 반환하지 않는다(null)');
  assert.equal(sql(`select public.msgr_ai_consent_ok('${U.a}')`), 'f');
  assert.equal(asUser(U.a, `select coalesce(public.msgr_my_ai_consent()::text, '(null)')`), '(null)');
});

test('동의는 계정별 — 내가 동의해도 남의 계정은 그대로 미동의', { skip }, () => {
  asUser(U.a, `select public.msgr_set_ai_consent(true)`);
  assert.equal(sql(`select public.msgr_ai_consent_ok('${U.a}')`), 't');
  assert.equal(sql(`select public.msgr_ai_consent_ok('${U.b}')`), 'f', '${U.b}는 동의한 적 없다');
});

test('로그인 안 한 세션은 동의를 남기지 못한다', { skip }, () => {
  const r = psqlRaw(['-A', '-t', '-c', `set role authenticated; select public.msgr_set_ai_consent(true)`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /msgr_auth_required/);
});

test('msgr_profiles는 RLS로 본인 행만 select — 게이트웨이가 남의 동의를 확인하려면 definer RPC(msgr_ai_consent_ok)가 꼭 필요하다', { skip }, () => {
  asUser(U.a, `select public.msgr_set_ai_consent(true)`);
  const r = asUserRaw(U.b, `select ai_consent_at from public.msgr_profiles where user_id = '${U.a}'`);
  assert.equal(r.status, 0, 'RLS는 빈 결과일 뿐 오류는 아니다');
  assert.equal(r.stdout.trim(), '', '직접 조회로는 남의 동의 시각을 못 본다');
});
