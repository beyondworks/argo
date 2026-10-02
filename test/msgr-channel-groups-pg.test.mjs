// 폰 채널 탭 그룹(유건 확정 2026-10-02) — 그룹은 나만 보이고(내 기기끼리 맞춰짐), 채널 하나는 그룹 하나에만, 조직 공간마다 따로.
// 잠그는 것: 남의 그룹·연결은 읽기·쓰기·지우기 불가 / (user_id, channel_id) 유일 / 다른 조직 채널·대화방·남의 그룹에 넣기 불가 /
//           그룹을 지우면 연결만 사라지고 채널은 그대로 / 이름 규칙·겹침.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-channel-groups-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-channel-groups-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 200)}`); };
const RLS = /row-level security|violates row-level/;

let ORG, ORG2, LEAN, GEN, ORG2CH, DM;
const newGroup = (uid, org, name, pos = 0) => last(asUser(uid, `insert into public.msgr_channel_groups (user_id, org_id, name, pos) values ('${uid}', '${org}', '${name}', ${pos}) returning id`));
const link = (uid, ch, g) => asUser(uid, `insert into public.msgr_channel_group_links (user_id, channel_id, group_id) values ('${uid}', '${ch}', '${g}') on conflict (user_id, channel_id) do update set group_id = excluded.group_id`);

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
  const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
  assert.equal(last(asUser(U.b, `select public.msgr_accept_invite('${code}')`)), ORG);
  LEAN = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Lean Crew')`));
  GEN = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','General')`));
  assert.equal(last(asUser(U.b, `select public.msgr_join_channel('${LEAN}')`)), 't');
  ORG2 = last(asUser(U.c, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.c}') returning id`));
  ORG2CH = last(asUser(U.c, `select public.msgr_create_channel('${ORG2}','public','Elsewhere')`));
  DM = last(sql(`insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'dm', 'dm:b', '${U.a}') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${DM}', 'user', '${U.a}') on conflict do nothing`);
});

test('내 그룹을 만들고 채널을 넣는다 — 남은 내 그룹·연결을 못 본다', { skip }, () => {
  const g = newGroup(U.a, ORG, '마케팅');
  link(U.a, LEAN, g);
  assert.equal(asUser(U.a, `select count(*) from public.msgr_channel_group_links where channel_id = '${LEAN}'`), '1');
  assert.equal(asUser(U.b, `select count(*) from public.msgr_channel_groups where id = '${g}'`), '0', 'b는 a의 그룹을 못 본다');
  assert.equal(asUser(U.b, `select count(*) from public.msgr_channel_group_links where group_id = '${g}'`), '0', 'b는 a의 연결을 못 본다');
});

test('남의 그룹 고치기·지우기·채널 넣기 불가', { skip }, () => {
  const g = newGroup(U.a, ORG, '운영', 1);
  assert.equal(asUser(U.b, `with x as (update public.msgr_channel_groups set name = '탈취' where id = '${g}' returning 1) select count(*) from x`), '0', '이름 바꾸기 0행');
  assert.equal(asUser(U.b, `with x as (delete from public.msgr_channel_groups where id = '${g}' returning 1) select count(*) from x`), '0', '지우기 0행');
  assert.equal(sql(`select name from public.msgr_channel_groups where id = '${g}'`), '운영');
  fails(asUserRaw(U.b, `insert into public.msgr_channel_group_links (user_id, channel_id, group_id) values ('${U.b}', '${LEAN}', '${g}')`), RLS, 'b가 a의 그룹에 자기 연결');
  fails(asUserRaw(U.b, `insert into public.msgr_channel_group_links (user_id, channel_id, group_id) values ('${U.a}', '${GEN}', '${g}')`), RLS, 'b가 a 이름으로 연결');
  fails(asUserRaw(U.b, `insert into public.msgr_channel_groups (user_id, org_id, name) values ('${U.a}', '${ORG}', '가짜')`), RLS, 'b가 a 이름으로 그룹');
  // a의 연결을 b가 옮기거나 지울 수 없다
  link(U.a, GEN, g);
  const gb = newGroup(U.b, ORG, '내것');
  assert.equal(asUser(U.b, `with x as (update public.msgr_channel_group_links set group_id = '${gb}' where user_id = '${U.a}' returning 1) select count(*) from x`), '0');
  assert.equal(asUser(U.b, `with x as (delete from public.msgr_channel_group_links where user_id = '${U.a}' returning 1) select count(*) from x`), '0');
  assert.equal(sql(`select group_id from public.msgr_channel_group_links where user_id = '${U.a}' and channel_id = '${GEN}'`), g);
});

test('내 그룹이라도 소속(org_id)·주인(user_id)·만든 때는 바꿀 수 없다 — 이름·순서만 고친다(검수 L-1)', { skip }, () => {
  // b가 두 조직에 속하면 RLS with check(새 org_id의 멤버인가)만으로는 그룹을 다른 조직으로 옮길 수 있었다 —
  // 그러면 옛 조직 채널의 연결이 다른 조직 그룹 아래 남는다. 옛 값을 보는 트리거(msgr_lock_cols)로만 막을 수 있다.
  const code2 = last(asUser(U.c, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG2}', 'member', '${U.c}') returning code`));
  assert.equal(last(asUser(U.b, `select public.msgr_accept_invite('${code2}')`)), ORG2);
  const g = newGroup(U.b, ORG, '옮기기 시험', 7);
  link(U.b, LEAN, g);
  fails(asUserRaw(U.b, `update public.msgr_channel_groups set org_id = '${ORG2}' where id = '${g}'`), /msgr_immutable_org_id/, 'b가 자기 그룹의 org_id를 다른 조직으로');
  fails(asUserRaw(U.b, `update public.msgr_channel_groups set user_id = '${U.a}' where id = '${g}'`), /msgr_immutable_user_id|row-level security/, 'b가 자기 그룹을 a에게 넘기기');
  fails(asUserRaw(U.b, `update public.msgr_channel_groups set created_at = now() - interval '1 year' where id = '${g}'`), /msgr_immutable_created_at/, '만든 때 고치기');
  assert.equal(sql(`select org_id || '|' || user_id from public.msgr_channel_groups where id = '${g}'`), `${ORG}|${U.b}`);
  assert.equal(asUser(U.b, `with x as (update public.msgr_channel_groups set name = '새 이름', pos = 9 where id = '${g}' returning 1) select count(*) from x`), '1', '이름·순서는 고칠 수 있다');
});

test('채널 하나는 그룹 하나에만 — (user_id, channel_id) 유일, 옮기면 한 행', { skip }, () => {
  const g1 = newGroup(U.a, ORG, '하나', 2); const g2 = newGroup(U.a, ORG, '둘', 3);
  const ch = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Uniq')`));
  asUser(U.a, `insert into public.msgr_channel_group_links (user_id, channel_id, group_id) values ('${U.a}', '${ch}', '${g1}')`);
  fails(asUserRaw(U.a, `insert into public.msgr_channel_group_links (user_id, channel_id, group_id) values ('${U.a}', '${ch}', '${g2}')`), /duplicate key|unique/, '같은 채널을 두 번째 그룹에');
  link(U.a, ch, g2);
  assert.equal(sql(`select string_agg(group_id::text, ',') from public.msgr_channel_group_links where user_id = '${U.a}' and channel_id = '${ch}'`), g2, '옮긴 뒤 한 행');
  // 다른 사람은 같은 채널을 자기 그룹에 따로 넣을 수 있다(나만 보이는 분류)
  const gb = newGroup(U.b, ORG, '비 그룹');
  assert.equal(last(asUser(U.b, `select public.msgr_join_channel('${ch}')`)), 't');
  link(U.b, ch, gb);
  assert.equal(sql(`select count(*) from public.msgr_channel_group_links where channel_id = '${ch}'`), '2');
});

test('조직 공간마다 따로 — 다른 조직 채널·대화방은 넣을 수 없다', { skip }, () => {
  const g = newGroup(U.a, ORG, '경계', 4);
  fails(asUserRaw(U.a, `insert into public.msgr_channel_group_links (user_id, channel_id, group_id) values ('${U.a}', '${ORG2CH}', '${g}')`), RLS, '다른 조직 채널');
  fails(asUserRaw(U.a, `insert into public.msgr_channel_group_links (user_id, channel_id, group_id) values ('${U.a}', '${DM}', '${g}')`), RLS, '대화방(dm)은 그룹 대상이 아니다');
  fails(asUserRaw(U.a, `insert into public.msgr_channel_groups (user_id, org_id, name) values ('${U.a}', '${ORG2}', '남의 조직')`), RLS, '내가 속하지 않은 조직에 그룹');
  // 조직2 소유자 c의 그룹과 연결은 a 조직과 섞이지 않는다
  const gc = newGroup(U.c, ORG2, '마케팅');
  link(U.c, ORG2CH, gc);
  assert.equal(asUser(U.a, `select count(*) from public.msgr_channel_groups where org_id = '${ORG2}'`), '0');
  // 연결 옮기기도 같은 검사(update with check) — 내 그룹이라도 다른 조직 그룹으로는 못 옮긴다
  const gcx = newGroup(U.c, ORG2, '옮김 대상');
  const gco = last(asUser(U.a, `insert into public.msgr_channel_groups (user_id, org_id, name) values ('${U.a}', '${ORG}', '내 조직1') returning id`));
  link(U.a, GEN, gco);
  fails(asUserRaw(U.a, `update public.msgr_channel_group_links set group_id = '${gcx}' where user_id = '${U.a}' and channel_id = '${GEN}'`), RLS, '남의 다른 조직 그룹으로 옮기기');
});

test('그룹을 지우면 연결만 사라지고 채널은 그대로', { skip }, () => {
  const g = newGroup(U.a, ORG, '지울 그룹', 5);
  const ch = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Keep')`));
  link(U.a, ch, g);
  asUser(U.a, `delete from public.msgr_channel_groups where id = '${g}'`);
  assert.equal(sql(`select count(*) from public.msgr_channel_group_links where channel_id = '${ch}'`), '0');
  assert.equal(sql(`select count(*) from public.msgr_channels where id = '${ch}'`), '1', '채널은 지우지 않는다');
});

test('이름 규칙 — 빈 이름·30자 초과 거부, 같은 조직 안 같은 이름(대소문자 무시) 거부, 다른 사람·다른 조직은 같은 이름 가능', { skip }, () => {
  fails(asUserRaw(U.a, `insert into public.msgr_channel_groups (user_id, org_id, name) values ('${U.a}', '${ORG}', '   ')`), /check/, '빈 이름');
  fails(asUserRaw(U.a, `insert into public.msgr_channel_groups (user_id, org_id, name) values ('${U.a}', '${ORG}', '${'가'.repeat(31)}')`), /check/, '31자');
  newGroup(U.a, ORG, 'Sales', 6);
  fails(asUserRaw(U.a, `insert into public.msgr_channel_groups (user_id, org_id, name) values ('${U.a}', '${ORG}', 'sales')`), /duplicate key|unique/, '같은 이름');
  newGroup(U.b, ORG, 'Sales'); // 다른 사람
  assert.equal(sql(`select count(*) from public.msgr_channel_groups where lower(name) = 'sales'`), '2');
});

test('그룹은 조직당 50개까지(쌓이기만 하는 데이터가 아니게)', { skip }, () => {
  const have = Number(sql(`select count(*) from public.msgr_channel_groups where user_id = '${U.c}' and org_id = '${ORG2}'`));
  asUser(U.c, `insert into public.msgr_channel_groups (user_id, org_id, name) select '${U.c}', '${ORG2}', 'cap ' || i from generate_series(1, ${50 - have}) i`);
  fails(asUserRaw(U.c, `insert into public.msgr_channel_groups (user_id, org_id, name) values ('${U.c}', '${ORG2}', 'one more')`), /msgr_group_limit/, '51번째');
});

test('anon은 아무것도 못 한다', { skip }, () => {
  const r = psqlRaw(['-A', '-t', '-c', 'set role anon; select count(*) from public.msgr_channel_groups']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /permission denied/);
});
