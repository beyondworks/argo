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
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const makeInviteCode = (org, ownerId) => last(asUser(ownerId, `insert into public.msgr_invites (org_id, role, created_by) values ('${org}', 'member', '${ownerId}') returning code`));
const accept = (uid, code) => asUserRaw(uid, `select public.msgr_accept_invite('${code}')`);
const invite = (org, ownerId, memberId) => { const r = accept(memberId, makeInviteCode(org, ownerId)); if (r.status !== 0) throw new Error(`invite 실패: ${r.stderr || r.stdout}`); return last(r.stdout); };
const expireTrial = (org) => sql(`update public.msgr_org_entitlements set trial_ends_at = now() - interval '1 day' where org_id = '${org}'`);
const trialEndsAt = (org) => sql(`select trial_ends_at from public.msgr_org_entitlements where org_id = '${org}'`);
const activeCount = (org) => Number(sql(`select count(*) from public.msgr_org_members where org_id = '${org}' and removed_at is null`));

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
  const r = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body) values ('${UNCH}', 'crew', '${UNCREW}', 'text', null, null, 'nt:${UNCREW}:deadbeef', '데스크톱에서 방금 일어난 일을 알려드립니다')`);
  assert.equal(r.status, 0, 'msgrNotifyPush 모양(nt: 접두·reply_to·thread_root 둘 다 null)의 삽입은 미자격 조직에서도 허용된다');
  // 같은 크루라도 진짜 크루 턴(reply_to가 있는 일반 text)은 여전히 막힌다 — 우회 통로가 되지 않는다
  const anyMsgId = sql(`select id from public.msgr_messages where channel_id = '${UNCH}' limit 1`);
  const r2 = raw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, client_msg_id, body) values ('${UNCH}', 'crew', '${UNCREW}', 'text', ${anyMsgId}, 'nt:${UNCREW}:fakeout', '진짜 크루 턴인 척')`);
  assert.notEqual(r2.status, 0, 'reply_to가 있으면 nt: 접두를 써도 막힌다(모양이 정확히 같아야만 예외)');
  assert.match(r2.stderr, /msgr_org_unentitled/);
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
