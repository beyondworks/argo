// 앱 내 계정 삭제(msgr_delete_me) — 일회용 PostgreSQL에서 배포될 마이그레이션 그대로 적용해 검증.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-delete-me-pg.test.mjs  (또는 ARGO_PG_TEST_URL 지정)
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-delete-me-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', solo: '55555555-5555-4555-8555-555555555555', svc: '77777777-7777-4777-8777-777777777777' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, SOLO_ORG, CREW, PUB;
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
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
  `]);
  sql(`create schema net; create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  SOLO_ORG = last(asUser(U.solo, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Solo', 'solo', '${U.solo}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id in ('${ORG}', '${SOLO_ORG}')`);
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'admin', '${U.owner}') returning code`));
  assert.equal(last(asUser(U.admin, `select public.msgr_accept_invite('${code}')`)), ORG);
  CREW = last(asUser(U.admin, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.admin}', 'lean', 'mine', 'Mine') returning id`));
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Work')`));
  sql(`update public.msgr_crews set status='active', last_seen_at=now() where id='${CREW}'`);
});

test('익명은 거부, 다른 멤버가 있는 조직의 소유자는 이전이 먼저(조직명을 알려 준다)', { skip }, () => {
  const anon = psqlRaw(['-A', '-t', '-c', `set role authenticated; select public.msgr_delete_me()`]);
  assert.notEqual(anon.status, 0); assert.match(anon.stderr, /msgr_unauthenticated/);
  const r = asUserRaw(U.owner, `select public.msgr_delete_me()`);
  assert.notEqual(r.status, 0, '소유자 삭제가 허용됨'); assert.match(r.stderr, /msgr_owner_transfer_required: Lean/);
  assert.equal(sql(`select count(*) from auth.users where id='${U.owner}'`), '1', '거부 시 아무것도 지우지 않는다');
  assert.equal(sql(`select deleted_at is null from public.msgr_orgs where id='${ORG}'`), 't');
});

test('멤버(관리자) 삭제 — 흔적 정리·크루 분리·멤버십 종료·auth 사용자 삭제, 메시지 본문은 남는다', { skip }, () => {
  const mid = last(asUser(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${PUB}', 'user', '${U.admin}', 'text', '남는 글', 'keep-1') returning id`));
  asUser(U.admin, `insert into public.msgr_reads (channel_id, user_id, last_read_id) values ('${PUB}', '${U.admin}', ${mid})`);
  asUser(U.admin, `insert into public.msgr_reactions (message_id, user_id, emoji) values (${mid}, '${U.admin}', '👍')`);
  sql(`insert into public.msgr_push_tokens (token, user_id, platform, device) values ('tok-admin', '${U.admin}', 'ios', 'phone')`); // 푸시 토큰은 RPC로만 쓰는 표 — 시드는 슈퍼유저
  asUser(U.admin, `insert into public.msgr_profiles (user_id, handle, display_name) values ('${U.admin}', 'adminh', 'Admin')`);
  sql(`insert into public.msgr_friends (a, b, status, requested_by) values (least('${U.admin}'::uuid,'${U.owner}'::uuid), greatest('${U.admin}'::uuid,'${U.owner}'::uuid), 'accepted', '${U.admin}')`); // 친구 표도 RPC 전용 — 시드는 슈퍼유저
  const mine = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}','public','AdminMade')`));
  const out = last(asUser(U.admin, `select public.msgr_delete_me()`));
  assert.deepEqual(JSON.parse(out), { deleted_orgs: 0 });
  assert.equal(sql(`select count(*) from auth.users where id='${U.admin}'`), '0', 'auth 사용자 삭제');
  assert.equal(sql(`select count(*) from public.msgr_org_members where org_id='${ORG}' and user_id='${U.admin}'`), '0', '멤버십은 auth.users cascade로 사라진다(removed_at 표시는 그 전 단계)');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind='user' and member_id='${U.admin}'`), '0');
  for (const t of ['msgr_push_tokens', 'msgr_reads', 'msgr_reactions', 'msgr_profiles']) assert.equal(sql(`select count(*) from public.${t} where user_id='${U.admin}'`), '0', t);
  assert.equal(sql(`select count(*) from public.msgr_friends where a='${U.admin}' or b='${U.admin}'`), '0', '친구 관계');
  assert.equal(sql(`select created_by from public.msgr_channels where id='${mine}'`), U.owner, '내가 만든 채널은 조직 소유자에게 넘어간다');
  assert.equal(sql(`select count(*) from public.msgr_crews where id='${CREW}'`), '0', '내 크루(개인 에이전트)는 계정과 함께 삭제');
  assert.equal(sql(`select body||'|'||coalesce(author_user_id::text,'(null)') from public.msgr_messages where id=${mid}`), '남는 글|(null)', '공유 공간의 글은 남고 작성자 참조만 비워진다(FK set null)');
});

test('혼자인 소유 조직은 하드 삭제(자식 cascade)와 함께 계정 삭제', { skip }, () => {
  const ch = last(asUser(U.solo, `select public.msgr_create_channel('${SOLO_ORG}','public','Mine')`));
  assert.deepEqual(JSON.parse(last(asUser(U.solo, `select public.msgr_delete_me()`))), { deleted_orgs: 1 });
  assert.equal(sql(`select count(*) from public.msgr_orgs where id='${SOLO_ORG}'`), '0');
  assert.equal(sql(`select count(*) from public.msgr_channels where id='${ch}'`), '0', '조직 자식(채널)도 사라진다');
  assert.equal(sql(`select count(*) from auth.users where id='${U.solo}'`), '0');
});

test('서비스 계정만 남은 조직도 "혼자"로 본다 — 소유자 삭제 허용', { skip }, () => {
  const other = '66666666-6666-4666-8666-666666666666';
  sql(`insert into auth.users (id, email) values ('${other}', 'svcowner@example.test'), ('${U.svc}', 'svc@example.test') on conflict do nothing`);
  const org = last(asUser(other, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('SvcOnly', 'svconly', '${other}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${U.svc}', 'member', 'svc') on conflict do nothing; update public.msgr_orgs set service_user_id='${U.svc}' where id='${org}'`);
  assert.deepEqual(JSON.parse(last(asUser(other, `select public.msgr_delete_me()`))), { deleted_orgs: 1 });
});
