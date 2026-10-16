// 메신저 일시 중단 마이그레이션 되돌림(scripts/rollback/*.down.sql) — 적용 → 되돌림 뒤 public 함수(서명·본문·권한·definer·설정)와 트리거가 적용 전과 같다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-service-pause-rollback-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-service-pause-rollback-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const file = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const psqlRaw = (args) => psqlSpawn(DB, ['-v', 'VERBOSITY=verbose', ...args]);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const OURS = ['20261016170000_msgr_service_pause.sql', '20261016171000_msgr_pause_push.sql'];
// public 함수 전체 — 서명·본문 해시·권한·definer·설정·휘발성·종류. 트리거 전체(내부 제외). "char"·bool·name 열은 모두 ::text로 — PG17은 text || "char"가 모호하다(42725, CI #1055)
const snapshot = () => ({
  procs: sql(`select p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '-') || '|' || p.provolatile::text || '|' || p.prokind::text
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`).split('\n'),
  triggers: sql(`select tgrelid::regclass::text || ':' || tgname::text || ':' || tgfoid::regprocedure::text || ':' || tgenabled::text from pg_trigger where not tgisinternal order by 1`).split('\n'),
});
let BASE, APPLIED;
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
  const all = [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort();
  for (const f of OURS) assert.ok(all.includes(f), f);
  for (const f of all.filter((x) => x < OURS[0])) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  BASE = snapshot();
  for (const f of OURS) psql(['-c', readFileSync(mig(f), 'utf8')]);
  APPLIED = snapshot();
});

test('적용하면 실제로 달라진다(비교가 헛돌지 않는다)', { skip }, () => {
  assert.notDeepEqual(APPLIED.procs, BASE.procs);
  assert.ok(APPLIED.triggers.filter((t) => t.includes(':a0_msgr_pause_guard:')).length >= 15, '트리거 15개 이상(있는 표마다)');
  assert.ok(APPLIED.procs.some((p) => p.startsWith('_msgr_crew_inbox_core(')), '감싸개 core가 생겼다');
});

test('되돌림(푸시 → 중단 순서) 뒤 함수·트리거가 적용 전과 같다 — 공지 푸시 기록 표는 남긴다', { skip }, () => {
  psql(['-c', file('scripts/rollback/20261016171000_msgr_pause_push.down.sql')]);
  psql(['-c', file('scripts/rollback/20261016170000_msgr_service_pause.down.sql')]);
  const after = snapshot();
  const diff = (a, b) => a.filter((x) => !b.includes(x));
  assert.deepEqual({ extra: diff(after.procs, BASE.procs), missing: diff(BASE.procs, after.procs) }, { extra: [], missing: [] }, '함수 서명·본문·권한·definer·설정·휘발성');
  assert.deepEqual(after.triggers, BASE.triggers, '트리거');
  assert.equal(sql(`select to_regclass('public.msgr_push_broadcasts') is not null`), 't', '발송 기록 표는 지우지 않는다');
});

test('되돌린 뒤 원래 함수가 그대로 돈다(받은 글·심박·봇 업데이트·디스패치) — 스위치 행이 남아 있어도 아무도 읽지 않는다', { skip }, () => {
  sql(`insert into public.msgr_settings (key, value) values ('msgr_paused', 'x') on conflict (key) do update set value = excluded.value`);
  const b = psqlRaw(['-A', '-t', '-c', `select count(*) from public.msgr_bot_updates('nope', 0, 10)`]);
  assert.notEqual(b.status, 0); assert.match(b.stderr, /msgr_bot_unauthorized/, '원래 함수(인증)');
  const d = psqlRaw(['-A', '-t', '-c', `select public.msgr_automation_dispatch_due('ws')`]);
  assert.notEqual(d.status, 0); assert.match(d.stderr, /msgr_automation_forbidden/, '원래 디스패치(로그인 없음 거절)');
  const s = psqlRaw(['-A', '-t', '-c', `select public.msgr_service_pause()`]);
  assert.notEqual(s.status, 0); assert.match(s.stderr, /does not exist/, '상태 함수는 없다');
  sql(`delete from public.msgr_settings where key = 'msgr_paused'`);
});
