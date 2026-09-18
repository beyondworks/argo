// 한 회사 폴더(ws_id)의 크루는 한 계정 소유 — 서버 최종 방어(실사고 2026-09-17 윈도우 PC: 다른 계정 회사 크루 12명이 새 계정 소유로 24행 미러).
// 옛 앱 빌드(소유자 게이트 이전)가 남은 기기까지 막는지 본다. 실행: bash scripts/billing-pg-drill.sh test/msgr-crews-ws-owner-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crews-ws-owner-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));
const postRaw = (uid, ch, body) => asUserRaw(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`);

let ORG, ORG_DM;
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
  // 조직 회귀 대조군 — a·b는 같은 조직 멤버, c는 조직 밖
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
  assert.equal(last(asUser(U.b, `select public.msgr_accept_invite('${code}')`)), ORG);
  ORG_DM = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','dm','dm:b','[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
});


const crew = (uid, ws, slug, hosting = 'local') => `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values ('${ORG}', '${uid}', '${ws}', '${slug}', '${slug}', '${hosting}') returning id`;
const synced = (uid, ws) => sql(`insert into storage.objects (bucket_id, name) values ('companies', '${uid}/${ws}/company.json')`); // 동기화 저장소 = 회사 폴더의 주인

test('주인이 동기화한 회사 폴더를 다른 계정이 자기 소유로 올리면 거부한다(윈도우 PC 실사고)', { skip }, () => {
  synced(U.a, 'lean-ax-wqou');
  assert.match(last(asUser(U.a, crew(U.a, 'lean-ax-wqou', 'davinci'))), /^[0-9a-f-]{36}$/, '주인(a)은 올린다');
  fails(asUserRaw(U.b, crew(U.b, 'lean-ax-wqou', 'davinci')), /msgr_ws_owned_by_other/, '저장소 없는 다른 계정(b)이 같은 폴더 크루를 자기 소유로');
  fails(asUserRaw(U.b, crew(U.b, 'lean-ax-wqou', 'beast')), /msgr_ws_owned_by_other/, '다른 slug여도 같은 폴더면 거부');
  assert.equal(sql(`select count(*) from public.msgr_crews where ws_id = 'lean-ax-wqou' and owner_user_id = '${U.b}'`), '0', '한 행도 남지 않는다');
});

test('정당한 경우는 막지 않는다 — 주인의 추가·upsert, 폴더 이름 우연 충돌, 계정 이전, 옛 빌드가 먼저 올린 뒤의 주인(검수 MEDIUM-A)', { skip }, () => {
  assert.match(last(asUser(U.a, crew(U.a, 'lean-ax-wqou', 'beast'))), /^[0-9a-f-]{36}$/, '주인은 새 크루를 더 올린다');
  const up = asUserRaw(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.a}', 'lean-ax-wqou', 'beast', 'Beast 2') on conflict (org_id, owner_user_id, ws_id, slug) do update set display_name = excluded.display_name returning display_name`);
  assert.equal(up.status, 0, `주인의 upsert는 통과 — ${up.stderr}`);
  // 우연 충돌: 두 계정이 각자 동기화한 같은 이름의 회사
  synced(U.a, 'co-ab12'); synced(U.b, 'co-ab12');
  asUser(U.a, crew(U.a, 'co-ab12', 'x'));
  assert.match(last(asUser(U.b, crew(U.b, 'co-ab12', 'y'))), /^[0-9a-f-]{36}$/, '둘 다 자기 저장소가 있으면 통과');
  // 동기화 안 한 로컬 회사끼리 충돌: 서버는 주인을 모른다 → 막지 않는다(앱 게이트 몫)
  asUser(U.a, crew(U.a, 'co-zz99', 'x'));
  assert.match(last(asUser(U.b, crew(U.b, 'co-zz99', 'y'))), /^[0-9a-f-]{36}$/, '둘 다 저장소 없으면 통과');
  // 옛 빌드의 남의 계정이 먼저 올렸어도(주인 저장소 없음 → 막을 근거 없음) 원래 주인은 자기 저장소가 있어 통과
  asUser(U.b, crew(U.b, 'lean-home-objz', 'pepper'));
  synced(U.a, 'lean-home-objz');
  assert.match(last(asUser(U.a, crew(U.a, 'lean-home-objz', 'pepper'))), /^[0-9a-f-]{36}$/, '원래 주인은 잠기지 않는다');
});
