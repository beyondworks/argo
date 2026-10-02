// 조직 초대 링크는 멤버 하나·관리자 하나 + 지난 초대 30일 보존(20261002130000, 5차 피드백). 실행: bash scripts/billing-pg-drill.sh test/msgr-invite-one-per-kind-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-invite-one-per-kind-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555' };
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

let ORG, PRIV;
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
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean-inv-${Date.now()}', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  PRIV = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','private','Secret')`));
});

const mk = (role) => last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.a}') returning id`));
const revoked = (id) => sql(`select revoked_at is not null from public.msgr_invites where id = '${id}'`) === 't';

test('멤버 링크를 새로 만들면 이전 멤버 링크가 취소된다 — 관리자 링크는 따로 하나', { skip }, () => {
  const m1 = mk('member'); const a1 = mk('admin');
  assert.equal(revoked(m1), false); assert.equal(revoked(a1), false, '종류가 다르면 서로 건드리지 않는다');
  const m2 = mk('member');
  assert.equal(revoked(m1), true, '이전 멤버 링크 취소'); assert.equal(revoked(m2), false); assert.equal(revoked(a1), false);
  const a2 = mk('admin');
  assert.equal(revoked(a1), true); assert.equal(revoked(a2), false); assert.equal(revoked(m2), false);
  assert.equal(sql(`select count(*) from public.msgr_invites where org_id = '${ORG}' and role in ('member','admin') and not for_node and revoked_at is null`), '2', '쓸 수 있는 조직 링크는 종류마다 하나');
});

test('취소된 이전 링크로는 들어올 수 없다(새 링크로 바꾸기)', { skip }, () => {
  const old = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
  mk('member');
  fails(asUserRaw(U.b, `select public.msgr_accept_invite_v2('${old}')`), /msgr_invite_revoked/, '이전 링크 수락');
});

test('노드 코드·게스트 링크는 이 규칙 밖 — 멤버 링크를 취소하지도, 취소되지도 않는다', { skip }, () => {
  const m = mk('member');
  const node = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by, for_node) values ('${ORG}', 'member', '${U.a}', true) returning id`));
  assert.equal(revoked(m), false, '노드 코드가 멤버 링크를 취소하지 않는다');
  const g1 = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by, channel_ids, max_uses) values ('${ORG}', 'guest', '${U.a}', array['${PRIV}']::uuid[], 1) returning id`));
  const g2 = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by, channel_ids, max_uses) values ('${ORG}', 'guest', '${U.a}', array['${PRIV}']::uuid[], 1) returning id`));
  mk('member');
  assert.equal(revoked(node), false, '멤버 링크를 새로 만들어도 노드 코드는 그대로');
  assert.equal(revoked(g1), false); assert.equal(revoked(g2), false, '게스트 링크는 여러 개');
});

test('보존 기간 — 만료·취소 30일 지난 초대만 지운다(사용 기록도 함께), 그 안의 것과 살아 있는 링크는 둔다', { skip }, () => {
  sql(`delete from public.msgr_invites where org_id = '${ORG}'`);
  const ins = (expr) => { const id = last(sql(`insert into public.msgr_invites (org_id, role, created_by, for_node) values ('${ORG}', 'member', '${U.a}', true) returning id`)); sql(`update public.msgr_invites set ${expr} where id = '${id}'`); return id; }; // 노드 코드로 넣는다 — 서로 취소하지 않게(규칙 밖)
  const oldExp = ins(`expires_at = now() - interval '40 days'`);
  const oldRev = ins(`revoked_at = now() - interval '31 days'`);
  const newExp = ins(`expires_at = now() - interval '10 days'`);
  const newRev = ins(`revoked_at = now() - interval '2 days'`);
  const live = ins(`expires_at = now() + interval '7 days'`);
  sql(`insert into public.msgr_invite_uses (invite_id, user_id) values ('${oldExp}', '${U.b}')`);
  assert.equal(sql(`select public.msgr_invites_purge()`), '2');
  const left = sql(`select string_agg(id::text, ',' order by id) from public.msgr_invites where org_id = '${ORG}'`).split(',');
  assert.deepEqual(left.sort(), [newExp, newRev, live].sort());
  assert.equal(sql(`select count(*) from public.msgr_invite_uses where invite_id = '${oldExp}'`), '0', '사용 기록도 함께');
  assert.equal(sql(`select public.msgr_invites_purge()`), '0', '두 번째 실행은 0');
  fails(asUserRaw(U.a, `select public.msgr_invites_purge()`), /permission denied/, '사용자는 부를 수 없다');
});
