// 긴급(2026-09-16): 크루 하트비트(last_seen_at 갱신)마다 큰 commands 열이 TOAST에 다시 쓰였다.
// 잠금 트리거가 매 갱신마다 행 전체를 JSON으로 풀어 읽은 탓 — 라이브 msgr_crews 166행이 817MB.
// 한 테스트 안에서 핫픽스 전후를 잰다: 전에는 TOAST가 자라고, 후에는 자라지 않으며, 잠금 열 변경은 여전히 막힌다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-crews-toast-churn-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crews-toast-churn-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const HOTFIX = '20260916204000_msgr_crews_lock_when.sql';
const U = { owner: '11111111-1111-4111-8111-111111111111' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const toastBytes = () => Number(sql(`select pg_total_relation_size(reltoastrelid) from pg_class where oid = 'public.msgr_crews'::regclass`));
let ORG, CREW;
const heartbeat = (n, uid) => { for (let i = 0; i < n; i++) (uid ? asUser(uid, `update public.msgr_crews set last_seen_at = now() where id = '${CREW}'`) : sql(`update public.msgr_crews set last_seen_at = now() where id = '${CREW}'`)); };

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
  // 핫픽스는 빼고 먼저 올린다 — 테스트 안에서 전후를 재기 위해
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x) && x !== HOTFIX).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  sql(`insert into auth.users (id, created_at, email) values ('${U.owner}', now() - interval '30 days', 'owner@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  // 압축되지 않는 약 6.5KB commands(라이브 상한과 같은 크기)
  sql(`update public.msgr_crews set commands = (select jsonb_agg(jsonb_build_object('name', 'cmd' || g, 'description', md5(random()::text) || md5(random()::text) || md5(random()::text))) from generate_series(1, 60) g) where id = '${CREW}'`);
  sql(`alter table public.msgr_crews set (autovacuum_enabled = false, toast.autovacuum_enabled = false)`); // 재는 동안 회수가 끼어들지 않게
});

test('하트비트가 큰 열을 다시 쓰지 않는다 — 핫픽스 전에는 자라고 후에는 그대로, 잠금은 여전히 막힌다', { skip }, () => {
  assert.ok(Number(sql(`select pg_column_size(commands) from public.msgr_crews where id = '${CREW}'`)) > 4000, 'commands가 TOAST로 나갈 만큼 크다');
  const t0 = toastBytes(); heartbeat(20, U.owner); const t1 = toastBytes();
  assert.ok(t1 - t0 > 60_000, `핫픽스 전: 앱 하트비트 20번에 TOAST가 자란다(재현) — ${t0} → ${t1}`);

  psql(['-c', readFileSync(mig(HOTFIX), 'utf8')]);
  const t2 = toastBytes(); heartbeat(20, U.owner); heartbeat(20, null); const t3 = toastBytes();
  assert.equal(t3, t2, `핫픽스 후: 사용자·서비스 하트비트 40번에도 TOAST가 그대로 — ${t2} → ${t3}`);

  const r = asUserRaw(U.owner, `update public.msgr_crews set slug = 'renamed' where id = '${CREW}'`);
  assert.notEqual(r.status, 0, '잠금 열 변경은 여전히 막힌다'); assert.match(r.stderr, /msgr_immutable_slug/);
  const h = asUserRaw(U.owner, `update public.msgr_crews set hosting = 'resident' where id = '${CREW}'`);
  assert.notEqual(h.status, 0, 'hosting도 여전히 막힌다');
  asUser(U.owner, `update public.msgr_crews set display_name = 'Renamed' where id = '${CREW}'`); // 잠금 밖 열은 그대로 바뀐다
  assert.equal(sql(`select display_name from public.msgr_crews where id = '${CREW}'`), 'Renamed');
});
