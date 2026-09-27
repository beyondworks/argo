// 조직 무료 기간 30일 + 유료 구독 자리(유건 결정 2026-09-26, 2026-09-27 분리 검수 반영 — 최종).
// 잠그는 계약: (1) 새 조직은 만든 시각부터 30일 무료. (2) 무료 조직은 좌석·공개 채널 수 한도가 아예 없다(무료 기간
//   중이든 끝났든 — "한도 복귀"는 채택하지 않았다, 2026-09-27 M8·M2). plan='team'(좌석을 산 조직)만 그 좌석 수를
//   항상 강제한다(무료 기간·자격과 무관 — 라이브 team 2곳 회귀 방지). 공개 채널 수 한도 게이트는 폐기했다.
//   (3) 연장(msgr_extend_trial)은 service_role 전용 — 앱 안에 쿠폰 입력 화면을 두지 않는다(App Store 3.1.1).
//   (4) 연장되면 알림함이 쓰는 서버 표(msgr_org_announcements)에 안내가 남는다.
//   (5) 일반 사용자는 trial_ends_at·paid_until 열을 직접 못 바꾼다(테이블 grant가 이미 막는다 — RLS 정책 없음).
//   (6) msgr_org_entitled(org) = 무료 기간 중 OR paid_until 미래 OR msgr_org_plan(org)='team'(레거시 유료 조직 보호 —
//       라이브 확인 2026-09-26: team 2건, 웹 결제 연동 전까지 크루 작업이 멈추면 안 된다). entitled=false 조직은
//       크루 텍스트·결재 카드 삽입만 막힌다(kind=system 안내, 사람 메시지, 개인 공간(org_id null)은 영향 없음) —
//       게이트웨이 1차 방어의 DB 쪽 2차 방어선. msgr_org_entitled·trial_active는 그 조직 멤버·auth.uid() 없는(서비스·
//       내부) 호출만 값을 받는다(2026-09-27 L3).
// 실행: bash scripts/billing-pg-drill.sh test/msgr-trial-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-trial-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  o1: '11111111-1111-4111-8111-111111111111', a2: '22222222-2222-4222-8222-222222222222', a3: '33333333-3333-4333-8333-333333333333',
  a4: '44444444-4444-4444-8444-444444444444', a5: '55555555-5555-4555-8555-555555555555',
  o2: '66666666-6666-4666-8666-666666666666', b2: '77777777-7777-4777-8777-777777777777', b3: '88888888-8888-4888-8888-888888888888',
  b4: '99999999-9999-4999-8999-999999999999', o3: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const raw = (q) => psqlRaw(['-A', '-t', '-c', q]); // superuser 직접 호출 — 트리거 자체를 검사(RLS·grant는 별도 케이스에서)
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asService = (q) => sql(`set role service_role; ${q}`);
const asAnon = (q) => sql(`set role anon; ${q}`);
const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const makeInviteCode = (org, ownerId) => last(asUser(ownerId, `insert into public.msgr_invites (org_id, role, created_by) values ('${org}', 'member', '${ownerId}') returning code`));
const accept = (uid, code) => asUserRaw(uid, `select public.msgr_accept_invite('${code}')`);
const invite = (org, ownerId, memberId) => { const r = accept(memberId, makeInviteCode(org, ownerId)); if (r.status !== 0) throw new Error(`invite 실패: ${r.stderr || r.stdout}`); return last(r.stdout); };
const expireTrial = (org) => sql(`update public.msgr_org_entitlements set trial_ends_at = now() - interval '1 day' where org_id = '${org}'`);
const trialEndsAt = (org) => sql(`select trial_ends_at from public.msgr_org_entitlements where org_id = '${org}'`);
const activeCount = (org) => Number(sql(`select count(*) from public.msgr_org_members where org_id = '${org}' and removed_at is null`));
const ageScan = (crewId) => sql(`update public.msgr_bots set scan_at = now() - interval '1 minute' where crew_id = '${crewId}'`); // 유휴 게이트(30초)를 넘겨 강제로 다시 스캔시킨다

let ORG1, ORG2, ORG3, UNORG, UNCH, UNCREW;
before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    -- 역할은 클러스터 전체 공유 — 드릴에서 먼저 도는 다른 파일이 bypassrls 없이 이미 만들어 뒀을 수 있다(실측: 전체 드릴 46번째 파일에서 관찰).
    -- 실 Supabase의 service_role은 항상 RLS를 우회하므로(BYPASSRLS), 생성 여부와 무관하게 매번 강제한다.
    alter role service_role bypassrls;
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
  ORG1 = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Trial1', 'trial1', '${U.o1}') returning id`));
  ORG2 = last(asUser(U.o2, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Trial2', 'trial2', '${U.o2}') returning id`));
  ORG3 = last(asUser(U.o3, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Trial3', 'trial3', '${U.o3}') returning id`));
  UNORG = last(asUser(U.o3, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Unentitled', 'unentitled1', '${U.o3}') returning id`));
  expireTrial(UNORG);
  UNCH = last(asUser(U.o3, `select public.msgr_create_channel('${UNORG}','public','general')`));
  UNCREW = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${UNORG}', '${U.o3}', 'ws-un', 'bot', '봇') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${UNCH}', 'crew', '${UNCREW}', '${U.o3}')`); // 크루가 이 채널의 실제 구성원이어야 msgr_messages_crew_scope가 삽입을 통과시킨다(자격 게이트와는 별개 트리거)
});

test('새 조직은 만든 시각부터 30일 무료 기간을 가진다', { skip }, () => {
  assert.equal(sql(`select (trial_ends_at > now() and trial_ends_at < now() + interval '31 days') from public.msgr_org_entitlements where org_id = '${ORG1}'`), 't');
});

test('무료 기간 중 4번째 멤버 허용', { skip }, () => {
  invite(ORG1, U.o1, U.a2); invite(ORG1, U.o1, U.a3); // 소유자 포함 3명(무료 한도 그대로)
  invite(ORG1, U.o1, U.a4); // 4번째 — 무료 기간이라 좌석 한도 미적용
  assert.equal(activeCount(ORG1), 4);
});

test('무료 조직은 기간이 끝나도 좌석 한도가 없다(2026-09-27 M8·M2 — 한도 복귀 미채택)', { skip }, () => {
  invite(ORG2, U.o2, U.b2); invite(ORG2, U.o2, U.b3); // 소유자 포함 3명
  expireTrial(ORG2);
  assert.equal(activeCount(ORG2), 3, '만료 직후에도 기존 3명은 그대로');
  invite(ORG2, U.o2, U.b4); // 무료 기간이 끝났어도 좌석 한도가 없으므로 4번째도 허용
  assert.equal(activeCount(ORG2), 4, '무료 조직은 기간이 끝나도 좌석 한도가 없다');
});

test('무료 조직은 공개 채널 수 한도가 없다(2026-09-27 M8·M2 — 채널 수 게이트 폐기)', { skip }, () => {
  const ch1 = last(asUser(U.o3, `select public.msgr_create_channel('${ORG3}','public','ch1')`));
  const ch2 = last(asUser(U.o3, `select public.msgr_create_channel('${ORG3}','public','ch2')`));
  assert.ok(ch1 && ch2 && ch1 !== ch2);
  expireTrial(ORG3);
  const ch3 = last(asUser(U.o3, `select public.msgr_create_channel('${ORG3}','public','ch3')`)); // 무료 기간이 끝나도 여전히 허용
  assert.ok(ch3 && ch3 !== ch1 && ch3 !== ch2);
  const cnt = Number(sql(`select count(*) from public.msgr_channels where org_id = '${ORG3}' and kind = 'public' and archived_at is null`));
  assert.equal(cnt, 3, '무료 조직은 공개 채널 수 한도가 없다');
});

test('team 플랜 조직은 무료 기간·자격과 무관하게 항상 자기 좌석 수만 강제된다(2026-09-27 M8·M2 — 라이브 team 회귀 방지)', { skip }, () => {
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('TeamSeats', 'teamseats1', '${U.o1}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 3 where org_id = '${org}'`);
  // 아직 무료 기간이 끝나지 않았다(갓 만든 조직) — 하지만 team 플랜은 무료 기간 여부와 무관하게 좌석 수를 강제해야 한다
  assert.equal(sql(`select (trial_ends_at > now()) from public.msgr_org_entitlements where org_id = '${org}'`), 't', '무료 기간이 아직 살아 있다(대조군)');
  invite(org, U.o1, U.a2); invite(org, U.o1, U.a3); // 소유자 포함 3명 = 산 좌석 수
  const r = accept(U.a4, makeInviteCode(org, U.o1));
  assert.notEqual(r.status, 0, '무료 기간이 남아 있어도 team 플랜은 산 좌석 수(3)를 넘길 수 없다');
  assert.match(r.stderr, /msgr_seat_limit/);
});

test('연장 함수는 service_role만 실행할 수 있다', { skip }, () => {
  const denied = asUserRaw(U.o2, `select public.msgr_extend_trial('${ORG2}'::uuid, 14, 'stabilizing')`);
  assert.notEqual(denied.status, 0, '조직 소유자도 연장 함수를 직접 부를 수 없다');
  assert.match(denied.stderr, /permission denied/);
});

test('연장하면 무료 기간이 늘고 알림함 표(msgr_org_announcements)에 안내가 남는다', { skip }, () => {
  const before = trialEndsAt(ORG2);
  const n = asService(`select public.msgr_extend_trial('${ORG2}'::uuid, 14, 'stabilizing')`);
  assert.equal(n, '1');
  const after = trialEndsAt(ORG2);
  assert.ok(new Date(after) > new Date(before), '연장 후 무료 기간이 늘어난다');
  const row = sql(`select kind || '|' || (meta->>'trial_ends_at' is not null)::text || '|' || (meta->>'reason') from public.msgr_org_announcements where org_id = '${ORG2}' order by id desc limit 1`);
  assert.equal(row, 'trial_extended|true|stabilizing');
  // 연장으로 무료 기간이 다시 활성 — 전에 거부됐던 4번째 멤버가 이제 허용된다
  invite(ORG2, U.o2, U.b4);
  assert.equal(activeCount(ORG2), 4);
});

test('연장 대상 org=null이면 활성 조직 전체를 연장한다', { skip }, () => {
  const b1 = trialEndsAt(ORG1); const b3 = trialEndsAt(ORG3);
  const n = Number(asService(`select public.msgr_extend_trial(null, 7, 'global stabilize')`));
  assert.ok(n >= 3, `최소 조직 3곳(ORG1·ORG2·ORG3)이 연장돼야 한다 — 실제 ${n}`);
  assert.ok(new Date(trialEndsAt(ORG1)) > new Date(b1));
  assert.ok(new Date(trialEndsAt(ORG3)) > new Date(b3));
});

test('일반 사용자는 무료 기간 열을 직접 못 바꾼다', { skip }, () => {
  const r = asUserRaw(U.o1, `update public.msgr_org_entitlements set trial_ends_at = now() + interval '999 days' where org_id = '${ORG1}'`);
  assert.notEqual(r.status, 0, 'msgr_org_entitlements는 authenticated에 select만 부여돼 있다(서비스 계정·엣지 펑션만 쓴다)');
  assert.match(r.stderr, /permission denied/);
});

test('일반 사용자는 결제 기간 열도 직접 못 바꾼다', { skip }, () => {
  const r = asUserRaw(U.o1, `update public.msgr_org_entitlements set paid_until = now() + interval '365 days' where org_id = '${ORG1}'`);
  assert.notEqual(r.status, 0, 'paid_until도 service_role 전용 — 결제 웹훅만 채운다');
  assert.match(r.stderr, /permission denied/);
});

test('msgr_org_entitled — 결제 기간이 남아 있으면 무료 기간이 끝나도 자격이 있다', { skip }, () => {
  expireTrial(UNORG); // 앞선 '연장 대상 org=null' 테스트가 모든 조직을 연장했을 수 있어 다시 만료시킨다
  assert.equal(sql(`select public.msgr_org_entitled('${UNORG}')`), 'f', '무료 기간도 끝났고 아직 결제 기록도 없다');
  asService(`update public.msgr_org_entitlements set paid_until = now() + interval '30 days' where org_id = '${UNORG}'`);
  assert.equal(sql(`select public.msgr_org_entitled('${UNORG}')`), 't', '결제 기간이 남아 있으면 무료 기간과 무관하게 자격이 있다');
  asService(`update public.msgr_org_entitlements set paid_until = null where org_id = '${UNORG}'`); // 다음 테스트를 위해 되돌린다
});

test('DB 2차 방어 — 미결제 조직의 크루 텍스트·결재 카드는 거부, 사람 메시지·시스템 안내는 허용', { skip }, () => {
  const denyText = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${UNCH}', 'crew', '${UNCREW}', 'text', 'hello')`);
  assert.notEqual(denyText.status, 0, '무료 기간이 끝나고 결제도 없으면 크루 텍스트 삽입은 거부된다');
  assert.match(denyText.stderr, /msgr_org_unentitled/);
  const denyCard = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${UNCH}', 'crew', '${UNCREW}', 'approval_card', 'x')`);
  assert.notEqual(denyCard.status, 0);
  assert.match(denyCard.stderr, /msgr_org_unentitled/);
  const notice = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${UNCH}', 'crew', '${UNCREW}', 'system', '무료 기간이 끝나 이 조직의 크루 작업이 멈췄습니다. 조직 관리자에게 문의하세요.')`);
  assert.equal(notice.status, 0, '무료 기간 종료 안내(kind=system)는 여전히 남길 수 있다 — 막히면 안내 자체가 안 나간다');
  const human = raw(`insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body) values ('${UNCH}', 'user', '${U.o3}', 'text', '사람끼리는 그대로 대화된다')`);
  assert.equal(human.status, 0, '사람끼리의 대화는 크루 자격과 무관하게 그대로 된다');
});

test('DB 2차 방어 — paid_until이 미래면 크루 텍스트가 다시 허용된다', { skip }, () => {
  asService(`update public.msgr_org_entitlements set paid_until = now() + interval '30 days' where org_id = '${UNORG}'`);
  const r = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${UNCH}', 'crew', '${UNCREW}', 'text', '결제된 뒤에는 다시 답한다')`);
  assert.equal(r.status, 0, '결제 기간이 남아 있으면 크루 텍스트 삽입이 다시 허용된다');
  asService(`update public.msgr_org_entitlements set paid_until = null where org_id = '${UNORG}'`); // 다음 테스트를 위해 되돌린다
});

test('DB 2차 방어 — 개인 공간(org_id null)은 조직 자격과 무관하게 항상 허용된다', { skip }, () => {
  // msgr_crew_in_channel은 crew.org_id = channel.org_id를 요구해 개인 공간(org_id null)에서는 원천적으로 거짓이다 —
  // 실제 앱은 사람 글의 멘션→msgr_dm_grants(delivery_allowed)로 크루 답글을 연다. 여기서는 그 배선과 무관한
  // 자격 게이트 자체만 보므로, 같은 msgr_messages 표에 붙은 무관 가드(크루 채널 소속·DM 배달 규칙)만 이 삽입 한 번에 한해 끈다.
  const cid = last(sql(`insert into public.msgr_channels (org_id, kind, name, created_by) values (null, 'dm', 'personal', '${U.o3}') returning id`));
  sql(`alter table public.msgr_messages disable trigger msgr_messages_crew_scope; alter table public.msgr_messages disable trigger b_msgr_dm_message_guard`);
  const r = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${cid}', 'crew', '${UNCREW}', 'text', '개인 공간은 항상 무료')`);
  sql(`alter table public.msgr_messages enable trigger msgr_messages_crew_scope; alter table public.msgr_messages enable trigger b_msgr_dm_message_guard`);
  if (r.status !== 0) console.error('[debug personal]', r.stderr);
  assert.equal(r.status, 0, '채널이 조직 소속이 아니면(org_id null) 자격 게이트(msgr_message_entitlement_gate)가 적용되지 않는다');
});

test('team 플랜 조직은 무료 기간이 끝나도 크루 턴이 허용된다(msgr_org_plan=team) — 라이브 확인(2026-09-26): team 2건 모두 ls_status null', { skip }, () => {
  const org = last(asUser(U.o2, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('TeamOrg', 'teamorg1', '${U.o2}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 5 where org_id = '${org}'`);
  expireTrial(org);
  assert.equal(sql(`select public.msgr_org_entitled('${org}')`), 't', 'team 플랜이면 무료 기간·결제 기간과 무관하게 자격이 있다');
  const ch = last(asUser(U.o2, `select public.msgr_create_channel('${org}','public','general')`));
  const crew = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${org}', '${U.o2}', 'ws-team', 'bot', '봇') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${crew}', '${U.o2}')`);
  const r = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${ch}', 'crew', '${crew}', 'text', 'team 플랜은 계속 답한다')`);
  assert.equal(r.status, 0, 'team 플랜 조직은 무료 기간이 끝나도 크루 텍스트 삽입이 허용된다');
});

test('변이(team 절 제거)는 team 플랜 조직의 크루 턴을 거부로 바꾼다 — red 확인', { skip }, () => {
  sql(`create or replace function public.msgr_org_entitled(org uuid) returns boolean
    language sql stable security definer set search_path = public, pg_temp as $$
      select public.msgr_org_trial_active(org)
          or coalesce((select e.paid_until > now() from public.msgr_org_entitlements e where e.org_id = org), false)
    $$`);
  const org = last(asUser(U.o2, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('TeamMutant', 'teammutant1', '${U.o2}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 5 where org_id = '${org}'`);
  expireTrial(org);
  const ch = last(asUser(U.o2, `select public.msgr_create_channel('${org}','public','general')`));
  const crew = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${org}', '${U.o2}', 'ws-teammut', 'bot', '봇') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${crew}', '${U.o2}')`);
  const r = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${ch}', 'crew', '${crew}', 'text', 'team 절 없으면 거부돼야 한다')`);
  assert.notEqual(r.status, 0, 'team 절을 뺀 뒤집힌 버전은 정상 코드라면 통과할 team 플랜 크루 텍스트를 거부한다 — 변이가 잡힌다');
  assert.match(r.stderr, /msgr_org_unentitled/);
  // 원래 정의로 복구 — 이 파일의 나머지 테스트(특히 다음 트리얼 비교 변이 테스트)에 영향을 남기지 않는다
  sql(`create or replace function public.msgr_org_entitled(org uuid) returns boolean
    language sql stable security definer set search_path = public, pg_temp as $$
      select public.msgr_org_trial_active(org)
          or coalesce((select e.paid_until > now() from public.msgr_org_entitlements e where e.org_id = org), false)
          or public.msgr_org_plan(org) = 'team'
    $$`);
});

test('L3: 비회원 authenticated는 msgr_org_entitled·trial_active에서 null을 받는다', { skip }, () => {
  // ORG1은 U.o1의 조직 — U.o2는 그 조직 멤버가 아니다
  assert.equal(asUser(U.o2, `select public.msgr_org_entitled('${ORG1}')`), '', '비회원은 null(빈 문자열로 나온다 — psql -t)');
  assert.equal(asUser(U.o2, `select public.msgr_org_trial_active('${ORG1}')`), '', '비회원은 null');
  assert.notEqual(asUser(U.o1, `select public.msgr_org_entitled('${ORG1}')`), '', '조직 소유자(회원)는 실제 값을 받는다');
  assert.notEqual(sql(`select public.msgr_org_entitled('${ORG1}')`), '', 'auth.uid()가 없는 호출(서비스·내부 트리거 경로 흉내)도 실제 값을 받는다');
});

test('M4: 자동화는 미자격 조직에서 발송하지 않고(다음 예약부터 재시도), queued로 남은 실행은 unentitled로 닫힌다', { skip }, () => {
  const org = last(asUser(U.o3, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('AutoOrg', 'autoorg1', '${U.o3}') returning id`));
  const ch = last(asUser(U.o3, `select public.msgr_create_channel('${org}','public','general')`));
  const crew = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${org}', '${U.o3}', 'ws-auto', 'bot', '봇') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${crew}', '${U.o3}')`);
  const a = JSON.parse(asUser(U.o3, `select public.msgr_automation_save(null, '${ch}', '${crew}', '제목', '지시', '{"kind":"daily","time":"09:00","timezone":"Asia/Seoul"}')`)).id;
  // 무료 기간 중 — 정상 발송(대조군)
  const r1 = JSON.parse(asUser(U.o3, `select public.msgr_automation_run_now('${a}', gen_random_uuid())`));
  assert.equal(r1.status, 'queued'); assert.ok(r1.message_id, '무료 기간 중에는 지시 글이 실제로 올라간다(대조군)');
  expireTrial(org);
  // 미자격 — 발송하지 않는다
  const r2 = JSON.parse(asUser(U.o3, `select public.msgr_automation_run_now('${a}', gen_random_uuid())`));
  assert.equal(r2.status, 'blocked'); assert.equal(r2.error, 'unentitled'); assert.equal(r2.message_id, null, '미자격 조직은 지시 글을 올리지 않는다');
  assert.equal(sql(`select enabled from public.msgr_automations where id = '${a}'`), 't', '자동화 자체는 끄지 않는다(다음 예약부터 다시 시도)');
  // 이미 queued로 남은 실행(무료 기간 중 올라간 r1)은 게이트웨이·봇이 채널에 남긴 unentitled 안내로 닫힌다
  const notice = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, client_msg_id, body) values ('${ch}', 'crew', '${crew}', 'system', ${r1.message_id}, 'unentitled:${crew}:${ch}', '무료 기간이 끝나 이 조직의 크루 작업이 멈췄습니다.')`);
  assert.equal(notice.status, 0);
  assert.equal(sql(`select status || '|' || error from public.msgr_automation_runs where id = '${r1.id}'`), 'blocked|unentitled', '채널당 1회 안내가 뜨면 남은 queued 실행이 unentitled 사유로 닫힌다');
  // 다시 자격을 얻으면(예: 연장) 다음 예약부터 정상 발송된다
  asService(`select public.msgr_extend_trial('${org}'::uuid, 30, 'resume')`);
  const r3 = JSON.parse(asUser(U.o3, `select public.msgr_automation_run_now('${a}', gen_random_uuid())`));
  assert.equal(r3.status, 'queued'); assert.ok(r3.message_id, '다시 자격을 얻으면 다음 예약부터 정상 발송된다');
});

test('L4: 전체 연장 시 team 플랜 조직은 공지 대상에서 빠진다', { skip }, () => {
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('TeamL4', 'teaml4-1', '${U.o1}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 5 where org_id = '${org}'`);
  const before = trialEndsAt(org);
  asService(`select public.msgr_extend_trial(null, 5, 'global l4')`);
  assert.equal(trialEndsAt(org), before, 'team 플랜 조직은 전체 연장 대상에서 빠진다(무료 기간이 안 늘어난다)');
  assert.equal(sql(`select count(*) from public.msgr_org_announcements where org_id = '${org}'`), '0', 'team 플랜 조직에는 연장 공지도 안 남는다');
});

test('M5: msgrNotifyPush(데스크톱 알림→메신저 1:1 미러)는 미자격 조직에서도 막히지 않는다', { skip }, () => {
  expireTrial(UNORG); // 앞선 L4(연장 대상 org=null) 테스트가 UNORG도 연장했으므로 다시 만료시킨다
  // 게이트웨이 dmWithOwner와 같은 모양의 진짜 1:1(사람=소유자 1명·크루=이 크루 1명)만 만든다
  const UNDM = last(asUser(U.o3, `select public.msgr_create_channel('${UNORG}','dm','dm:un', '[{"kind":"crew","id":"${UNCREW}"}]'::jsonb)`));
  const r = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body) values ('${UNDM}', 'crew', '${UNCREW}', 'text', null, null, 'nt:${UNCREW}:deadbeef', '데스크톱에서 방금 일어난 일을 알려드립니다')`);
  assert.equal(r.status, 0, 'msgrNotifyPush 모양(nt: 접두·reply_to·thread_root 둘 다 null·진짜 1:1)의 삽입은 미자격 조직에서도 허용된다');
  // 같은 크루라도 진짜 크루 턴(reply_to가 있는 일반 text)은 여전히 막힌다 — 우회 통로가 되지 않는다(공개 채널로 —
  // DM에서 reply_to는 msgr_delivery_allowed까지 요구하는 별개 가드(b_msgr_dm_message_guard)가 있어 이 시나리오와 섞이지 않게 격리)
  const anyMsgId = sql(`select id from public.msgr_messages where channel_id = '${UNCH}' limit 1`);
  const r2 = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, client_msg_id, body) values ('${UNCH}', 'crew', '${UNCREW}', 'text', ${anyMsgId}, 'nt:${UNCREW}:fakeout', '진짜 크루 턴인 척')`);
  assert.notEqual(r2.status, 0, 'reply_to가 있으면 nt: 접두를 써도 막힌다(모양이 정확히 같아야만 예외)');
  assert.match(r2.stderr, /msgr_org_unentitled/);
  // N4(2차 검수) — kind='text'인 진짜 1:1이 아니면 nt: 접두는 예외가 아니다:
  // (1) 공개 채널(사람이 여럿일 수 있음)
  const r3 = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body) values ('${UNCH}', 'crew', '${UNCREW}', 'text', null, null, 'nt:${UNCREW}:pubchan', '공개 채널에 nt: 위장')`);
  assert.notEqual(r3.status, 0, '공개 채널은 진짜 1:1이 아니라 nt: 접두를 써도 막힌다');
  assert.match(r3.stderr, /msgr_org_unentitled/);
  // (2) approval_card는 text가 아니라서 애초에 이 예외 대상이 아니다
  const r4 = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body) values ('${UNDM}', 'crew', '${UNCREW}', 'approval_card', null, null, 'nt:${UNCREW}:card', '카드로 위장')`);
  assert.notEqual(r4.status, 0, 'approval_card는 nt: 접두·모양이 같아도 예외가 아니다(text만 예외)');
  assert.match(r4.stderr, /msgr_org_unentitled/);
  // (3) 크루가 둘 낀 DM(진짜 1:1이 아님) — 다른 크루가 낀 방은 거부
  const UNCREW2 = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${UNORG}', '${U.o3}', 'ws-un2', 'bot2', '봇2') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${UNDM}', 'crew', '${UNCREW2}', '${U.o3}')`);
  const r5 = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body) values ('${UNDM}', 'crew', '${UNCREW}', 'text', null, null, 'nt:${UNCREW}:crowded', '크루 둘 낀 방에서 위장')`);
  assert.notEqual(r5.status, 0, '크루가 둘 이상 낀 방은 진짜 1:1이 아니라 거부된다(다른 DM 불변식이 먼저 막아도 결과는 거부)');
});

test('변이(비교 부호 뒤집기)는 무료 기간 중 크루 턴 허용을 거부로 바꾼다 — red 확인', { skip }, () => {
  // 원래: trial_ends_at > now(). 뒤집으면 갓 만든 조직도 "무료 기간이 이미 끝난 것"으로 오판해야 한다.
  // 좌석·채널 한도는 더 이상 trial_active를 안 보므로(2026-09-27 M8), 이 비교가 실제로 걸리는 자리인 크루 텍스트 게이트로 잠근다.
  sql(`create or replace function public.msgr_org_trial_active(org uuid) returns boolean
    language sql stable security definer set search_path = public, pg_temp as $$
      select coalesce((select e.trial_ends_at <= now() from public.msgr_org_entitlements e where e.org_id = org), false)
    $$`);
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Mutant', 'mutant1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const crew = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${org}', '${U.o1}', 'ws-mutant', 'bot', '봇') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${crew}', '${U.o1}')`);
  const r = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${ch}', 'crew', '${crew}', 'text', '갓 만든 조직이라 정상 코드라면 허용돼야 한다')`);
  assert.notEqual(r.status, 0, '뒤집힌 비교는 갓 만든 조직도 무료 기간이 끝난 것으로 오판해 크루 텍스트를 거부한다(정상 코드라면 통과) — 변이가 잡힌다');
  assert.match(r.stderr, /msgr_org_unentitled/);
  // 원래 정의로 복구(파일 끝 — 이후 테스트 없음이지만 습관적으로 되돌린다)
  sql(`create or replace function public.msgr_org_trial_active(org uuid) returns boolean
    language sql stable security definer set search_path = public, pg_temp as $$
      select case when auth.uid() is not null and not public.msgr_is_member(org) then null
        else coalesce((select e.trial_ends_at > now() from public.msgr_org_entitlements e where e.org_id = org), false) end
    $$`);
});

// ── 2026-09-27 2차 검수(통합 브랜치) — H1 합본 마이그레이션(20260927130000_msgr_bot_gates_merged.sql)의
//    두 게이트(무료 기간 자격·AI 동의)와 N1(넘김 회귀)·N6(미자격 커서 전진)을 실 Postgres로 잠근다. ──
const MERGED = '20260927130000_msgr_bot_gates_merged.sql';

// 델타 검수 LOW(4차) — M-3의 순방향 참조 처방(130000의 임시 정의는 "함수가 없을 때만" 만든다)을 잠근다.
// before()에서 이미 130000→140000 순서로 전체가 한 번 적용됐다(140000이 전환 기간 포함 최종 정의를 덮어씀).
// 여기서 130000을 단독으로 다시 적용해도(라이브 재현·부분 재적용 흉내) 140000의 최종 정의가 살아 있어야 한다.
test('델타 M-3: 140000 적용 뒤 130000을 다시 적용해도 전환 기간이 포함된 최종 정의가 남는다', { skip }, () => {
  psql(['-c', readFileSync(mig(MERGED), 'utf8')]); // 130000 재적용 — create or replace였다면 여기서 전환 기간 case가 지워진다
  const def = sql(`select pg_get_functiondef('public.msgr_ai_consent_visible(uuid)'::regprocedure)`);
  assert.ok(def.includes('ai_consent_enforce_after'), '130000을 다시 적용해도 140000의 전환 기간 case가 남아 있어야 한다');
});

test('H1·N2: 봇 업데이트·실행 게이트(합본) — 미자격이면 0건·실행 행 0개, 자격 있으면 정상 배달(대조군)', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`); // 이 테스트는 자격 게이트만 본다 — 동의 게이트가 먼저 걸리지 않게
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('BotGateOrg', 'botgate1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'GateBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  const m1 = last(asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@GateBot 부탁', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]') returning id`));
  assert.equal(JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`)).length, 1, '자격 있는 동안은 정상 배달된다(대조군)');
  assert.equal(sql(`select count(*) from public.msgr_executions where crew_id = '${bot.crew_id}' and source_msg_id = ${m1}`), '1', '실행 행이 생긴다(대조군)');
  expireTrial(org);
  const m2 = last(asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@GateBot 부탁2', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]') returning id`));
  assert.equal(JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`)).length, 0, '미자격 조직은 봇 업데이트 0건');
  assert.equal(sql(`select count(*) from public.msgr_executions where crew_id = '${bot.crew_id}' and source_msg_id = ${m2}`), '0', '미자격 조직은 실행 행을 만들지 않는다(오펀 running 없음)');
  assert.equal(sql(`select count(*) from public.msgr_messages where channel_id = '${ch}' and kind = 'system' and client_msg_id like 'unentitled:${bot.crew_id}:%'`), '1', '채널당 1회 안내가 남는다');
});

test('H1: msgr_bot_finish도 자격이 없으면 실행을 닫고 null을 돌린다(호출부가 403으로 바꾼다)', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`); // 이 테스트는 자격 게이트만 본다 — 동의 게이트가 먼저 걸리지 않게
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('BotFinOrg', 'botfin1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'FinBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@FinBot 부탁', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]')`);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  assert.equal(ups.length, 1);
  const msg = ups[0].message;
  expireTrial(org); // 배달은 자격 있는 동안 됐는데, 응답하러 오니 그 사이 무료 기간이 끝난 경쟁 상황
  const r = asAnonRaw(`select public.msgr_bot_finish('${bot.token}', '${msg.chat.id}', '늦은 응답', ${msg.message_id}, '${msg.execution_attempt}', 'done', '[]')`);
  assert.equal(r.status, 0, 'RPC 자체는 에러가 아니라 null을 돌린다(호출부에서 403으로 번역)');
  assert.equal(r.stdout.trim(), '', 'null 반환 — message_id:0 같은 거짓 성공이 아니다');
  assert.equal(sql(`select state from public.msgr_executions where crew_id = '${bot.crew_id}' and source_msg_id = ${msg.message_id}`), 'completed', '실행 행은 닫혀 running으로 남지 않는다');
});

test('N1: msgr_bot_finish 넘김은 초대 안 된 크루로 성공하지 않는다(회귀 잠금) — 공개 채널 비멤버 거부, 멤버면 허용', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`); // 이 테스트는 자격 게이트만 본다 — 동의 게이트가 먼저 걸리지 않게
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('HandoffOrg', 'handoff1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const a = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'A')`)));
  const b = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'B')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${a.crew_id}', '${U.o1}')`);
  const mentions = JSON.stringify([{ kind: 'crew', id: b.crew_id }]);
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@A 부탁', '[{"kind":"crew","id":"${a.crew_id}","role":"to"}]')`);
  const ups1 = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${a.token}') x`));
  assert.equal(ups1.length, 1);
  const msg1 = ups1[0].message;
  const r1 = asAnonRaw(`select public.msgr_bot_finish('${a.token}', '${msg1.chat.id}', '넘길게요', ${msg1.message_id}, '${msg1.execution_attempt}', 'handoff', '${mentions}')`);
  assert.notEqual(r1.status, 0, '초대 안 된 크루(비멤버, 공개 채널)로 넘김은 거부된다 — origin/main 회귀 잠금');
  assert.match(r1.stderr, /msgr_not_allowed/);
  // B를 채널 멤버로 넣으면 같은 모양의 넘김이 성공한다(과잉 제한이 아님을 함께 확인)
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${b.crew_id}', '${U.o1}')`);
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@A 부탁2', '[{"kind":"crew","id":"${a.crew_id}","role":"to"}]')`);
  const ups2 = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${a.token}') x`));
  assert.equal(ups2.length, 1);
  const msg2 = ups2[0].message;
  const r2 = asAnonRaw(`select public.msgr_bot_finish('${a.token}', '${msg2.chat.id}', '넘길게요', ${msg2.message_id}, '${msg2.execution_attempt}', 'handoff', '${mentions}')`);
  assert.equal(r2.status, 0, 'B가 채널 멤버가 되면 같은 넘김이 성공한다');
});

test('N6: 미자격 동안 봇 커서는 이번 스캔 최댓값까지 바로 넘어간다(전체 재스캔 방지, 뒤늦은 실행 없음)', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`); // 이 테스트는 자격 게이트만 본다 — 동의 게이트가 먼저 걸리지 않게
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('CursorOrg', 'cursor1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'CursorBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  expireTrial(org);
  let lastId = '0';
  for (let i = 0; i < 3; i++) {
    lastId = last(asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@CursorBot ${i}', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]') returning id`));
  }
  asAnon(`select public.msgr_bot_updates('${bot.token}')`);
  const cursor = sql(`select cursor_msg_id from public.msgr_crews where id = '${bot.crew_id}'`);
  assert.ok(Number(cursor) >= Number(lastId), '커서가 이번 스캔 최댓값까지 바로 넘어간다 — 자격이 돌아와도 밀린 멘션을 뒤늦게 실행하지 않는다');
});

test('변이: 합본 봇 업데이트에서 자격 게이트를 지우면 미자격 조직도 배달된다 — red 확인', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`); // 이 테스트는 자격 게이트만 본다 — 동의 게이트가 먼저 걸리지 않게
  const orig = readFileSync(mig(MERGED), 'utf8');
  const anchor = ' if not entitled and ch.org_id is not null then\n';
  assert.equal((orig.match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, '앵커가 정확히 1곳이어야 한다');
  sql(orig.replace(anchor, ' if false and not entitled and ch.org_id is not null then\n'));
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('MutBotOrg', 'mutbot1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'MutBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  expireTrial(org);
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@MutBot 부탁', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]')`);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  assert.equal(ups.length, 1, '자격 게이트가 지워지면 미자격 조직도 배달된다(정상 코드라면 0이어야 하므로 변이가 잡힌다)');
  sql(orig); // 원래(합본) 정의로 복구
});

test('변이: 합본 봇 finish에서 자격 게이트를 지우면 미자격 조직도 응답을 완료한다 — red 확인', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`); // 이 테스트는 자격 게이트만 본다 — 동의 게이트가 먼저 걸리지 않게
  const orig = readFileSync(mig(MERGED), 'utf8');
  const anchor = "  if not coalesce(public.msgr_org_entitled(b.org_id), true) then\n    update public.msgr_executions set state = 'completed', heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;\n    return null;";
  assert.equal((orig.match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, '앵커가 정확히 1곳이어야 한다');
  sql(orig.replace(anchor, "  if false and not coalesce(public.msgr_org_entitled(b.org_id), true) then\n    update public.msgr_executions set state = 'completed', heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;\n    return null;"));
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('MutFinOrg', 'mutfin1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'MutFin')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@MutFin 부탁', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]')`);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  assert.equal(ups.length, 1);
  const msg = ups[0].message;
  expireTrial(org);
  // 메시지 삽입 트리거(msgr_message_entitlement_gate)가 이중 방어로 여전히 막지만(에러 자체는 남는다),
  // finish 자체의 자격 체크가 지워지면 실행 행을 completed로 닫지 않고 running에 오펀으로 남긴다(M3의 실제 목적) — 여기서 잡는다.
  asAnonRaw(`select public.msgr_bot_finish('${bot.token}', '${msg.chat.id}', '변이 응답', ${msg.message_id}, '${msg.execution_attempt}', 'done', '[]')`);
  assert.equal(sql(`select state from public.msgr_executions where crew_id = '${bot.crew_id}' and source_msg_id = ${msg.message_id}`), 'running', '자격 게이트가 지워지면 실행 행이 running으로 오펀 남는다(정상 코드라면 completed여야 하므로 변이가 잡힌다)');
  sql(orig); // 원래(합본) 정의로 복구
});

test('변이: 합본 봇 업데이트에서 AI 동의 필터를 지우면 미동의 사람 글도 배달된다 — red 확인', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(false)`); // 명시적으로 미동의 상태에서 시작(테스트 순서와 무관하게)
  const orig = readFileSync(mig(MERGED), 'utf8');
  const anchor = " if s.author_kind='user' and not public.msgr_ai_consent_visible(s.author_user_id) then\n";
  assert.equal((orig.match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, '앵커가 정확히 1곳이어야 한다');
  sql(orig.replace(anchor, " if false and s.author_kind='user' and not public.msgr_ai_consent_visible(s.author_user_id) then\n"));
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('MutConsentOrg', 'mutconsent1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'MutConsent')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  // U.o1은 위에서 명시적으로 거부했다(전환 기간과 무관하게 항상 차단이어야 한다) — 변이는 그 차단 자체를 지운다
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@MutConsent 부탁', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]')`);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  assert.equal(ups.length, 1, 'AI 동의 필터가 지워지면 미동의 사람 글도 배달된다(정상 코드라면 0이어야 하므로 변이가 잡힌다)');
  sql(orig); // 원래(합본) 정의로 복구
});

test('H2: AI 동의 안 한 사람의 글은 봇에게 넘어가지 않는다(정상 코드 확인, 위 변이의 대조군)', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(false)`); // 명시적으로 미동의 상태에서 시작(테스트 순서와 무관하게)
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('ConsentOrg', 'consent1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'ConsentBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@ConsentBot 부탁', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]')`);
  assert.equal(JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`)).length, 0, '미동의 사람 글은 봇 문맥에서 제외된다(넘어가지 않는다)');
  assert.equal(sql(`select count(*) from public.msgr_messages where channel_id = '${ch}' and kind = 'system' and client_msg_id like 'aiconsent:${bot.crew_id}:%'`), '1', '동의 안내가 채널당 1회 남는다');
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`);
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.o1}', 'text', '@ConsentBot 부탁2', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]')`);
  // 동의 전 건너뛴 첫 글도 소급 배달 대상이 될 수 있다(동의는 자격과 달리 "영영 폐기"가 아니다) — 새 글이 최소 하나는 배달됨을 확인
  assert.ok(JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`)).length >= 1, '동의하면 다시 정상 배달된다');
});

// ── 2026-09-27 저녁(2차 재검수) — M-1: 팀 업무를 시작한 사람의 동의 여부가 목표·완료 기준 텍스트를 가른다.
//    배달되는 글 자체는 동의한 다른 사람의 후속 글이라 H2를 통과한다 — work_run.created_by만 가려낸다는 걸 이렇게 격리한다. ──
test('M-1(2차 재검수, 봇): msgr_bot_updates는 팀 업무를 시작한 사람이 동의하지 않았으면 목표·완료 기준을 감춘다', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(false)`); // 업무를 시작한 사람 — 명시적으로 거부
  asUser(U.a2, `select public.msgr_set_ai_consent(true)`); // 후속 글을 쓰는 다른 사람 — 동의함(H2를 통과시켜 M-1만 격리)
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('WorkGoalOrg', 'workgoal1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${U.a2}', 'member', 'a2') on conflict do nothing`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${U.a2}', '${U.o1}') on conflict do nothing`);
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'WorkBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  const w = JSON.parse(asUser(U.o1, `select public.msgr_work_create('${ch}', gen_random_uuid(), '민감한 목표 텍스트', '완료 기준 텍스트', '${bot.crew_id}')`));
  asUser(U.a2, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, reply_to, thread_root) values ('${ch}', 'user', '${U.a2}', 'text', '@WorkBot 진행 상황?', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]', ${w.root_message_id}, ${w.root_message_id})`);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  assert.equal(ups.length, 1, '동의한 사람의 후속 글은 정상 배달된다(H2 통과 — M-1만 격리해 본다)');
  assert.doesNotMatch(ups[0].message.text, /민감한 목표 텍스트/, '업무를 시작한 사람이 동의하지 않았으면 목표 텍스트가 프롬프트에 실리지 않는다');
  assert.equal(ups[0].message.work_run.goal, '(원문 비공개 / not shared)');
  assert.equal(ups[0].message.work_run.completion_criteria, '(원문 비공개 / not shared)');
});

// M-4 — 위 필터를 지우는 변이가 red가 되는지 확인한다.
test('변이: msgr_bot_updates의 목표 감춤(M-1)을 지우면 미동의 사람의 목표가 그대로 샌다 — red 확인', { skip }, () => {
  const migPath = mig('20260927140000_msgr_ai_consent_transition.sql');
  const orig = readFileSync(migPath, 'utf8');
  const anchor = "if not public.msgr_ai_consent_visible(w.created_by) then goal_text:='(원문 비공개 / not shared)'; crit_text:='(원문 비공개 / not shared)'; else";
  assert.equal((orig.match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, '앵커가 정확히 1곳이어야 한다');
  sql(orig.replace(anchor, "if false then goal_text:='(원문 비공개 / not shared)'; crit_text:='(원문 비공개 / not shared)'; else"));
  asUser(U.o1, `select public.msgr_set_ai_consent(false)`);
  asUser(U.a2, `select public.msgr_set_ai_consent(true)`);
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('MutWorkGoalOrg', 'mutworkgoal1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${U.a2}', 'member', 'a2') on conflict do nothing`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${U.a2}', '${U.o1}') on conflict do nothing`);
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'MutWorkBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  const w = JSON.parse(asUser(U.o1, `select public.msgr_work_create('${ch}', gen_random_uuid(), '변이로 새는 목표', '기준', '${bot.crew_id}')`));
  asUser(U.a2, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, reply_to, thread_root) values ('${ch}', 'user', '${U.a2}', 'text', '@MutWorkBot 진행 상황?', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]', ${w.root_message_id}, ${w.root_message_id})`);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  assert.match(ups[0].message.text, /변이로 새는 목표/, '필터가 지워지면 미동의 사람의 목표가 그대로 샌다(정상 코드라면 안 보여야 하므로 변이가 잡힌다)');
  sql(orig); // 원래(합본) 정의로 복구
});

// M-4(2차 재검수) — 봇 문맥(ctx) 자체도 동의 판정을 잠근다(위 테스트들은 배달 여부·목표 텍스트만 봤다).
test('M-4: 봇 문맥(ctx)도 동의 판정을 적용한다 — 미동의 사람의 글은 문맥에서 빠진다', { skip }, () => {
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`);
  asUser(U.a2, `select public.msgr_set_ai_consent(false)`);
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('CtxOrg', 'ctxorg1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${U.a2}', 'member', 'a2') on conflict do nothing`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${U.a2}', '${U.o1}') on conflict do nothing`);
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'CtxBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  const root = last(asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body) values ('${ch}', 'user', '${U.o1}', 'text', '뿌리 글') returning id`));
  const midByA2 = last(asUser(U.a2, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, reply_to, thread_root) values ('${ch}', 'user', '${U.a2}', 'text', '미동의 사람의 문맥 글', ${root}, ${root}) returning id`));
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, reply_to, thread_root) values ('${ch}', 'user', '${U.o1}', 'text', '@CtxBot 다시 확인해줘', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]', ${root}, ${root})`);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  assert.equal(ups.length, 1);
  const ctxIds = ups[0].message.context.map((c) => c.message_id);
  assert.ok(ctxIds.includes(Number(root)), '동의한 사람의 뿌리 글은 문맥에 있다(대조군)');
  assert.ok(!ctxIds.includes(Number(midByA2)), '미동의 사람의 글은 문맥에서 빠진다');
});

test('변이: 봇 문맥(ctx) 필터 줄을 지우면 미동의 사람의 글이 문맥에 그대로 샌다(M-4) — red 확인', { skip }, () => {
  const orig = readFileSync(mig(MERGED), 'utf8');
  const anchor = " and (m.author_kind<>'user' or public.msgr_ai_consent_visible(m.author_user_id))\n";
  assert.equal((orig.match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, '앵커가 정확히 1곳이어야 한다(봇 ctx 필터 줄)');
  sql(orig.replace(anchor, ""));
  asUser(U.o1, `select public.msgr_set_ai_consent(true)`);
  asUser(U.a2, `select public.msgr_set_ai_consent(false)`);
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('MutCtxOrg', 'mutctxorg1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${U.a2}', 'member', 'a2') on conflict do nothing`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${U.a2}', '${U.o1}') on conflict do nothing`);
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'MutCtxBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  const root = last(asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body) values ('${ch}', 'user', '${U.o1}', 'text', '뿌리 글') returning id`));
  const midByA2 = last(asUser(U.a2, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, reply_to, thread_root) values ('${ch}', 'user', '${U.a2}', 'text', '변이로 새는 문맥 글', ${root}, ${root}) returning id`));
  asUser(U.o1, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, reply_to, thread_root) values ('${ch}', 'user', '${U.o1}', 'text', '@MutCtxBot 다시 확인해줘', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]', ${root}, ${root})`);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  const ctxIds = ups[0].message.context.map((c) => c.message_id);
  assert.ok(ctxIds.includes(Number(midByA2)), '필터 줄이 지워지면 미동의 사람의 글도 문맥에 샌다(정상 코드라면 없어야 하므로 변이가 잡힌다)');
  sql(orig); // 원래(합본) 정의로 복구
});

// ── 델타 검수(2026-09-27 밤, 4차) HIGH — 3차 검수 L-1("동의 거부로 건너뛴 글도 커서를 무조건 전진")을
//    되돌린다. 그 수정은 커서를 넘기며 #689가 일부러 붙잡아 두던 앞쪽 글(아직 채널 미초대·결재 대기·
//    파견 재개 전인 겨냥 글, 10분 안에 늦게 커밋되는 낮은 id 글)까지 함께 건너뛰어 봇 배달을 영구히
//    잃게 만들었다(실측: 검수 scratchpad/rev3/probe2.test.mjs의 D1 시나리오). 거부 글이 커서를 붙잡아
//    나중에 동의하면 뒤늦게 배달될 수 있는 LOW는 감수한다 — 배달 유실보다 가볍다는 총괄 결정. ──
test('델타 HIGH: 아직 초대 안 된 채널의 겨냥 글은, 다른 채널의 동의 거부 글이 먼저 와도 초대 뒤 배달된다(#689 유지)', { skip }, () => {
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('CursorKeepOrg', 'cursorkeep1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const ch2 = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','later')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'CursorKeepBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`); // 봇은 처음엔 ch에만, ch2엔 아직 미초대
  for (const u of [U.a2, U.a3]) sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${u}', 'member', 'm') on conflict do nothing`); // 공개 채널 쓰기는 조직 멤버십을 요구한다
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch2}', 'user', '${U.a3}', '${U.o1}') on conflict do nothing`);
  asUser(U.a3, `select public.msgr_set_ai_consent(true)`); // E 역할 — 동의함(배달 조건 자체와는 무관, 대조를 명확히 하기 위해)
  asUser(U.a2, `select public.msgr_set_ai_consent(false)`); // D 역할 — 거부함
  const pending = last(asUser(U.a3, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch2}', 'user', '${U.a3}', 'text', 'E 대기 글 @bot', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]') returning id`));
  last(asUser(U.a2, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.a2}', 'text', 'D 거부 글', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]') returning id`));
  ageScan(bot.crew_id); asAnon(`select public.msgr_bot_updates('${bot.token}')`); // 1차 폴 — D 글은 거부라 건너뛰지만 커서가 E의 대기 글을 앞질러선 안 된다
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch2}', 'crew', '${bot.crew_id}', '${U.o1}')`); // 뒤늦게 초대
  ageScan(bot.crew_id);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  const got = ups.some((u) => u.message.message_id === Number(pending));
  assert.ok(got, '초대 뒤 대기 글이 배달돼야 한다 — 거부 글의 커서 전진이 이 글을 앞지르면 영구히 유실된다');
  asUser(U.a2, `select public.msgr_set_ai_consent(true)`);
});

test('변이: 거부 글에서 커서를 무조건 전진시키는(되돌린) L-1을 다시 넣으면 위 대기 글 배달이 깨진다 — red 확인', { skip }, () => {
  const orig = readFileSync(mig(MERGED), 'utf8');
  const anchor = "   continue;\n end if;\n if not msgr_cc_delivery_allowed(b.crew_id,s.id) and s.author_kind='user'";
  assert.equal((orig.match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) || []).length, 1, '앵커가 정확히 1곳이어야 한다');
  sql(orig.replace(anchor, "   declined_max:=greatest(coalesce(declined_max,0),s.id);\n   continue;\n end if;\n if not msgr_cc_delivery_allowed(b.crew_id,s.id) and s.author_kind='user'")
    .replace('r_json jsonb; -- 2026-09-27 최종 합본(H1)', 'r_json jsonb; declined_max bigint; -- 2026-09-27 최종 합본(H1)')
    .replace('end $function$\n;', " if declined_max is not null then update msgr_crews c set cursor_msg_id=declined_max where c.id=b.crew_id and c.cursor_msg_id<declined_max; end if;\nend $function$\n;"));
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('CursorMutOrg', 'cursormut1', '${U.o1}') returning id`));
  const ch = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','general')`));
  const ch2 = last(asUser(U.o1, `select public.msgr_create_channel('${org}','public','later')`));
  const bot = JSON.parse(last(asUser(U.o1, `select public.msgr_bot_create('${org}', 'hermes', 'CursorMutBot')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  for (const u of [U.a2, U.a3]) sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${u}', 'member', 'm') on conflict do nothing`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch2}', 'user', '${U.a3}', '${U.o1}') on conflict do nothing`);
  asUser(U.a3, `select public.msgr_set_ai_consent(true)`);
  asUser(U.a2, `select public.msgr_set_ai_consent(false)`);
  const pending = last(asUser(U.a3, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch2}', 'user', '${U.a3}', 'text', 'E 대기 글 @bot', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]') returning id`));
  last(asUser(U.a2, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${ch}', 'user', '${U.a2}', 'text', 'D 거부 글', '[{"kind":"crew","id":"${bot.crew_id}","role":"to"}]') returning id`));
  ageScan(bot.crew_id); asAnon(`select public.msgr_bot_updates('${bot.token}')`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch2}', 'crew', '${bot.crew_id}', '${U.o1}')`);
  ageScan(bot.crew_id);
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`));
  const got = ups.some((u) => u.message.message_id === Number(pending));
  assert.equal(got, false, 'L-1을 되살리면 커서가 대기 글을 앞질러 초대해도 영구히 배달되지 않아야 한다(변이가 잡힘)');
  sql(orig); // 원래(되돌린) 정의로 복구
  asUser(U.a2, `select public.msgr_set_ai_consent(true)`);
});
