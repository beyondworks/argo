// 개인 공간 1:1(조직 밖 dm 채널) — 친구만 열 수 있고, 한 상대에 한 방이며, 제3자는 못 읽는다.
// 조직 경로 회귀도 같이 본다(조직 DM·공개 채널·결제 잠금). 실행: bash scripts/billing-pg-drill.sh test/msgr-personal-dm-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-personal-dm-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
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

test('친구가 아니면 개인 1:1이 열리지 않는다', { skip }, () => {
  fails(asUserRaw(U.a, `select public.msgr_dm_personal('${U.c}')`), /msgr_not_friend/, '친구 아님');
  fails(asUserRaw(U.a, `select public.msgr_dm_personal('${U.a}')`), /msgr_bad_target/, '자기 자신');
});

test('친구면 조직 없이 1:1이 열리고, 한 상대에 한 방이다(멱등)', { skip }, () => {
  asUser(U.a, `select public.msgr_friend_request('${U.c}')`); // a → c 요청
  assert.equal(last(asUser(U.c, `select public.msgr_friend_decide('${U.a}', true)`)), 'friend');
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  assert.match(ch, /^[0-9a-f-]{36}$/, '채널이 만들어진다');
  assert.equal(sql(`select coalesce(org_id::text, 'NULL') from public.msgr_channels where id = '${ch}'`), 'NULL', '조직에 묶이지 않는다');
  assert.equal(last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`)), ch, '다시 열어도 같은 방');
  assert.equal(last(asUser(U.c, `select public.msgr_dm_personal('${U.a}')`)), ch, '상대가 열어도 같은 방');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}'`), '2', '둘만의 방');
});

test('두 사람은 주고받고, 제3자는 읽지도 쓰지도 못한다', { skip }, () => {
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  const m1 = post(U.a, ch, '개인 인사');
  const m2 = post(U.c, ch, '개인 답');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_messages where channel_id = '${ch}'`), '2', '보낸 사람이 본다');
  assert.equal(asUser(U.c, `select count(*) from public.msgr_messages where channel_id = '${ch}'`), '2', '받은 사람도 본다');
  assert.equal(sql(`select coalesce(org_id::text, 'NULL') from public.msgr_messages where id = '${m1}'`), 'NULL', '메시지도 조직 밖');
  assert.equal(asUser(U.b, `select count(*) from public.msgr_messages where channel_id = '${ch}'`), '0', '제3자는 못 읽는다(RLS)');
  assert.equal(asUser(U.b, `select count(*) from public.msgr_channels where id = '${ch}'`), '0', '방 자체가 안 보인다');
  fails(postRaw(U.b, ch, '끼어들기'), /row-level security|msgr_/, '제3자는 못 쓴다');
  assert.ok(Number(m2) > Number(m1));
});

test('개인 1:1 목록은 내 방만, 최근 순으로 준다', { skip }, () => {
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  const rows = (uid) => asUser(uid, `select channel_id||'|'||other_user_id from public.msgr_dm_personal_list()`).split('\n').filter(Boolean);
  assert.deepEqual(rows(U.a), [`${ch}|${U.c}`], 'a의 목록에는 c와의 방');
  assert.deepEqual(rows(U.c), [`${ch}|${U.a}`], 'c의 목록에는 a와의 방');
  assert.deepEqual(rows(U.b), [], '남의 방은 안 나온다');
});

test('조직 경로 회귀 — 조직 DM은 종전대로, 결제 잠금은 개인 1:1을 막지 않는다', { skip }, () => {
  const om = post(U.a, ORG_DM, '업무 메시지');
  assert.equal(sql(`select org_id::text from public.msgr_messages where id = '${om}'`), ORG, '조직 메시지는 조직에 묶인다');
  assert.equal(asUser(U.b, `select count(*) from public.msgr_messages where id = '${om}'`), '1', '조직 동료는 읽는다');
  assert.equal(asUser(U.c, `select count(*) from public.msgr_messages where id = '${om}'`), '0', '조직 밖 사람은 못 읽는다');
  // 결제 연체로 조직을 잠근다 — 조직 채널은 읽기 전용, 개인 1:1은 영향 없음
  sql(`update public.msgr_org_entitlements set ls_status = 'past_due' where org_id = '${ORG}'`);
  assert.equal(asUser(U.a, `select public.msgr_org_locked('${ORG}')`), 't', '조직이 잠긴다');
  fails(postRaw(U.a, ORG_DM, '잠긴 뒤'), /row-level security|msgr_/, '잠긴 조직에는 못 쓴다');
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  assert.match(post(U.a, ch, '개인은 계속'), /^\d+$/, '개인 1:1은 그대로 쓰인다');
  sql(`update public.msgr_org_entitlements set ls_status = null where org_id = '${ORG}'`);
});

test('없는 채널에는 못 쓴다 — 쓰기 게이트가 먼저 막는다(종전 그대로)', { skip }, () => {
  // msgr_message_fill의 'org 없는 채널' 허용이 '없는 채널'까지 열어 주지 않는지 확인한다(가드 분리의 핵심).
  fails(postRaw(U.a, '00000000-0000-4000-8000-000000000000', '유령'), /msgr_not_allowed|msgr_channel_missing|row-level security/, '없는 채널');
});

test('개인 1:1은 채널 목록(RLS select)에도 보인다 — 목록에서 빠지면 방을 열 수 없다', { skip }, () => {
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  assert.equal(asUser(U.a, `select count(*) from public.msgr_channels where id = '${ch}'`), '1', '참가자에게 보인다');
  assert.equal(asUser(U.c, `select count(*) from public.msgr_channels where id = '${ch}'`), '1', '상대에게도 보인다');
  assert.equal(asUser(U.b, `select count(*) from public.msgr_channels where id = '${ch}'`), '0', '남에게는 안 보인다');
});

test('안 읽음 — 개인 공간(org=null)도 센다', { skip }, () => {
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  const unread = (uid) => Number(asUser(uid, `select coalesce((select n from public.msgr_unread(null) where channel_id = '${ch}'), 0)`));
  const beforeC = unread(U.c); const beforeA = unread(U.a);
  post(U.a, ch, '안 읽음 세기');
  assert.equal(unread(U.c), beforeC + 1, '상대의 안 읽음이 하나 는다');
  assert.equal(unread(U.a), beforeA, '내가 쓴 글은 내 안 읽음을 늘리지 않는다');
});

test('나가기 — 조직 밖 방도 나갈 수 있고, 다시 열면 갈라지지 않고 같은 방으로 돌아온다', { skip }, () => {
  const ch = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  assert.equal(last(asUser(U.c, `select public.msgr_leave_dm('${ch}')`)), 't', '나가진다(종전에는 42501로 막혔다)');
  assert.equal(asUser(U.c, `select count(*) from public.msgr_channels where id = '${ch}'`), '0', '나간 뒤에는 안 보인다');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_channels where id = '${ch}'`), '1', '남은 사람의 방은 그대로다');
  assert.equal(last(asUser(U.c, `select public.msgr_dm_personal('${U.a}')`)), ch, '다시 열면 같은 방(짝 기록)');
  assert.equal(sql(`select count(*) from public.msgr_channels where personal_pair is not null`), '1', '한 쌍에 방 하나');
});

test('계정 삭제 — 개인 1:1을 만든 사람도 삭제된다(FK가 막지 않는다)', { skip }, () => {
  asUser(U.d, `select public.msgr_friend_request('${U.a}')`);
  assert.equal(last(asUser(U.a, `select public.msgr_friend_decide('${U.d}', true)`)), 'friend');
  const ch = last(asUser(U.d, `select public.msgr_dm_personal('${U.a}')`)); // d가 만든 방
  assert.equal(sql(`select created_by::text from public.msgr_channels where id = '${ch}'`), U.d);
  asUser(U.d, 'select public.msgr_delete_me()');
  sql(`delete from auth.users where id = '${U.d}'`); // 실패하면 여기서 psql 오류로 터진다
  assert.equal(sql(`select count(*) from auth.users where id = '${U.d}'`), '0', '계정이 지워졌다');
  assert.equal(sql(`select coalesce((select created_by::text from public.msgr_channels where id = '${ch}'), 'GONE')`), U.a, '남은 상대가 방의 작성자가 된다');
});
