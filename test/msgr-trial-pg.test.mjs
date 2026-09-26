// 조직 무료 기간 30일 + 유료 구독 자리(유건 결정 2026-09-26, 저녁 2차 정정: 조직 단위 유료 구독·결제는 웹에서·이번엔 판정 자리만).
// 잠그는 계약: (1) 새 조직은 만든 시각부터 30일 무료 — 무료 기간 중엔 기존 좌석·채널 한도가 적용되지 않는다.
//   (2) 기간이 끝나면 기존 한도(좌석 3·공개 채널 1)로 돌아가되, 이미 넘긴 기존 멤버·채널은 그대로 둔다(새로 늘리는 것만 막는다).
//   (3) 연장(msgr_extend_trial)은 service_role 전용 — 앱 안에 쿠폰 입력 화면을 두지 않는다(App Store 3.1.1).
//   (4) 연장되면 알림함이 쓰는 서버 표(msgr_org_announcements)에 안내가 남는다.
//   (5) 일반 사용자는 trial_ends_at·paid_until 열을 직접 못 바꾼다(테이블 grant가 이미 막는다 — RLS 정책 없음).
//   (6) msgr_org_entitled(org) = 무료 기간 중 OR paid_until 미래. entitled=false 조직은 크루 텍스트·결재 카드 삽입만 막힌다
//       (kind=system 안내, 사람 메시지, 개인 공간(org_id null)은 영향 없음) — 게이트웨이 1차 방어의 DB 쪽 2차 방어선.
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

test('기간 종료 뒤 4번째 거부, 기존 멤버는 유지', { skip }, () => {
  invite(ORG2, U.o2, U.b2); invite(ORG2, U.o2, U.b3); // 소유자 포함 3명
  expireTrial(ORG2);
  assert.equal(activeCount(ORG2), 3, '만료 직후에도 기존 3명은 그대로');
  const r = accept(U.b4, makeInviteCode(ORG2, U.o2));
  assert.notEqual(r.status, 0, '무료 기간이 끝나면 원래 좌석 한도(3)가 다시 적용된다');
  assert.match(r.stderr, /msgr_seat_limit/);
  assert.equal(activeCount(ORG2), 3, '거부된 뒤에도 기존 3명은 지워지거나 내보내지지 않는다');
});

test('무료 기간 중 공개 채널 2개 허용, 종료 뒤 3번째 거부·기존 채널 유지', { skip }, () => {
  const ch1 = last(asUser(U.o3, `select public.msgr_create_channel('${ORG3}','public','ch1')`));
  const ch2 = last(asUser(U.o3, `select public.msgr_create_channel('${ORG3}','public','ch2')`)); // 무료 조직 기본 한도(1개)를 넘지만 무료 기간이라 허용
  assert.ok(ch1 && ch2 && ch1 !== ch2);
  expireTrial(ORG3);
  const r = asUserRaw(U.o3, `select public.msgr_create_channel('${ORG3}','public','ch3')`);
  assert.notEqual(r.status, 0, '무료 기간이 끝나면 공개 채널 1개 한도가 다시 적용된다');
  assert.match(r.stderr, /msgr_channel_limit/);
  const cnt = Number(sql(`select count(*) from public.msgr_channels where org_id = '${ORG3}' and kind = 'public' and archived_at is null`));
  assert.equal(cnt, 2, '거부된 뒤에도 기존 채널 2개는 보관·삭제되지 않는다');
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

test('변이(비교 부호 뒤집기)는 무료 기간 중 허용을 거부로 바꾼다 — red 확인', { skip }, () => {
  // 원래: trial_ends_at > now(). 뒤집으면 갓 만든 조직도 "무료 기간이 이미 끝난 것"으로 오판해야 한다.
  sql(`create or replace function public.msgr_org_trial_active(org uuid) returns boolean
    language sql stable security definer set search_path = public, pg_temp as $$
      select coalesce((select e.trial_ends_at <= now() from public.msgr_org_entitlements e where e.org_id = org), false)
    $$`);
  const org = last(asUser(U.o1, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Mutant', 'mutant1', '${U.o1}') returning id`));
  invite(org, U.o1, U.a2); invite(org, U.o1, U.a3); // 소유자 포함 3명 — 갓 만든 조직이라 정상 코드라면 무료 기간
  const r = accept(U.a4, makeInviteCode(org, U.o1)); // 정상 코드라면 4번째도 허용돼야 하지만
  assert.notEqual(r.status, 0, '뒤집힌 비교는 갓 만든 조직도 무료 기간이 끝난 것으로 오판해 4번째를 거부한다(정상 코드라면 통과) — 변이가 잡힌다');
  assert.match(r.stderr, /msgr_seat_limit/);
});
