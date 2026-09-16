// 여럿이 대화하고, 그 방에 에이전트를 부를 수 있어야 한다(유건 2026-09-16: "1:1 대화방 신설 기능과 대화방에 멤버 및 에이전트 초대 기능 필요").
// 종전에는 DM 정원 트리거가 사람 2·크루 1로 고정해, 셋이서 시작하는 대화조차 msgr_dm_full로 거절당했다(9/15에 만든 '새 그룹 대화'가 실제로는 실패).
// 사람을 더 부르는 길은 **새 방**이다 — 사적인 지난 대화가 제3자에게 통째로 넘어가지 않게(슬랙과 같다). 몰래 끼워 넣는 길은 종전대로 막혀 있어야 한다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-dm-invite-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-dm-invite-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', mate: '22222222-2222-4222-8222-222222222222', third: '33333333-3333-4333-8333-333333333333', stranger: '44444444-4444-4444-8444-444444444444' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 160)}`); };
const seats = (ch, kind) => sql(`select coalesce(string_agg(left(member_id::text,8), ',' order by member_id::text), '(없음)') from public.msgr_channel_members where channel_id = '${ch}' and member_kind = '${kind}'`);
const dm = (me, others) => last(asUser(me, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:방', '${JSON.stringify(others)}'::jsonb)`));

let ORG, CREW, CREW2;
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
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.mate, U.third]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status) values ('${ORG}', '${U.owner}', 'lean', 'ally', 'Ally', 'active') returning id`));
  CREW2 = last(asUser(U.mate, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status) values ('${ORG}', '${U.mate}', 'lean', 'buddy', 'Buddy', 'active') returning id`));
});

test('셋이서 시작하는 대화 — 만들 때부터 여럿이 들어간다', { skip }, () => {
  const ch = dm(U.owner, [{ kind: 'user', id: U.mate }, { kind: 'user', id: U.third }]);
  assert.match(ch, /^[0-9a-f-]{36}$/, `방이 만들어져야 한다 — 받은 값: ${ch}`);
  const list = seats(ch, 'user');
  for (const u of [U.owner, U.mate, U.third]) assert.ok(list.includes(u.slice(0, 8)), `${u.slice(0, 8)}가 들어가야 한다 (실제: ${list})`);
  assert.equal(asUser(U.third, `select count(*) from public.msgr_channels where id = '${ch}'`), '1', '함께 만든 사람은 그 방을 본다');
});

test('에이전트는 여럿 들어갈 수 있다 — 한 방에 한 명 제한이 없다', { skip }, () => {
  const ch = dm(U.owner, [{ kind: 'user', id: U.mate }, { kind: 'crew', id: CREW }, { kind: 'crew', id: CREW2 }]);
  assert.equal(seats(ch, 'crew').split(',').length, 2, `에이전트 둘 (실제: ${seats(ch, 'crew')})`);
});

test('대화 중인 방에 에이전트를 나중에 부른다 — 만든 사람이 아니어도 된다', { skip }, () => {
  const ch = dm(U.owner, [{ kind: 'user', id: U.mate }]);
  asUser(U.mate, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${CREW2}', '${U.mate}')`);
  assert.ok(seats(ch, 'crew').includes(CREW2.slice(0, 8)), '방에 있는 사람은 자기 에이전트를 부를 수 있다');
});

test('몰래 끼워 넣는 길은 없다 — 방 밖의 사람도, 방 안의 사람도 사람을 밀어 넣지 못한다', { skip }, () => {
  const ch = dm(U.owner, [{ kind: 'user', id: U.mate }]);
  fails(asUserRaw(U.third, `insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'user', '${U.third}')`), /row-level security|permission denied/, '방 밖의 사람이 스스로 들어오기');
  fails(asUserRaw(U.mate, `insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'user', '${U.third}')`), /row-level security|permission denied/, '방 안의 사람이 제3자를 끼워 넣기(사람은 새 방으로 부른다)');
  fails(asUserRaw(U.third, `insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'crew', '${CREW}')`), /row-level security|permission denied/, '방 밖의 사람이 에이전트 밀어 넣기');
  assert.equal(seats(ch, 'user').split(',').length, 2, '두 사람 그대로');
});

test('사람을 더 부르면 새 방 — 옛 방의 대화는 따라가지 않는다', { skip }, () => {
  const old = dm(U.owner, [{ kind: 'user', id: U.mate }]);
  asUser(U.owner, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${old}', 'user', '${U.owner}', 'text', '둘만의 이야기', gen_random_uuid()::text)`);
  const wider = dm(U.owner, [{ kind: 'user', id: U.mate }, { kind: 'user', id: U.third }]);
  assert.notEqual(wider, old, '새 방이 열린다');
  assert.equal(asUser(U.third, `select count(*) from public.msgr_messages where channel_id = '${old}'`), '0', '불려 온 사람은 옛 방의 대화를 보지 못한다');
  assert.equal(asUser(U.owner, `select count(*) from public.msgr_messages where channel_id = '${old}'`), '1', '옛 방은 그대로 남는다');
});

test('조직 밖 사람은 조직 대화방에 못 들어온다', { skip }, () => {
  fails(asUserRaw(U.owner, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:외부', '[{"kind":"user","id":"${U.stranger}"}]'::jsonb)`), /msgr_bad_member|msgr_forbidden|msgr_not_member/, '조직 밖 사람');
});

test('개인 1:1은 두 사람 그대로 — 한 쌍 한 방이 깨지지 않는다', { skip }, () => {
  for (const other of [U.mate, U.third]) sql(`insert into public.msgr_friends (a, b, status, requested_by, decided_at) values (least('${U.owner}'::uuid,'${other}'::uuid), greatest('${U.owner}'::uuid,'${other}'::uuid), 'accepted', '${U.owner}', now()) on conflict (a, b) do update set status = 'accepted'`);
  const ch = last(asUser(U.owner, `select public.msgr_dm_personal('${U.mate}')`));
  fails(asUserRaw(U.owner, `insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'user', '${U.third}')`), /msgr_dm_pair_only|row-level security/, '개인 1:1에 제3자');
  assert.equal(last(asUser(U.owner, `select public.msgr_dm_personal('${U.mate}')`)), ch, '한 쌍 한 방 그대로');
});
