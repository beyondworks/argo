// 메신저 채널·조직 기억 경계(docs/msgr-memory-boundary.md P1, 유건 결정 2026-09-24) — 실 Postgres.
// 채널·조직 기억(msgr_org_docs, 서버 일지 journal/ 포함)은 채널·조직에서 나간 사람이 다시 볼 수 없다.
// 예외: 조직장(owner·admin — 1:1 대화 제외)과 그 채널의 채널장(admin_user_ids). 조직에서 나가면 장의 권한도 끝난다.
// 하네스는 msgr-bot-idle-gate-pg.test.mjs와 같다. 실행: `bash scripts/billing-pg-drill.sh test/msgr-memory-boundary-pg.test.mjs`
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333',
  lead: '44444444-4444-4444-8444-444444444444', guest: '55555555-5555-4555-8555-555555555555' };

function psql(args) { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, PRIV, DM;
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
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member'], [U.lead, 'member']]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  PRIV = last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'private', 'hr')`));
  const gcode = last(sql(`set role authenticated; select set_config('argo.uid', '${U.member}', false); reset role; insert into public.msgr_invites (org_id, role, channel_id, created_by) values ('${ORG}', 'guest', '${PRIV}', '${U.member}') returning code`)); // 초대자 = 채널을 만든 멤버(초대 트리거가 채널 관리권 확인)
  asUser(U.guest, `select public.msgr_accept_invite('${gcode}')`); // 채널 한정 게스트
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PRIV}', 'user', '${U.lead}'), ('${PRIV}', 'user', '${U.guest}') on conflict do nothing`);
  sql(`update public.msgr_channels set admin_user_ids = array['${U.lead}']::uuid[] where id = '${PRIV}'`);
  DM = last(sql(`insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'dm', 'dm:x', '${U.member}') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${DM}', 'user', '${U.member}'), ('${DM}', 'user', '${U.lead}')`);
  sql(`update public.msgr_channels set admin_user_ids = array['${U.lead}']::uuid[] where id = '${DM}'`);
  for (const ch of [PRIV, DM]) sql(`insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values ('${ORG}', '${ch}', 'journal/2026-09-24.md', 'j', '- 기록', '${U.member}', '${U.member}')`);
});

const reads = (uid, ch) => Number(last(asUser(uid, `select count(*) from public.msgr_org_docs where channel_id = '${ch}'`)));

test('조직장(owner·admin)은 멤버가 아닌 비공개 채널 기억을 읽는다', { skip }, () => {
  assert.equal(reads(U.owner, PRIV), 1);
  assert.equal(reads(U.admin, PRIV), 1);
});

test('1:1 대화 기억은 조직장도 못 읽는다(참여자만)', { skip }, () => {
  assert.equal(reads(U.owner, DM), 0);
  assert.equal(reads(U.admin, DM), 0);
  assert.equal(reads(U.member, DM), 1);
});

test('나간 멤버·게스트는 다시 못 보고, 채널장은 멤버에서 빠져도 자기 채널을 본다', { skip }, () => {
  assert.equal(reads(U.guest, PRIV), 1, '멤버일 때는 본다');
  sql(`delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_id in ('${U.guest}', '${U.lead}')`);
  assert.equal(reads(U.guest, PRIV), 0, '나간 게스트');
  assert.equal(reads(U.lead, PRIV), 1, '채널장 예외');
  sql(`delete from public.msgr_channel_members where channel_id = '${DM}' and member_id = '${U.lead}'`);
  assert.equal(reads(U.lead, DM), 0, '1:1 대화는 채널장 표시가 있어도 참여자만');
});

test('조직에서 나가면 장의 권한도 끝난다', { skip }, () => {
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id in ('${U.lead}', '${U.admin}')`);
  assert.equal(reads(U.lead, PRIV), 0);
  assert.equal(reads(U.admin, PRIV), 0);
});
