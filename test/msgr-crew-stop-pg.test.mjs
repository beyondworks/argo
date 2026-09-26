// 크루 작업 중단(유건 확정 2026-09-26) — msgr_request_stop의 권한 경계를 실 Postgres에서 검증.
// 권한: 그 턴을 시킨 사람(원본 메시지 작성자 — 크루 넘김이면 그 크루의 주인) 또는 지금 실행 중인 크루의 주인만.
// 중복 요청·완료된 실행·anon은 쓰기 0. 실행: `bash scripts/billing-pg-drill.sh test/msgr-crew-stop-pg.test.mjs`.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-stop-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  ownerA: '11111111-1111-4111-8111-111111111111', // CREW_A(지금 실행 중)의 주인
  ownerB: '22222222-2222-4222-8222-222222222222', // CREW_B(넘김 원본 글의 작성자)의 주인
  requester: '33333333-3333-4333-8333-333333333333', // M1을 직접 쓴 사람 — 시킨 사람
  other: '44444444-4444-4444-8444-444444444444', // 같은 채널의 무관한 제3자 — 거부돼야 함
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저(RLS 우회) — 시드·관찰 전용
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, PUB, CREW_A, CREW_B;
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
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  // 배포될 모든 msgr 마이그레이션을 라이브와 같은 순서로(msgr-dm-latest-pg.test.mjs 관례) — 새 파일을 여기 손으로 추가하지 않아도 된다.
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${id}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.ownerA, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean-stop', '${U.ownerA}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.ownerB, U.requester, U.other]) {
    const code = last(asUser(U.ownerA, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.ownerA}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  PUB = last(asUser(U.ownerA, `select public.msgr_create_channel('${ORG}', 'public', 'general')`));
  CREW_A = last(asUser(U.ownerA, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status) values ('${ORG}', '${U.ownerA}', 'lean-ax-a', 'seoyun', '서윤', 'active') returning id`));
  CREW_B = last(asUser(U.ownerB, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status) values ('${ORG}', '${U.ownerB}', 'lean-ax-b', 'zed', '제드', 'active') returning id`));
});

// msgr_request_stop 자체는 msgr_executions 행만 보므로, 배달 경로(msgr_delivery_allowed 등— 다른 pg 테스트가 이미 잠근다)를
// 다시 세팅하지 않고 실행 행을 superuser로 직접 심는다. 이 파일의 관심은 오직 "누가 멈출 수 있나"다.
const seedExec = (crew, source, state = 'running') => sql(`insert into public.msgr_executions (crew_id, source_msg_id, attempt, state) values ('${crew}', ${source}, gen_random_uuid(), '${state}')`);
const stopInfo = (crew, source) => sql(`select coalesce(stop_requested_by::text,'') || '|' || coalesce(stop_requested_at::text,'') from public.msgr_executions where crew_id = '${crew}' and source_msg_id = ${source}`);
const sentCount = () => Number(sql(`select count(*) from realtime.sent where event = 'stop_request'`));

test('원본 메시지 작성자(시킨 사람)는 실행 중인 턴을 중단할 수 있다 — 방송 1건', { skip }, () => {
  const M1 = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.requester}', '@서윤 시작') returning id`));
  seedExec(CREW_A, M1);
  sql('delete from realtime.sent');
  assert.equal(asUser(U.requester, `select public.msgr_request_stop('${CREW_A}', ${M1})`), 't');
  const [by, at] = stopInfo(CREW_A, M1).split('|');
  assert.equal(by, U.requester); assert.notEqual(at, '');
  assert.equal(sentCount(), 1, '방송 1건');
  assert.equal(sql(`select topic || '|' || (payload->>'crew_id') || '|' || (payload->>'source_msg_id') from realtime.sent where event = 'stop_request'`), `org:${ORG}|${CREW_A}|${M1}`);
});

test('같은 실행을 다시 요청해도(주인이 뒤이어 눌러도) 쓰기·방송은 0 — 최초 요청자 기록이 남는다', { skip }, () => {
  const M2 = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.requester}', '@서윤 둘째') returning id`));
  seedExec(CREW_A, M2);
  assert.equal(asUser(U.requester, `select public.msgr_request_stop('${CREW_A}', ${M2})`), 't', '첫 요청');
  sql('delete from realtime.sent');
  const before = stopInfo(CREW_A, M2);
  assert.equal(asUser(U.ownerA, `select public.msgr_request_stop('${CREW_A}', ${M2})`), 't', '크루 주인의 재요청도 true(이미 멈췄다는 뜻)');
  assert.equal(stopInfo(CREW_A, M2), before, 'stop_requested_by/at 변경 없음 — 최초 요청자가 정본');
  assert.equal(sentCount(), 0, '중복 요청은 방송도 0');
});

test('크루 주인은 어떤 원본 메시지의 실행이든 중단할 수 있다', { skip }, () => {
  const M3 = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.requester}', '@서윤 셋째') returning id`));
  seedExec(CREW_A, M3);
  assert.equal(asUser(U.ownerA, `select public.msgr_request_stop('${CREW_A}', ${M3})`), 't');
  const [by] = stopInfo(CREW_A, M3).split('|');
  assert.equal(by, U.ownerA);
});

test('크루 넘김 글이 원본이면 그 크루(넘긴 쪽)의 주인도 "시킨 사람"으로 중단할 수 있다', { skip }, () => {
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PUB}', 'crew', '${CREW_B}', '${U.ownerB}') on conflict do nothing`); // 공개 채널도 참여 행이 있어야 크루 글이 트리거를 통과한다
  const root = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.requester}', '@제드 시작') returning id`));
  // 크루 넘김 글(제드 → 서윤) — client_msg_id 없이 심어 msgr_crew_reply_gate를 타지 않는다(이 파일의 관심은 msgr_request_stop 하나).
  const handoff = last(sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, thread_root, body) values ('${PUB}', 'crew', '${CREW_B}', ${root}, '@서윤 넘김') returning id`));
  seedExec(CREW_A, handoff);
  // 이 넘김과 무관한 requester(뿌리 글쓴이일 뿐 이 실행의 sender는 아니다)는 거부된다 — sender는 "원본 메시지(handoff)의 작성자" 규칙대로 제드의 주인이다.
  const deniedRoot = asUserRaw(U.requester, `select public.msgr_request_stop('${CREW_A}', ${handoff})`);
  assert.notEqual(deniedRoot.status, 0, '뿌리 글쓴이는 이 실행의 sender가 아니다(원본은 넘김 글)');
  assert.equal(asUser(U.ownerB, `select public.msgr_request_stop('${CREW_A}', ${handoff})`), 't', '넘긴 크루(제드)의 주인이 시킨 사람');
  const [by] = stopInfo(CREW_A, handoff).split('|');
  assert.equal(by, U.ownerB);
});

test('무관한 제3자·anon은 거부된다(권한 판정이 실행 존재 여부보다 먼저)', { skip }, () => {
  const M4 = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.requester}', '@서윤 넷째') returning id`));
  seedExec(CREW_A, M4);
  const denied = asUserRaw(U.other, `select public.msgr_request_stop('${CREW_A}', ${M4})`);
  assert.notEqual(denied.status, 0, '무관한 제3자는 거부');
  assert.match(denied.stderr, /msgr_not_allowed/);
  const anon = psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_request_stop('${CREW_A}', ${M4})`]);
  assert.notEqual(anon.status, 0, 'anon은 실행 자체가 안 됨');
  assert.equal(stopInfo(CREW_A, M4), '|', '거부된 시도는 쓰기 없음');
});

test('완료된 실행은 조용히 무시(false) — 쓰기·방송 없음', { skip }, () => {
  const M5 = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.requester}', '@서윤 다섯째') returning id`));
  seedExec(CREW_A, M5, 'completed');
  sql('delete from realtime.sent');
  assert.equal(asUser(U.ownerA, `select public.msgr_request_stop('${CREW_A}', ${M5})`), 'f');
  assert.equal(stopInfo(CREW_A, M5), '|', '완료된 실행은 손대지 않는다');
  assert.equal(sentCount(), 0);
});
