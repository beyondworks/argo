// 조직에 들어왔다고 모든 채널이 열리지 않는다(유건 2026-09-16, 슬랙식) — 참여 기준 알림·찾아보기·백필.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-channel-join-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-channel-join-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', writer: '22222222-2222-4222-8222-222222222222', guest: '33333333-3333-4333-8333-333333333333' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 160)}`); };
const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));
const recipients = (mid) => sql(`select coalesce(string_agg(left(u::text, 8), ',' order by u::text), '(없음)') from public.msgr_push_recipients((select m from public.msgr_messages m where m.id = ${mid})) u`).trim();

let ORG, PUB, OLD_PUB;
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
  const files = readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort();
  const JOIN = '20260916190000_msgr_channel_join.sql';
  // 백필을 실제로 태우려면 **그 마이그레이션 전에** 옛 상태(멤버 행 없는 공개 채널 + 글)를 만들어야 한다.
  for (const f of files.filter((x) => x !== JOIN)) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.writer, U.guest]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  OLD_PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Crew')`));
  post(U.writer, OLD_PUB, '옛 채널에 남긴 글'); // writer는 쓰던 사람 — 백필 대상
  sql(`delete from public.msgr_channel_members where channel_id = '${OLD_PUB}'`); // 옛 공개 채널 상태 재현(멤버 행 없음)
  psql(['-c', readFileSync(mig(JOIN), 'utf8')]); // ← 여기서 백필이 돈다
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','New')`));
});

test('백필 — 쓰던 사람과 관리자는 그대로 남고, 구경만 하던 조직원은 빠진다', { skip }, () => {
  const members = sql(`select coalesce(string_agg(left(member_id::text,8), ',' order by member_id::text), '(없음)') from public.msgr_channel_members where channel_id = '${OLD_PUB}' and member_kind='user'`);
  assert.ok(members.includes(U.writer.slice(0, 8)), '글을 쓴 사람은 남는다');
  assert.ok(members.includes(U.owner.slice(0, 8)), '조직 소유자는 남는다');
  assert.ok(!members.includes(U.guest.slice(0, 8)), '들어온 적 없는 조직원은 빠진다');
});

test('알림 — 참여한 사람에게만 간다(조직원 전원 아님)', { skip }, () => {
  const m = post(U.owner, OLD_PUB, '공지');
  assert.equal(recipients(m), U.writer.slice(0, 8), '참여자만');
  assert.equal(asUser(U.guest, `select count(*) from public.msgr_messages where id = ${m}`), '1', '공개 채널이라 열람은 여전히 된다(슬랙식)');
});

test('찾아보기 — 안 들어간 공개 채널이 보이고, 참여하면 목록에서 빠진다', { skip }, () => {
  const rows = () => asUser(U.guest, `select coalesce(string_agg(name, ',' order by name), '(없음)') from public.msgr_browse_channels('${ORG}')`);
  assert.equal(rows(), 'Crew,New', '두 채널 모두 후보');
  assert.equal(last(asUser(U.guest, `select public.msgr_join_channel('${OLD_PUB}')`)), 't');
  assert.equal(rows(), 'New', '참여한 채널은 후보에서 빠진다');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id='${OLD_PUB}' and member_id='${U.guest}'`), '1');
  assert.equal(last(asUser(U.guest, `select public.msgr_join_channel('${OLD_PUB}')`)), 't', '두 번 눌러도 한 행(멱등)');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id='${OLD_PUB}' and member_id='${U.guest}'`), '1');
  const m = post(U.owner, OLD_PUB, '참여 뒤 공지');
  assert.ok(recipients(m).includes(U.guest.slice(0, 8)), '참여했으니 이제 알림이 간다');
});

test('참여는 공개 채널만 — 비공개·제외·남의 조직은 거절', { skip }, () => {
  const priv = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','private','Secret')`));
  fails(asUserRaw(U.guest, `select public.msgr_join_channel('${priv}')`), /msgr_public_only/, '비공개는 초대로만');
  sql(`update public.msgr_channels set excluded_user_ids = array['${U.guest}']::uuid[] where id = '${PUB}'`);
  fails(asUserRaw(U.guest, `select public.msgr_join_channel('${PUB}')`), /msgr_forbidden/, '제외된 사람');
  assert.equal(asUser(U.guest, `select coalesce(string_agg(name, ','), '(없음)') from public.msgr_browse_channels('${ORG}')`), '(없음)', '제외된 채널은 후보에도 없다');
  sql(`update public.msgr_channels set excluded_user_ids = '{}'::uuid[] where id = '${PUB}'`);
});

test('나가면 목록과 알림에서 빠진다', { skip }, () => {
  asUser(U.guest, `delete from public.msgr_channel_members where channel_id = '${OLD_PUB}' and member_kind='user' and member_id = '${U.guest}'`);
  const m = post(U.owner, OLD_PUB, '나간 뒤 공지');
  assert.ok(!recipients(m).includes(U.guest.slice(0, 8)), '나간 사람에게는 알림이 없다');
  assert.ok(asUser(U.guest, `select coalesce(string_agg(name, ',' order by name), '(없음)') from public.msgr_browse_channels('${ORG}')`).includes('Crew'), '다시 찾아보기 후보로 돌아온다');
});
