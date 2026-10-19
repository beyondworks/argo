// 메신저 v2 U2(일·약속 서버) PG 시험 공용 준비. U1 → U3(기기) → U2 순서로 적용한다.
// U3 파일(*_msgr2_device.sql)이 아직 이 브랜치에 없으면 같은 이름·같은 판정의 최소 판(아래 U3_STUB)을 쓴다 —
// U2는 U3의 msgr2_devices·msgr2_user_gen·_msgr2_session_id·_msgr2_device_ok/_kind/_app만 부른다.
// 요청 문맥: set role authenticated + argo.uid(auth.uid 대역) + request.jwt.claims.session_id(기기).
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './pg.mjs';

const mig = (f) => fileURLToPath(new URL(`../../supabase/migrations/${f}`, import.meta.url));
const pick = (suffix) => readdirSync(mig('')).filter((f) => f.endsWith(suffix)).sort().pop();

const U3_STUB = `
create table if not exists public.msgr2_user_gen (user_id uuid primary key references auth.users(id), gen int not null default 0, bumped_at timestamptz);
create table if not exists public.msgr2_devices (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
  kind text not null check (kind in ('app', 'runner', 'resident')), app text not null default 'desktop', app_version text not null default '0.1.0',
  link_v int4range, runners text[] not null default '{}', session_id uuid not null unique, push_token text, gen int not null default 0,
  expires_at timestamptz not null, revoked_at timestamptz, created_at timestamptz not null default now(), registered_at timestamptz not null default now());
create or replace function public._msgr2_session_id() returns uuid language sql stable set search_path = public, pg_temp as $$
  select case when s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then s::uuid end
    from (select coalesce(nullif(current_setting('request.jwt.claim.session_id', true), ''),
                          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id') as s) c $$;
create or replace function public._msgr2_device_kind() returns text language sql stable security definer set search_path = public, pg_temp as $$
  select d.kind from public.msgr2_devices d where d.session_id = public._msgr2_session_id() and d.user_id = auth.uid() and d.revoked_at is null
     and d.expires_at > now() and d.gen = coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0) $$;
create or replace function public._msgr2_device_ok() returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public._msgr2_device_kind() is not null $$;
create or replace function public._msgr2_device_app() returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public._msgr2_device_kind() = 'app', false) $$;
grant execute on function public._msgr2_session_id(), public._msgr2_device_kind(), public._msgr2_device_ok(), public._msgr2_device_app() to authenticated;`;

export function makeDb(DB) {
  const raw = (args) => psqlSpawn(DB, args);
  const psql = (args) => { const r = raw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; };
  const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
  const ctx = (uid, sid, topic = '') => `set role authenticated; select set_config('argo.uid', '${uid}', false), set_config('request.jwt.claims', '${JSON.stringify({ session_id: sid ?? '' })}', false), set_config('realtime.topic', '${topic}', false); `;
  // 사람·본체 문맥에서 질의 → 마지막 줄
  const as = (uid, sid, q) => { const r = raw(['-A', '-t', '-c', ctx(uid, sid) + q]); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr}`); return r.stdout.trim(); };
  const asErr = (uid, sid, q) => { const r = raw(['-A', '-t', '-c', ctx(uid, sid) + q]); return r.status === 0 ? null : r.stderr; };
  const lit = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
  const send = (uid, sid, env) => JSON.parse(as(uid, sid, `select public.msgr2_link_send(${lit(env)})`));
  const xmins = (t, where = 'true') => sql(`select coalesce(string_agg(xmin::text, ',' order by ctid), '') from public.${t} where ${where}`);
  // Realtime 토픽 구독 판정(받기 정책) — 그 토픽의 메시지 행 하나를 볼 수 있나
  const canListen = (uid, sid, topic) => {
    raw(['-c', `insert into realtime.messages (topic, extension, payload) select '${topic}', 'broadcast', '{}' where not exists (select 1 from realtime.messages where topic = '${topic}')`]);
    const r = raw(['-A', '-t', '-c', ctx(uid, sid, topic) + `select count(*) from realtime.messages where topic = '${topic}'`]);
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim() !== '0';
  };
  return { raw, psql, sql, as, asErr, lit, send, xmins, ctx, canListen };
}

// 역할·auth·realtime·storage·msgr_settings 대역만(마이그레이션 적용 전). 되돌림 시험이 단계별로 적용할 때 쓴다.
export function setupBase(DB) {
  const db = makeDb(DB);
  db.psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth; grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    -- realtime.send 대역: 방송을 표에 남긴다(시험이 w:<uid> 방송을 확인한다)
    create schema if not exists realtime;
    create table if not exists realtime.sent (id bigserial primary key, topic text, event text, payload jsonb);
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (topic, event, payload) values (topic, event, payload) $$;
    grant usage on schema realtime to authenticated; grant insert on realtime.sent to authenticated; grant usage on sequence realtime.sent_id_seq to authenticated;
    -- Realtime 토픽 권한 대역: realtime.messages + realtime.topic()(설정 realtime.topic). Supabase와 같은 모양으로 정책을 건다(U2b)
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb, event text);
    create or replace function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated;
    -- Storage 대역(버킷 msgr 정책 시험, U2b)
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz not null default now());
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, update, delete on storage.objects to authenticated;
    -- 운영에 있는 설정 표(옛 메신저 20260912150000). 상한·중단 스위치를 읽는다
    create table if not exists public.msgr_settings (key text primary key, value text);
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`]);
  return db;
}

// 운영 순서 판(검수 #1076): 옛 메신저 마이그레이션 전체(*_msgr*.sql — msgr2 포함) + 그 앞 요금제 기반을 이름 순으로 적용한다.
// msgr2 파일만 적용하면 옛 정책(OR로 합쳐지는 허용 정책)·옛 정리 작업과의 상호작용이 안 보인다.
export function setupFull(DB) {
  const db = setupBase(DB);
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  const all = [...base, ...readdirSync(mig('')).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort();
  for (const f of all) db.psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  return { ...db, files: all };
}

// A+(20261019160000) 앞의 v2 전체 기능을 잠그는 시험용 — 1:1 밖 막기(msgr2_lite)와 Pro 검사(msgr2_pro_gate)를 끈다.
// 운영 기본은 둘 다 켬. setupFull은 요금제 마이그레이션까지 적용해 is_pro_for가 있으므로, 시드 사용자(무료)는 켠 채로는 일을 못 만든다.
// A+ 동작 자체는 test/msgr2-aplus-pg.test.mjs가 켠 상태로 잠근다.
export function v2FullMode(db) {
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_lite', 'off'), ('msgr2_pro_gate', 'off') on conflict (key) do update set value = excluded.value`);
}

// 적용 순서: U1 → U3(없으면 최소 판) → U2 → U2b(있으면)
export const MSGR2_FILES = () => ({ u1: pick('_msgr2_space.sql'), u3: pick('_msgr2_device.sql'), u2: pick('_msgr2_work.sql'), u2b: pick('_msgr2_realtime_storage.sql'), u6b: pick('_msgr2_presence_attach.sql'), u6c1a: pick('_msgr2_work_signal.sql') });
export const migText = (f) => readFileSync(mig(f), 'utf8');

export function setup(DB) {
  const db = setupBase(DB);
  db.psql(['-c', readFileSync(mig(pick('_msgr2_space.sql')), 'utf8')]);
  const u3 = pick('_msgr2_device.sql');
  db.psql(['-c', u3 ? readFileSync(mig(u3), 'utf8') : U3_STUB]);
  db.psql(['-c', readFileSync(mig(pick('_msgr2_work.sql')), 'utf8')]);
  const u2b = pick('_msgr2_realtime_storage.sql');
  if (u2b) db.psql(['-c', readFileSync(mig(u2b), 'utf8')]);
  // U2b 뒤의 msgr2 파일(U6b 접속 표시·첨부 표지 등) — 버전 순서대로
  for (const f of readdirSync(mig('')).filter((x) => /_msgr2_.*\.sql$/.test(x) && u2b && x > u2b).sort()) db.psql(['-c', readFileSync(mig(f), 'utf8')]);
  return { ...db, u3: u3 ?? 'stub' };
}

// 사용자·기기 시드(서비스 문맥). 반환: { uid, sid(세션), dev(기기 id) }
export function seedDevice(db, uid, kind, { runners = kind === 'app' ? [] : ['claude'], revoked = false, expired = false } = {}) {
  db.sql(`insert into auth.users (id) values ('${uid}') on conflict do nothing`);
  const sid = db.sql('select gen_random_uuid()');
  const dev = db.sql(`insert into public.msgr2_devices (user_id, kind, app, app_version, link_v, runners, session_id, expires_at, revoked_at)
    values ('${uid}', '${kind}', '${kind === 'app' ? 'messenger' : 'desktop'}', '0.1.200', ${kind === 'app' ? 'null' : "'[1,1]'"},
      '{${runners.join(',')}}', '${sid}', now() + interval '${expired ? '-1 hour' : '30 days'}', ${revoked ? 'now()' : 'null'}) returning id`);
  return { uid, sid, dev };
}
