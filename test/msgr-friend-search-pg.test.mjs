// Friend search authorization and request lifecycle, against an isolated real PostgreSQL database.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  svc: '77777777-7777-4777-8777-777777777777',
};

function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();                 // 슈퍼유저(RLS 우회) — 시드·관찰 전용. BEFORE 트리거는 슈퍼유저에도 돈다
const sqlRaw = (q) => psqlRaw(['-A', '-t', '-c', q]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';        // set_config 출력 뒤 마지막 결과 줄
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };

let ORG, OTHER_ORG;
before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth;
    grant usage on schema auth to anon, authenticated, service_role;
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
    grant select, insert on realtime.messages to authenticated;
    grant usage on schema realtime to authenticated;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql',
    '20260903120000_msgr.sql', '20260909002000_msgr_profiles_friends.sql']) psql(['-f', mig(f)]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test')`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  OTHER_ORG = last(asUser(U.guest, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.guest}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values
    ('${ORG}', '${U.admin}', 'admin', '관리자'), ('${ORG}', '${U.member}', 'member', '조직 멤버')`);
  sql(`insert into public.msgr_profiles (user_id, handle, display_name, email_search, handle_search) values
    ('${U.admin}', 'admin_person', '프로필 관리자', false, false),
    ('${U.guest}', 'guest_person', '외부 사람', false, false),
    ('${U.svc}', 'public_person', '공개 프로필', true, true)`);
  sql(`update public.msgr_profiles set updated_at = '2026-09-14T00:00:00Z'`); // 기본 허용 마이그레이션의 백필 경계(2026-09-15 05:30Z) 이전에 저장된 행
  // Pin the reported failure before installing the migration in this same real database.
  assert.deepEqual(find(U.owner, 'member@example.test'), [], 'old RPC hides an existing member without a profile');
  assert.deepEqual(find(U.owner, 'admin@example.test'), [], 'old RPC hides an existing opted-out member');
  // Live databases may have an explicit anon EXECUTE grant; PUBLIC revocation alone does not remove it.
  sql('grant execute on function public.msgr_find_user(text) to anon');
  assert.equal(sql("select has_function_privilege('anon', 'public.msgr_find_user(text)', 'EXECUTE')"), 't');
  psql(['-f', mig('20260913084237_msgr_friend_member_search.sql')]);
  // 기본 허용(20260915150000): 기존 false 행을 전부 허용으로 올리고 컬럼 기본값도 허용. 명시적으로 끈 사람(admin·guest)은 시드 뒤 다시 끈다.
  assert.equal(sql('select count(*) from public.msgr_profiles where email_search = false'), '2', 'seed has two opted-out rows before the default flip');
  assert.deepEqual(find(U.guest, 'owner@example.test'), [], 'old RPC hides a stranger who never touched the profile (the reported failure)');
  psql(['-f', mig('20260915150000_msgr_email_search_default.sql')]);
  assert.equal(sql('select count(*) from public.msgr_profiles where email_search = false'), '0', 'migration lifts every opted-out row');
  // 재적용해도 그 뒤에 스스로 끈 사람은 되살아나지 않는다(LOW-1): 경계 이후 updated_at으로 끄고 같은 파일을 다시 적용
  sql(`update public.msgr_profiles set email_search = false, updated_at = now() where user_id = '${U.guest}'`);
  psql(['-f', mig('20260915150000_msgr_email_search_default.sql')]);
  assert.equal(sql(`select email_search from public.msgr_profiles where user_id = '${U.guest}'`), 'f', 'replay keeps a later explicit opt-out');
  assert.equal(sql("select column_default from information_schema.columns where table_name = 'msgr_profiles' and column_name = 'email_search'"), 'true');
  sql(`update public.msgr_profiles set email_search = false where user_id in ('${U.admin}', '${U.guest}')`);
  // member는 아이디·이름 없는 프로필로 이메일 검색만 끈 사람: 조직 멤버십 게이트(탈퇴·만료·삭제 조직) 검사는 "끈 사람"에게만 뜻이 있다.
  sql(`insert into public.msgr_profiles (user_id, email_search) values ('${U.member}', false)`);
});
function escaped(s) { return s.replace(/'/g, "''"); }
function find(uid, text) { return JSON.parse(last(asUser(uid, `select coalesce(json_agg(r), '[]'::json) from public.msgr_find_user('${escaped(text)}') r`))); }

test('same active organization: exact email works with or without a profile; four-column contract stays compatible', { skip }, () => {
  assert.deepEqual(find(U.owner, 'member@example.test'), [{ user_id: U.member, handle: null, display_name: '조직 멤버', relation: 'none' }]);
  assert.deepEqual(find(U.owner, 'admin@example.test'), [{ user_id: U.admin, handle: 'admin_person', display_name: '프로필 관리자', relation: 'none' }]);
  assert.equal(sql(`select pg_get_function_result('public.msgr_find_user(text)'::regprocedure)`), 'TABLE(user_id uuid, handle text, display_name text, relation text)');
});
test('email normalization permits case and surrounding whitespace, never partial or wildcard email', { skip }, () => {
  assert.equal(find(U.owner, '  MEMBER@EXAMPLE.TEST  ')[0]?.user_id, U.member);
  for (const q of ['member@example', 'member@', '%@example.test', 'm_mber@example.test', '', 'me']) assert.deepEqual(find(U.owner, q), [], q);
});
test('external search: exact email finds anyone who has not turned lookup off; explicit opt-out and handle privacy still hold', { skip }, () => {
  assert.deepEqual(find(U.owner, 'guest@example.test'), [], 'explicit opt-out stays hidden');
  assert.deepEqual(find(U.owner, 'gue'), []);
  assert.deepEqual(find(U.owner, 'admin'), []);
  assert.equal(find(U.owner, 'svc@example.test')[0]?.user_id, U.svc);
  assert.equal(find(U.owner, 'pub')[0]?.handle, 'public_person');
  assert.equal(find(U.guest, 'owner@example.test')[0]?.user_id, U.owner, 'no profile + no shared organization = still found (default allowed)');
  assert.deepEqual(find(U.guest, 'member@example.test'), [], 'opted out + no shared organization = hidden');
  assert.equal(find(U.owner, 'member@example.test')[0]?.user_id, U.member, 'same organization still finds an opted-out member');
  try {
    sql(`update public.msgr_profiles set email_search = true where user_id = '${U.member}'`);
    assert.equal(find(U.guest, 'member@example.test')[0]?.user_id, U.member, 'turning it back on shows to strangers');
    sql(`insert into public.msgr_profiles (user_id, handle) values ('${U.owner}', 'owner_person')`);
    assert.equal(sql(`select email_search from public.msgr_profiles where user_id = '${U.owner}'`), 't', 'new profile row defaults to allowed');
    assert.equal(find(U.guest, 'owner@example.test')[0]?.handle, 'owner_person');
  } finally {
    sql(`update public.msgr_profiles set email_search = false where user_id = '${U.member}'; delete from public.msgr_profiles where user_id = '${U.owner}'`);
  }
});
test('removed and expired target memberships never grant email discovery', { skip }, () => {
  for (const column of ['removed_at', 'expires_at']) {
    try {
      sql(`update public.msgr_org_members set ${column}=now()-interval '1 minute' where org_id='${ORG}' and user_id='${U.member}'`);
      assert.deepEqual(find(U.owner, 'member@example.test'), [], column);
    } finally { sql(`update public.msgr_org_members set ${column}=null where org_id='${ORG}' and user_id='${U.member}'`); }
  }
});
test('removed and expired caller memberships never grant email discovery', { skip }, () => {
  for (const column of ['removed_at', 'expires_at']) {
    try {
      sql(`update public.msgr_org_members set ${column}=now()-interval '1 minute' where org_id='${ORG}' and user_id='${U.admin}'`);
      assert.deepEqual(find(U.admin, 'member@example.test'), [], column);
    } finally { sql(`update public.msgr_org_members set ${column}=null where org_id='${ORG}' and user_id='${U.admin}'`); }
  }
});
test('deleted organization cannot grant discovery; a different live shared organization can', { skip }, () => {
  try {
    sql(`update public.msgr_orgs set deleted_at=now() where id='${ORG}'`);
    assert.deepEqual(find(U.owner, 'member@example.test'), []);
    sql(`insert into public.msgr_org_members (org_id,user_id,role) values ('${OTHER_ORG}','${U.owner}','member'), ('${OTHER_ORG}','${U.member}','member')`);
    assert.equal(find(U.owner, 'member@example.test')[0]?.user_id, U.member);
  } finally {
    sql(`delete from public.msgr_org_members where org_id='${OTHER_ORG}' and user_id in ('${U.owner}','${U.member}'); update public.msgr_orgs set deleted_at=null where id='${ORG}'`);
  }
});
test('friend request, received, accepted, and removal keep search results and existing relation states', { skip }, () => {
  assert.equal(last(asUser(U.owner, `select public.msgr_friend_request('${U.member}')`)), 'sent');
  assert.equal(find(U.owner, 'member@example.test')[0]?.relation, 'sent');
  assert.equal(find(U.member, 'owner@example.test')[0]?.relation, 'received');
  assert.equal(last(asUser(U.member, `select public.msgr_friend_decide('${U.owner}', true)`)), 'friend');
  assert.equal(find(U.owner, 'member@example.test')[0]?.relation, 'friend');
  assert.equal(last(asUser(U.owner, `select public.msgr_friend_request('${U.member}')`)), 'friend');
  asUser(U.owner, `select public.msgr_friend_remove('${U.member}')`);
  assert.equal(find(U.owner, 'member@example.test')[0]?.relation, 'none');
});
test('self and both directions of blocking stay hidden, including members and public opt-in', { skip }, () => {
  assert.deepEqual(find(U.owner, 'owner@example.test'), []);
  for (const target of [U.member, U.svc]) {
    asUser(target, `select public.msgr_friend_remove('${U.owner}', true)`);
    assert.deepEqual(find(U.owner, target === U.member ? 'member@example.test' : 'svc@example.test'), []);
    assert.deepEqual(find(target, 'owner@example.test'), []);
    sql(`delete from public.msgr_friends where a=least('${U.owner}'::uuid,'${target}'::uuid) and b=greatest('${U.owner}'::uuid,'${target}'::uuid)`);
  }
});
test('closed friend requests remain rejected even when a same-organization email is discoverable', { skip }, () => {
  try {
    sql(`update public.msgr_profiles set accept_requests=false where user_id='${U.admin}'`);
    assert.equal(find(U.owner, 'admin@example.test')[0]?.user_id, U.admin);
    fails(asUserRaw(U.owner, `select public.msgr_friend_request('${U.admin}')`), /msgr_friend_closed/, 'closed requests');
  } finally { sql(`update public.msgr_profiles set accept_requests=true where user_id='${U.admin}'`); }
});
test('RPC requires authenticated UID; neither table access nor public execution expands', { skip }, () => {
  assert.equal(sql("select has_function_privilege('anon', 'public.msgr_find_user(text)', 'EXECUTE')"), 'f', 'explicit anon grant revoked');
  assert.equal(sql("select has_function_privilege('authenticated', 'public.msgr_find_user(text)', 'EXECUTE')"), 't', 'authenticated RPC remains available');
  fails(sqlRaw(`set role anon; select * from public.msgr_find_user('member@example.test')`), /permission denied/, 'anonymous');
  fails(asUserRaw('', `select * from public.msgr_find_user('member@example.test')`), /msgr_auth/, 'missing UID');
  fails(asUserRaw(U.owner, 'select email from auth.users'), /permission denied/, 'raw user directory');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_profiles where user_id='${U.admin}'`)), '0', 'profile RLS unchanged');
});
