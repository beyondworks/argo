// Real PostgreSQL regression: target favorites and atomic DM leave. Isolated DB via billing-pg-drill.sh.
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

let ORG, OTHER_ORG, CREW, OTHER_CREW;
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
  // 배포될 마이그레이션을 라이브와 같은 순서로 그대로 적용(제외 목록 열은 20260911150000이 만든다)
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql',
    '20260903120000_msgr.sql', '20260907120000_msgr_crew_inventory.sql', '20260908120000_msgr_bots.sql', '20260908140000_msgr_crew_autodispatch.sql',
    '20260909000000_msgr_bot_external_id.sql', '20260909001000_msgr_crew_folder.sql', '20260909002000_msgr_profiles_friends.sql', '20260909003000_msgr_message_meta.sql',
    '20260909004000_msgr_p0_reads_reactions_prefs.sql', '20260909005000_msgr_avatars.sql', '20260909120000_msgr_execution_claims.sql', '20260909230000_msgr_bot_execution.sql',
    '20260911150000_msgr_channel_manage.sql', '20260911230000_msgr_channel_scope_enforce.sql', '20260912135036_msgr_target_favorites_dm_leave.sql']) psql(['-f', mig(f)]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  OTHER_ORG = last(asUser(U.guest, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.guest}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const uid of [U.admin, U.member]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  OTHER_CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean', 'theirs', 'Theirs') returning id`));
});

const pref = (user, kind, target, org = ORG) => `insert into public.msgr_target_prefs (user_id, org_id, target_kind, target_id) values ('${user}', '${org}', '${kind}', '${target}')`;
const createDm = (user, others) => last(asUser(user, `select public.msgr_create_channel('${ORG}', 'dm', 'test', '${JSON.stringify(others)}'::jsonb)`));
const members = (ch) => sql(`select member_kind || ':' || member_id from public.msgr_channel_members where channel_id = '${ch}' order by member_kind, member_id`).split('\n').filter(Boolean);
const leave = (user, ch) => last(asUser(user, `select public.msgr_leave_dm('${ch}')`));

test('favorite/unfavorite user and crew persists independently without creating a DM', { skip }, () => {
  const count = sql('select count(*) from public.msgr_channels');
  for (const [kind, target] of [['user', U.member], ['crew', CREW]]) {
    asUser(U.owner, pref(U.owner, kind, target));
    assert.equal(last(asUser(U.owner, `select pinned from public.msgr_target_prefs where target_id = '${target}'`)), 't');
    asUser(U.owner, `update public.msgr_target_prefs set pin_pos = 3 where target_id = '${target}'`);
    assert.equal(last(asUser(U.owner, `select pin_pos from public.msgr_target_prefs where target_id = '${target}'`)), '3');
    asUser(U.owner, `delete from public.msgr_target_prefs where target_id = '${target}'`);
  }
  assert.equal(sql('select count(*) from public.msgr_channels'), count);
});

test('preferences are owner-only and cannot be reassigned even within an organization', { skip }, () => {
  asUser(U.owner, pref(U.owner, 'crew', CREW));
  assert.equal(last(asUser(U.member, 'select count(*) from public.msgr_target_prefs')), '0');
  asUser(U.member, 'delete from public.msgr_target_prefs');
  asUser(U.member, 'update public.msgr_target_prefs set pinned = false');
  assert.equal(sql('select count(*) from public.msgr_target_prefs where pinned'), '1');
  fails(asUserRaw(U.member, pref(U.owner, 'user', U.member)), /row-level security/, 'forged owner');
  fails(asUserRaw(U.owner, `update public.msgr_target_prefs set user_id = '${U.member}'`), /row-level security/, 'owner reassignment');
});

test('cross-organization, missing and inactive user targets are rejected on insert/update', { skip }, () => {
  fails(asUserRaw(U.owner, pref(U.owner, 'user', U.guest)), /row-level security/, 'foreign user');
  fails(asUserRaw(U.owner, pref(U.owner, 'crew', CREW, OTHER_ORG)), /row-level security/, 'foreign org');
  fails(asUserRaw(U.owner, pref(U.owner, 'crew', U.svc)), /row-level security/, 'missing crew');
  fails(asUserRaw(U.owner, `update public.msgr_target_prefs set org_id = '${OTHER_ORG}'`), /row-level security/, 'foreign update');
  sql(`update public.msgr_org_members set expires_at = now() - interval '1 minute' where org_id = '${ORG}' and user_id = '${U.admin}'`);
  fails(asUserRaw(U.owner, pref(U.owner, 'user', U.admin)), /row-level security/, 'expired target');
  sql(`update public.msgr_org_members set expires_at = null where org_id = '${ORG}' and user_id = '${U.admin}'`);
});

test('owner may remove stale favorites after own organization membership expires, but cannot edit them', { skip }, () => {
  asUser(U.admin, pref(U.admin, 'crew', CREW));
  sql(`update public.msgr_org_members set expires_at = now() - interval '1 minute' where org_id = '${ORG}' and user_id = '${U.admin}'`);
  assert.equal(last(asUser(U.admin, 'select count(*) from public.msgr_target_prefs')), '1');
  fails(asUserRaw(U.admin, 'update public.msgr_target_prefs set pin_pos = 7'), /row-level security/, 'expired editor');
  asUser(U.admin, 'delete from public.msgr_target_prefs');
  assert.equal(last(asUser(U.admin, 'select count(*) from public.msgr_target_prefs')), '0');
  sql(`update public.msgr_org_members set expires_at = null where org_id = '${ORG}' and user_id = '${U.admin}'`);
});

test('leaving own-agent DM removes own crew then user and is idempotent', { skip }, () => {
  const dm = createDm(U.owner, [{kind: 'crew', id: CREW}]);
  assert.equal(leave(U.owner, dm), 't');
  assert.deepEqual(members(dm), []);
  assert.equal(leave(U.owner, dm), 'f');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_channels where id = '${dm}'`)), '0');
  assert.equal(sql(`select status from public.msgr_crews where id = '${CREW}'`), 'active', 'global crew registration survives');
});

test('leaving another owner’s agent DM retains that owner and crew', { skip }, () => {
  const dm = createDm(U.owner, [{kind: 'user', id: U.member}, {kind: 'crew', id: OTHER_CREW}]);
  assert.equal(leave(U.owner, dm), 't');
  assert.deepEqual(members(dm), [`crew:${OTHER_CREW}`, `user:${U.member}`]);
  assert.equal(last(asUser(U.member, `select public.msgr_can_read_channel('${dm}')`)), 't');
});

test('crew owner can leave a DM created by another participant without removing that participant', { skip }, () => {
  const dm = createDm(U.member, [{kind: 'user', id: U.owner}, {kind: 'crew', id: CREW}]);
  assert.equal(leave(U.owner, dm), 't');
  assert.deepEqual(members(dm), [`user:${U.member}`]);
});

test('human DM preserves peer; outsiders and expired memberships cannot mutate it', { skip }, () => {
  const dm = createDm(U.owner, [{kind: 'user', id: U.member}]);
  const before = members(dm);
  assert.equal(leave(U.admin, dm), 'f');
  assert.equal(leave(U.guest, dm), 'f');
  sql(`update public.msgr_org_members set expires_at = now() - interval '1 minute' where org_id = '${ORG}' and user_id = '${U.member}'`);
  assert.equal(leave(U.member, dm), 'f');
  assert.deepEqual(members(dm), before);
  sql(`update public.msgr_org_members set expires_at = null where org_id = '${ORG}' and user_id = '${U.member}'`);
  assert.equal(leave(U.member, dm), 't');
  assert.deepEqual(members(dm), [`user:${U.owner}`]);
});

test('DM RPC rejects private/public channels and leaves their membership untouched', { skip }, () => {
  for (const kind of ['private', 'public']) {
    const ch = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', '${kind}', 'keep')`));
    const before = members(ch);
    fails(asUserRaw(U.owner, `select public.msgr_leave_dm('${ch}')`), /msgr_dm_required/, kind);
    assert.deepEqual(members(ch), before);
  }
});

test('RPC remains invoker and signed-in only; anon cannot access preference data', { skip }, () => {
  assert.equal(sql(`select prosecdef from pg_proc where oid = 'public.msgr_leave_dm(uuid)'::regprocedure`), 'f');
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_leave_dm(uuid)', 'EXECUTE')`), 'f');
  assert.equal(sql(`select has_function_privilege('authenticated', 'public.msgr_leave_dm(uuid)', 'EXECUTE')`), 't');
  fails(asUserRaw('', `select public.msgr_leave_dm(gen_random_uuid())`), /msgr_auth_required/, 'missing auth');
  fails(sqlRaw('set role anon; select * from public.msgr_target_prefs'), /permission denied/, 'anon prefs');
});
