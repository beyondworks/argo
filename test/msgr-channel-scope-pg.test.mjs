// 채널 범위 서버 강제(20260911230000_msgr_channel_scope_enforce.sql) 실행 검증 — 유건 원칙 2026-09-11: 채널에 초대된 에이전트만 답하고,
// 내보낸 에이전트는 못 답한다. 앱의 멘션 후보·노드 drain 게이트는 반쪽이라 크루 글의 insert 자체를 트리거가 거부하는지 실제 Postgres에서 돈다.
// 하네스는 msgr-pg-integration.test.mjs와 같다(auth.uid() 스텁 + set role). ARGO_PG_TEST_URL 미설정이면 skip.
// 실행: `npm run test:pg` (scripts/billing-pg-drill.sh — 파일마다 별도 임시 DB).
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

let ORG, PUB, PRIV, CREW, ZED, M1;
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
    '20260911150000_msgr_channel_manage.sql', '20260911230000_msgr_channel_scope_enforce.sql']) psql(['-f', mig(f)]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member']]) {
    sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG, `초대 수락 ${role}`);
  }
  PUB = last(asUser(U.owner, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'public', 'general', '${U.owner}') returning id`));
  PRIV = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}', 'private', 'secret')`)); // 만든 사람(admin)이 첫 멤버
  CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean-ax-abcd', 'seoyun', '서윤') returning id`));
  ZED = last(asUser(U.admin, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.admin}', 'lean-ax-zed', 'zed', '제드') returning id`));
  M1 = last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.member}', '@서윤 시작') returning id`));
});

const crewInsert = (ch, crew, body) => `insert into public.msgr_messages (channel_id, author_kind, crew_id, body) values ('${ch}', 'crew', '${crew}', '${body}') returning id`;
const RE = /msgr_crew_not_in_channel/;

test('비공개 채널: 구성원 아닌 크루 글은 트리거가 거부(RLS를 우회하는 슈퍼유저도) → 초대 뒤 허용 → 내보내면(구성원 행 삭제) 다시 거부', { skip }, () => {
  fails(sqlRaw(crewInsert(PRIV, CREW, '초대 전')), RE, '비구성원 크루');
  assert.equal(sql(`select count(*) from public.msgr_messages where channel_id = '${PRIV}' and crew_id = '${CREW}'`), '0', '행이 남지 않는다');
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${CREW}', '${U.admin}')`);
  assert.match(last(sql(crewInsert(PRIV, CREW, '초대 뒤'))), /^\d+$/, '구성원 크루');
  sql(`delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'crew' and member_id = '${CREW}'`);
  fails(sqlRaw(crewInsert(PRIV, CREW, '내보낸 뒤')), RE, '내보낸 크루는 다시 거부');
  assert.match(sqlRaw(crewInsert(PRIV, CREW, 'x')).stderr, /이 채널에 초대되지 않았거나 내보낸 에이전트입니다/, 'hint 문구');
});

test('공개 채널: 제외 목록의 크루는 거부, 목록에서 빼면 허용, 다른 크루·사람 글은 무관', { skip }, () => {
  assert.match(last(sql(crewInsert(PUB, CREW, '제외 전'))), /^\d+$/);
  sql(`update public.msgr_channels set excluded_crew_ids = array['${CREW}'::uuid] where id = '${PUB}'`);
  fails(sqlRaw(crewInsert(PUB, CREW, '제외 중')), RE, '내보낸 크루');
  assert.match(last(sql(crewInsert(PUB, ZED, '다른 크루'))), /^\d+$/, '제외되지 않은 크루는 그대로');
  assert.match(last(asUser(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.admin}', '사람 글') returning id`)), /^\d+$/, '사람 글은 트리거 무관');
  sql(`update public.msgr_channels set excluded_crew_ids = '{}' where id = '${PUB}'`);
  assert.match(last(sql(crewInsert(PUB, CREW, '복귀'))), /^\d+$/, '목록에서 빼면 허용');
});

test('사용자 역할(크루 소유자)의 정상 답글 경로도 같은 트리거를 지난다 — 제외 중이면 RLS보다 먼저 msgr_crew_not_in_channel, 풀면 허용', { skip }, () => {
  const reply = (tag) => `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, client_msg_id, reply_to) values ('${PUB}', 'crew', '${CREW}', '답변', 'reply:${CREW}:${M1}:${tag}', ${M1}) returning id`;
  sql(`update public.msgr_channels set excluded_crew_ids = array['${CREW}'::uuid] where id = '${PUB}'`);
  fails(asUserRaw(U.member, reply('a')), RE, '소유자 세션의 답글도 거부(함수가 authenticated에서 실행 가능한지 겸검)');
  sql(`update public.msgr_channels set excluded_crew_ids = '{}' where id = '${PUB}'`);
  assert.match(last(asUser(U.member, reply('b'))), /^\d+$/, '풀면 답글 허용');
});

test('함수 권한: msgr_crew_in_channel은 authenticated만 실행, anon·public 불가', { skip }, () => {
  assert.equal(sql(`select has_function_privilege('authenticated', 'public.msgr_crew_in_channel(uuid, uuid)', 'EXECUTE')`), 't');
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_crew_in_channel(uuid, uuid)', 'EXECUTE')`), 'f');
});
