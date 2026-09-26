// 크루 작업 중단(유건 확정 2026-09-26, 분리 검수·화면 QA 반영) — msgr_request_stop의 권한 경계를 실 Postgres에서 검증.
// 권한: 그 턴을 시킨 사람(원본 메시지 작성자 — 크루 넘김이면 넘긴 크루의 주인 + 스레드 뿌리의 최초 지시자, L-6) 또는
// 지금 실행 중인 크루의 주인만. 원본 작성자·뿌리 지시자는 지금도 조직 멤버이고 채널을 읽을 수 있어야 한다(L-1).
// 봇 크루는 false만(L-2). 방송은 u:<owner_user_id>로만(H-1 — org:는 그 조직 누구나 위조 방송을 보낼 수 있었다).
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
  departing: '55555555-5555-4555-8555-555555555555', // 지시할 때는 멤버였다가 나가는 사람(L-1)
  crossOrgOwner: '66666666-6666-4666-8666-666666666666', // 다른 조직의 주인(L-7: 다른 조직 요청 거부)
  crossOrgMember: '77777777-7777-4777-8777-777777777777', // 다른 조직의 정상 멤버 — ORG는 남이다
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저(RLS 우회) — 시드·관찰 전용
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, PUB, PRIV, CREW_A, CREW_B, ORG2, CREW_BOT;
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
  for (const u of [U.ownerB, U.requester, U.other, U.departing]) {
    const code = last(asUser(U.ownerA, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.ownerA}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  PUB = last(asUser(U.ownerA, `select public.msgr_create_channel('${ORG}', 'public', 'general')`));
  PRIV = last(asUser(U.ownerA, `select public.msgr_create_channel('${ORG}', 'private', 'secret', '[{"kind":"user","id":"${U.requester}"}]'::jsonb)`)); // L-7: 비공개 방에서도 방송이 u:인지
  CREW_A = last(asUser(U.ownerA, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status) values ('${ORG}', '${U.ownerA}', 'lean-ax-a', 'seoyun', '서윤', 'active') returning id`));
  CREW_B = last(asUser(U.ownerB, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status) values ('${ORG}', '${U.ownerB}', 'lean-ax-b', 'zed', '제드', 'active') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PUB}', 'crew', '${CREW_A}', '${U.ownerA}') on conflict do nothing`); // msgr_crew_in_channel(공개도 참여 행 필요) — 심박 실증(msgr_execution_claim 왕복)에 필요
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PUB}', 'crew', '${CREW_B}', '${U.ownerB}') on conflict do nothing`); // 넘김(M-A) 테스트들 — 공개 채널도 참여 행이 있어야 크루 글이 트리거를 통과한다
  // L-7: 다른 조직 — ORG와 무관한 회사. crossOrgMember는 여기서는 진짜 멤버지만 ORG에서는 남이다.
  ORG2 = last(asUser(U.crossOrgOwner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'lean-stop-other', '${U.crossOrgOwner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG2}'`);
  const code2 = last(asUser(U.crossOrgOwner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG2}', 'member', '${U.crossOrgOwner}') returning code`));
  assert.equal(last(asUser(U.crossOrgMember, `select public.msgr_accept_invite('${code2}')`)), ORG2);
  // L-2: 봇 크루 — 서버 봇(Hermes·OpenClaw·VPS) 턴은 이번 범위 밖. 봇 크루는 msgr_bot_create()로만 만들 수 있다(msgr_crews_bot_guard).
  // 소유자는 만든 사람(조직 주인 ownerA) — 이 파일의 관심은 hosting='bot' 판정 하나라 별도 소유자를 두지 않는다.
  CREW_BOT = asUser(U.ownerA, `select (public.msgr_bot_create('${ORG}', 'custom', '헤르메스'))->>'crew_id'`);
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
  // H-1: org:<조직>이 아니라 크루 주인 본인의 u:<uid>로 — org:는 그 조직 멤버 누구나 msgr_realtime_send로 보낼 수 있어 위조 가능했다.
  assert.equal(sql(`select topic || '|' || (payload->>'crew_id') || '|' || (payload->>'source_msg_id') from realtime.sent where event = 'stop_request'`), `u:${U.ownerA}|${CREW_A}|${M1}`);
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

// 재검수 2026-09-26 M-A: 넘김 턴의 "시킨 사람" = 원 지시자(src.meta->>'origin', 브리지가 답글에 새기는 값)다.
// "넘긴 크루의 주인" 자체는 더 이상 허용자가 아니다 — 유건님 규칙은 "시킨 사람과 크루 주인만"이고 넘긴 크루의 주인은 둘 다 아니다.
test('넘김 턴은 원 지시자(meta.origin)가 중단할 수 있고, 그 턴과 무관한 멤버는 거부된다(M-A)', { skip }, () => {
  // 뿌리는 other가 썼지만(뿌리 작성자와 원 지시자가 다른 경우를 명확히 보이기 위해) 이 턴을 실제로 처음 지시한 사람은 requester라고 본다.
  const root = last(asUser(U.other, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.other}', '@제드 M-A 시작') returning id`));
  const handoff = last(sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, thread_root, meta, body) values ('${PUB}', 'crew', '${CREW_B}', ${root}, jsonb_build_object('origin', '${U.requester}'), '@서윤 M-A 넘김') returning id`));
  seedExec(CREW_A, handoff);
  const deniedOwnerB = asUserRaw(U.ownerB, `select public.msgr_request_stop('${CREW_A}', ${handoff})`);
  assert.notEqual(deniedOwnerB.status, 0, '넘긴 크루(제드)의 주인이라도 원 지시자·루트 작성자가 아니면 거부(예전 sender=넘긴 크루 주인 규칙 폐기)');
  assert.equal(asUser(U.requester, `select public.msgr_request_stop('${CREW_A}', ${handoff})`), 't', '원 지시자(meta.origin)는 중단할 수 있다');
  const [by] = stopInfo(CREW_A, handoff).split('|');
  assert.equal(by, U.requester);
});

test('넘김 턴의 스레드 뿌리 작성자는 원 지시자와 달라도 계속 중단할 수 있다(M-A)', { skip }, () => {
  const root = last(asUser(U.other, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.other}', '@제드 M-A 둘째 시작') returning id`));
  const handoff = last(sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, thread_root, meta, body) values ('${PUB}', 'crew', '${CREW_B}', ${root}, jsonb_build_object('origin', '${U.requester}'), '@서윤 M-A 둘째 넘김') returning id`));
  seedExec(CREW_A, handoff);
  assert.equal(asUser(U.other, `select public.msgr_request_stop('${CREW_A}', ${handoff})`), 't', '루트 작성자(other)는 원 지시자(requester)와 달라도 시킨 사람이다');
});

// 경계 예시(총괄 확인 2026-09-26): meta.origin이 없으면(관례가 생기기 전 옛 글 등) sender는 null로 두고 거부한다 —
// 넘긴 크루(제드)의 주인이라는 이유만으로는 더 이상 통과하지 못한다는 것을 직접 보인다.
test('meta.origin이 없는 넘김 글은 넘긴 크루(제드)의 주인이라도 거부된다(M-A 경계 예시)', { skip }, () => {
  const root = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.requester}', '@제드 M-A 셋째 시작') returning id`));
  const handoff = last(sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, thread_root, body) values ('${PUB}', 'crew', '${CREW_B}', ${root}, '@서윤 M-A 셋째 넘김') returning id`)); // meta 생략 — 기본값 '{}', origin 없음
  seedExec(CREW_A, handoff);
  const deniedOwnerB = asUserRaw(U.ownerB, `select public.msgr_request_stop('${CREW_A}', ${handoff})`);
  assert.notEqual(deniedOwnerB.status, 0, 'meta.origin이 없으면 넘긴 크루의 주인도 거부 — 폴백 없음');
  assert.equal(stopInfo(CREW_A, handoff), '|', '거부된 시도는 쓰기 없음');
  assert.equal(asUser(U.requester, `select public.msgr_request_stop('${CREW_A}', ${handoff})`), 't', '대조: 루트 작성자(requester)는 origin이 없어도 여전히 허용된다');
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

// L-7: 다른 조직의 요청은 거부 — crossOrgMember는 실제로 어딘가의(ORG2) 정상 멤버지만 ORG에서는 남이다.
test('다른 조직의(그 조직에서는 정상 멤버인) 사람의 요청은 거부된다', { skip }, () => {
  const M6 = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.requester}', '@서윤 여섯째') returning id`));
  seedExec(CREW_A, M6);
  const deniedMember = asUserRaw(U.crossOrgMember, `select public.msgr_request_stop('${CREW_A}', ${M6})`);
  assert.notEqual(deniedMember.status, 0, '다른 조직의 정상 멤버도 ORG 크루는 못 멈춘다');
  const deniedOwner = asUserRaw(U.crossOrgOwner, `select public.msgr_request_stop('${CREW_A}', ${M6})`);
  assert.notEqual(deniedOwner.status, 0, '다른 조직의 주인도 마찬가지');
  assert.equal(stopInfo(CREW_A, M6), '|', '거부된 시도는 쓰기 없음');
});

// L-7: 지시할 때는 조직 멤버였다가 나간 사람은 옛 지시로도 멈출 수 없다(L-1).
test('원본 작성자가 조직을 나간 뒤에는 그 사람의 요청이 거부된다', { skip }, () => {
  const M7 = last(asUser(U.departing, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.departing}', '@서윤 일곱째') returning id`));
  seedExec(CREW_A, M7);
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.departing}'`);
  try {
    const denied = asUserRaw(U.departing, `select public.msgr_request_stop('${CREW_A}', ${M7})`);
    assert.notEqual(denied.status, 0, '나간 멤버는 자기가 시킨 일도 더 이상 멈출 수 없다');
    assert.equal(stopInfo(CREW_A, M7), '|', '거부된 시도는 쓰기 없음');
    // 대조: 크루 주인은 원본 작성자의 조직 소속과 무관하게 여전히 멈출 수 있다.
    assert.equal(asUser(U.ownerA, `select public.msgr_request_stop('${CREW_A}', ${M7})`), 't', '크루 주인은 언제나 멈출 수 있다');
  } finally {
    sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}' and user_id = '${U.departing}'`); // 이 파일의 다른 테스트에 영향 없게 복구
  }
});

// L-2: 봇 크루(hosting='bot')는 이번 범위 밖 — 주인이 요청해도 false, 기록·방송 없음.
test('봇 크루(hosting=bot)는 항상 false — 이번 범위 밖(L-2), 주인이 불러도 기록·방송 없음', { skip }, () => {
  const M8 = last(asUser(U.other, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.other}', '@헤르메스 여덟째') returning id`));
  seedExec(CREW_BOT, M8);
  sql('delete from realtime.sent');
  assert.equal(asUser(U.ownerA, `select public.msgr_request_stop('${CREW_BOT}', ${M8})`), 'f', '봇 크루의 주인이 불러도 false');
  assert.equal(stopInfo(CREW_BOT, M8), '|', '기록 없음');
  assert.equal(sentCount(), 0, '방송 없음');
});

// 재검수 2026-09-26 L-a: 봇 여부 확인은 권한 검사 뒤에 있어야 한다 — 권한 없는 호출자가 "false(=봇이다)"와
// "예외(=이 크루는 봇이 아니거나 권한이 없다)"를 구분해 크루가 봇인지 캐낼 수 있으면 안 된다.
test('권한 없는 호출자는 봇 크루에도 예외를 받는다 — false로 봇 여부를 알아낼 수 없다(L-a)', { skip }, () => {
  const M8b = last(asUser(U.other, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.other}', '@헤르메스 여덟째의둘') returning id`));
  seedExec(CREW_BOT, M8b);
  const denied = asUserRaw(U.requester, `select public.msgr_request_stop('${CREW_BOT}', ${M8b})`); // requester는 주인도 아니고 이 글의 시킨 사람도 아니다
  assert.notEqual(denied.status, 0, '권한 없는 호출자는 예외를 받는다(false가 아니다) — 봇 여부를 탐지 못하게');
  assert.match(denied.stderr, /msgr_not_allowed/);
});

// L-7: 새 jsonb 심박 — 실제 claim→heartbeat 왕복으로 {ok, stop_requested} 모양과 값을 확인한다.
test('msgr_execution_heartbeat는 {ok, stop_requested} jsonb를 돌려주고, 중단 요청 뒤에는 stop_requested=true', { skip }, () => {
  const M9 = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, mentions, body) values ('${PUB}', 'user', '${U.requester}', '[{"kind":"crew","id":"${CREW_A}"}]', '@서윤 아홉째') returning id`));
  const attempt = last(asUser(U.ownerA, `select public.msgr_execution_claim('lean-ax-a', '${CREW_A}', ${M9}, '${PUB}', gen_random_uuid())`));
  assert.notEqual(attempt, '', '심박 실증에는 실제 claim이 필요(msgr_delivery_allowed 등 다른 pg 테스트가 그 규칙을 잠근다)');
  const claimedAttempt = sql(`select attempt::text from public.msgr_executions where crew_id = '${CREW_A}' and source_msg_id = ${M9}`);
  const hb1 = asUser(U.ownerA, `select (public.msgr_execution_heartbeat('lean-ax-a', '${CREW_A}', ${M9}, '${PUB}', '${claimedAttempt}')->>'ok') || '|' || (public.msgr_execution_heartbeat('lean-ax-a', '${CREW_A}', ${M9}, '${PUB}', '${claimedAttempt}')->>'stop_requested')`);
  assert.equal(hb1, 'true|false', '중단 요청 전에는 stop_requested=false');
  assert.equal(asUser(U.requester, `select public.msgr_request_stop('${CREW_A}', ${M9})`), 't');
  const hb2 = asUser(U.ownerA, `select (public.msgr_execution_heartbeat('lean-ax-a', '${CREW_A}', ${M9}, '${PUB}', '${claimedAttempt}')->>'ok') || '|' || (public.msgr_execution_heartbeat('lean-ax-a', '${CREW_A}', ${M9}, '${PUB}', '${claimedAttempt}')->>'stop_requested')`);
  assert.equal(hb2, 'true|true', '중단 요청 뒤에는 stop_requested=true');
});

// L-7: 비공개 방(공개 채널이 아닌 곳)에서 시작된 실행도 방송은 여전히 u:<owner> — 채널 종류와 무관하게 크루 주인 개인 토픽 하나.
test('비공개 방에서 시작된 실행도 방송 토픽은 u:<owner>다(채널 종류와 무관)', { skip }, () => {
  const M10 = last(asUser(U.requester, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PRIV}', 'user', '${U.requester}', '@서윤 비공개') returning id`));
  seedExec(CREW_A, M10);
  sql('delete from realtime.sent');
  assert.equal(asUser(U.requester, `select public.msgr_request_stop('${CREW_A}', ${M10})`), 't');
  assert.equal(sql(`select topic from realtime.sent where event = 'stop_request'`), `u:${U.ownerA}`);
  assert.equal(sql(`select count(*) from realtime.sent where event = 'stop_request' and topic like 'org:%'`), '0', '조직 토픽으로는 절대 나가지 않는다');
});
