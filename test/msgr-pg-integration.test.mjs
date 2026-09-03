// 팀 메신저 스키마(20260903120000_msgr.sql) 실행 검증 — SQL·RLS·트리거를 **실제 Postgres**에 적용해 돌린다.
// 경계표는 test/helpers/msgr-cases.mjs(단일 정본). ARGO_PG_TEST_URL 미설정이면 전부 skip(일반 npm test 무영향).
// 실행: `npm run test:pg` (scripts/billing-pg-drill.sh — 파일마다 별도 임시 DB). 사용자 흉내: set role authenticated +
// argo.uid 세션 변수(auth.uid() 스텁이 읽는다) — 슈퍼유저는 RLS를 우회하므로 반드시 역할을 낮춰 실행한다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES, ROLE_MATRIX, FREE_SEATS, FREE_PUBLIC_CHANNELS } from './helpers/msgr-cases.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  removed: '55555555-5555-4555-8555-555555555555', outsider: '66666666-6666-4666-8666-666666666666',
  svc: '77777777-7777-4777-8777-777777777777', extra: '88888888-8888-4888-8888-888888888888',
};

function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();                 // 슈퍼유저(RLS 우회) — 시드·관찰 전용
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
// denied 기본 정규식은 RLS·권한만(msgr_ 접두 예외는 명시 정규식으로 — 검수 MEDIUM-7: 이 스키마는 이름이 전부 msgr_라 무의미한 안전망)
const denied = (uid, q, re = /row-level security policy|permission denied for/i) => { const r = asUserRaw(uid, q); assert.notEqual(r.status, 0, `허용됨: ${q.slice(0, 80)}`); assert.match(r.stderr, re); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';        // set_config 출력 뒤 마지막 결과 줄

let ORG, PUB, PRIV, CREW, CREW_SVC;
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
    grant usage on schema auth to anon, authenticated, service_role; -- 정책 본문의 auth.uid()는 호출 역할로 평가된다(실 Supabase와 동일 권한)
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    -- auth.uid() 스텁: 세션 변수 argo.uid — asUser()가 set_config로 사용자를 흉내 낸다
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    -- storage 스텁(정책 문법·foldername 계약만) — 실 Supabase의 storage.objects와 같은 열 이름
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    -- realtime 스텁: 방송을 realtime.sent에 기록해 payload·topic·private를 단언한다
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
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql',
    '20260903120000_msgr.sql']) psql(['-f', mig(f)]); // 배포될 그 파일을 그대로 적용
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`); // 체험 창 밖
  // 시드: owner가 조직 생성(트리거가 owner 멤버·free 자격 생성) → admin/member/guest/removed 초대 → 공개·비공개 채널 → 크루 2개
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member'], [U.guest, 'guest']]) {
    sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`); // 시드 동안 좌석 넉넉히(좌석 테스트는 별도)
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG, `초대 수락 ${role}`);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role, removed_at) values ('${ORG}', '${U.removed}', 'member', now())`); // 제거된 멤버
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.svc}', 'member')`);                        // 상주 노드 서비스 계정
  PUB = last(asUser(U.owner, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'public', 'general', '${U.owner}') returning id`));
  PRIV = last(asUser(U.admin, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'private', 'secret', '${U.admin}') returning id`));
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.guest}', '${U.admin}')`);
  CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean-ax-abcd', 'seoyun', '서윤') returning id`));
  CREW_SVC = last(asUser(U.svc, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values ('${ORG}', '${U.svc}', 'lean-node', 'node-crew', '노드', 'resident') returning id`));
});

test('조직 생성: 생성자가 owner 멤버로 자동 등록·free 자격 행·감사 행. 비멤버·제거 멤버는 조직이 보이지 않는다', { skip }, () => {
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.owner}'`), 'owner');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'org.create'`), '1');
  for (const uid of [U.outsider, U.removed]) assert.equal(last(asUser(uid, `select count(*) from public.msgr_orgs where id = '${ORG}'`)), '0', uid);
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_orgs where id = '${ORG}'`)), '1');
  denied(U.outsider, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('X', 'x-org', '${U.owner}')`); // 남 명의 조직 생성 불가
});

test('역할 경계표(helpers/msgr-cases): 6역할 × 9행동이 실제 RLS 판정과 일치', { skip }, () => {
  const probes = {
    readPublicChannel: (u) => last(asUser(u, `select count(*) from public.msgr_channels where id = '${PUB}'`)) === '1',
    postPublicChannel: (u) => asUserRaw(u, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body) values ('${ORG}', '${PUB}', 'user', '${u}', 'hi')`).status === 0,
    createChannel: (u) => asUserRaw(u, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'private', 'p-${u.slice(0, 4)}', '${u}')`).status === 0,
    inviteMember: (u) => asUserRaw(u, `insert into public.msgr_invites (org_id, created_by) values ('${ORG}', '${u}')`).status === 0,
    removeMember: (u) => last(asUser(u, `update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.extra}' returning 1`)) === '1',
    registerCrew: (u) => asUserRaw(u, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${u}', 'ws-${u.slice(0, 4)}', 'c', 'c')`).status === 0,
    readAudit: (u) => Number(last(asUser(u, `select count(*) from public.msgr_audit_log where org_id = '${ORG}'`))) > 0,
    readInvitedPrivateChannel: (u) => last(asUser(u, `select count(*) from public.msgr_channels where id = '${PRIV}'`)) === '1',
    editPolicy: (u) => last(asUser(u, `update public.msgr_org_policies set updated_at = now() where org_id = '${ORG}' returning 1`)) === '1', // RLS update는 거절 대신 0행
  };
  for (const action of Object.keys(ROLE_MATRIX)) {
    for (const role of ROLES) {
      if (action === 'removeMember') sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.extra}', 'member') on conflict (org_id, user_id) do update set removed_at = null`);
      if (action === 'readInvitedPrivateChannel' && ['owner', 'member'].includes(role)) { // owner·member는 초대돼야 읽는다 — 초대 후 판정
        sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PRIV}', 'user', '${U[role]}') on conflict do nothing`);
      }
      const got = probes[action](U[role]);
      assert.equal(got, ROLE_MATRIX[action].includes(role), `${action} × ${role}`);
    }
  }
  // 프로브 잔재 청소 — 뒤 테스트가 시드만 보게(개수 단언의 격리)
  sql(`delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_id in ('${U.owner}', '${U.member}')`);
  sql(`delete from public.msgr_org_members where user_id = '${U.extra}'`);
  sql(`delete from public.msgr_messages where org_id = '${ORG}' and body = 'hi'`);
  sql(`delete from public.msgr_channels where org_id = '${ORG}' and name like 'p-%'`);
  sql(`delete from public.msgr_crews where org_id = '${ORG}' and ws_id like 'ws-%'`);
  sql(`delete from public.msgr_invites where org_id = '${ORG}' and accepted_at is null`);
});

test('초대 흐름: 코드 1회·만료 거부, 수락 후 역할 반영, admin은 owner 행을 못 바꾸고 owner만 소유권 이전', { skip }, () => {
  const code = last(asUser(U.admin, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.admin}') returning code`));
  assert.equal(last(asUser(U.extra, `select public.msgr_accept_invite('${code}')`)), ORG);
  assert.equal(sql(`select display_name from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.extra}'`), 'extra', '수락 시 display_name = 이메일 앞부분');
  const inv2 = last(asUser(U.owner, `insert into public.msgr_invites (org_id, created_by) values ('${ORG}', '${U.owner}') returning id`));
  assert.equal(last(asUser(U.admin, `update public.msgr_invites set accepted_by = '${U.outsider}', accepted_at = now(), created_by = '${U.admin}' where id = '${inv2}' returning 1`)), '', 'admin의 초대 위조(update) 경로 없음(검수 MEDIUM-8)');
  denied(U.outsider, `select public.msgr_accept_invite('${code}')`, /msgr_invite_invalid/);       // 재사용 불가
  const expired = last(asUser(U.admin, `insert into public.msgr_invites (org_id, created_by, expires_at) values ('${ORG}', '${U.admin}', now() - interval '1 second') returning code`));
  denied(U.outsider, `select public.msgr_accept_invite('${expired}')`, /msgr_invite_invalid/);
  denied(U.outsider, `select public.msgr_accept_invite('deadbeef')`, /msgr_invite_invalid/);
  assert.equal(last(asUser(U.admin, `update public.msgr_org_members set role = 'admin' where org_id = '${ORG}' and user_id = '${U.extra}' returning role`)), 'admin');
  assert.equal(last(asUser(U.admin, `update public.msgr_org_members set role = 'member' where org_id = '${ORG}' and user_id = '${U.owner}' returning 1`)), '', 'admin이 owner 행 변경');
  denied(U.admin, `update public.msgr_orgs set owner_user_id = '${U.admin}' where id = '${ORG}'`, /msgr_owner_only/);
  denied(U.owner, `update public.msgr_orgs set owner_user_id = '${U.outsider}' where id = '${ORG}'`, /msgr_owner_not_member/);
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set name = 'Lean2' where id = '${ORG}' returning name`)), 'Lean2'); // 일반 수정은 admin도 가능
  assert.equal(last(asUser(U.admin, `update public.msgr_orgs set name = 'Lean' where id = '${ORG}' returning name`)), 'Lean');
  // 오프보딩: removed_at → 즉시 조직·채널·메시지 불가시
  const auditBefore = Number(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'member.remove' and target_id = '${U.extra}'`));
  asUser(U.admin, `update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.extra}'`);
  assert.equal(last(asUser(U.extra, `select count(*) from public.msgr_channels where org_id = '${ORG}'`)), '0');
  assert.equal(Number(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'member.remove' and target_id = '${U.extra}'`)), auditBefore + 1);
});

test('좌석·채널 한도: free 3좌석/공개 채널 1, team은 seats·무제한, ends_at 지난 team은 free로 회귀', { skip }, () => {
  const org = last(asUser(U.outsider, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Tiny', 'tiny', '${U.outsider}') returning id`));
  const add = (uid) => sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${org}', '${uid}', 'member')`);
  add(U.extra); add(U.guest);                                                        // owner 포함 3명 = FREE_SEATS
  assert.equal(sql(`select count(*) from public.msgr_org_members where org_id = '${org}' and removed_at is null`), String(FREE_SEATS));
  assert.throws(() => add(U.member), /msgr_seat_limit/);
  assert.equal(sql(`select count(*) from public.msgr_channels where org_id = '${org}' and kind = 'public'`), '0');
  for (let i = 0; i < FREE_PUBLIC_CHANNELS; i++) asUser(U.outsider, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${org}', 'public', 'g${i}', '${U.outsider}')`);
  denied(U.outsider, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${org}', 'public', 'g-more', '${U.outsider}')`, /msgr_channel_limit/);
  asUser(U.outsider, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${org}', 'private', 'ok', '${U.outsider}')`); // 비공개는 한도 밖
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 4 where org_id = '${org}'`);
  add(U.member);                                                                    // 4번째 통과
  assert.throws(() => add(U.admin), /msgr_seat_limit/);                             // seats=4 초과
  asUser(U.outsider, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${org}', 'public', 'g-team', '${U.outsider}')`);
  sql(`update public.msgr_org_entitlements set ends_at = now() - interval '1 day' where org_id = '${org}'`);
  assert.equal(sql(`select public.msgr_org_plan('${org}')`), 'free');
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${org}' and user_id = '${U.member}'`);
  assert.throws(() => sql(`update public.msgr_org_members set removed_at = null where org_id = '${org}' and user_id = '${U.member}'`), /msgr_seat_limit/); // 되살림도 게이트
  assert.equal(sql(`update public.msgr_org_members set role = 'admin' where org_id = '${org}' and user_id = '${U.extra}' returning role`), 'admin'); // 활성→활성은 좌석 불변
});

test('is_pro(): 개인 자격 없고 체험 밖이어도 활성 Team 좌석이면 true — 제거·guest·만료 team은 false', { skip }, () => {
  const org = last(asUser(U.extra, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Seat', 'seat', '${U.extra}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${org}', '${U.removed}', 'guest')`); // 다른 team 조직 멤버가 아닌 사용자
  assert.equal(last(asUser(U.extra, 'select public.is_pro()')), 'f', 'free 조직 owner = 개인 free');
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 5 where org_id = '${org}'`);
  assert.equal(last(asUser(U.extra, 'select public.is_pro()')), 't', 'team 좌석 ⊇ Pro');
  assert.equal(last(asUser(U.removed, 'select public.is_pro()')), 'f', 'guest는 좌석이 아니다');
  sql(`update public.msgr_org_entitlements set ends_at = now() - interval '1 hour' where org_id = '${org}'`);
  assert.equal(last(asUser(U.extra, 'select public.is_pro()')), 'f', '만료 team');
  sql(`update public.msgr_org_entitlements set ends_at = null where org_id = '${org}'`);
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${org}' and user_id = '${U.extra}'`);
  assert.equal(last(asUser(U.extra, 'select public.is_pro()')), 'f', '제거된 멤버');
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${org}' and user_id = '${U.extra}'`);
  sql(`update public.msgr_orgs set deleted_at = now() where id = '${org}'`);
  assert.equal(last(asUser(U.extra, 'select public.is_pro()')), 'f', '삭제 표시된 조직');
  sql(`update public.msgr_orgs set deleted_at = null where id = '${org}'`);
  // 개인 entitlements 경로 회귀 없음(20260730050000 경계 유지)
  sql(`insert into public.entitlements (user_id, plan) values ('${U.outsider}', 'pro')`);
  assert.equal(last(asUser(U.outsider, 'select public.is_pro()')), 't');
  sql(`delete from public.entitlements where user_id = '${U.outsider}'`);
});

test('메시지: 작성자 위장·타인 크루 명의·detached 크루·보관 채널·타 채널 답글 거부, org_id 위조는 채널 값으로 덮임, client_msg_id 멱등', { skip }, () => {
  const ins = (u, cols, vals) => asUser(u, `insert into public.msgr_messages (${cols}) values (${vals}) returning id`);
  const m1 = last(ins(U.member, 'org_id, channel_id, author_kind, author_user_id, body', `'${U.outsider}', '${PUB}', 'user', '${U.member}', 'first'`)); // org_id 엉터리
  assert.equal(sql(`select org_id from public.msgr_messages where id = ${m1}`), ORG, '트리거가 채널의 org로 덮는다');
  denied(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.member}', 'as-member')`);   // 위장
  denied(U.admin, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body) values ('${PUB}', 'crew', '${CREW}', 'as-crew')`);              // 남의 크루
  denied(U.guest, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.guest}', 'g')`);         // guest 공개 채널
  const c1 = last(ins(U.member, 'channel_id, author_kind, crew_id, body, client_msg_id, reply_to', `'${PUB}', 'crew', '${CREW}', '답변', 'reply:${CREW}:${m1}', ${m1}`));
  assert.equal(sql(`select thread_root from public.msgr_messages where id = ${c1}`), m1, 'thread_root는 reply_to로 채움');
  const dup = asUserRaw(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, client_msg_id) values ('${PUB}', 'crew', '${CREW}', '답변2', 'reply:${CREW}:${m1}')`);
  assert.notEqual(dup.status, 0); assert.match(dup.stderr, /msgr_messages_client_id|duplicate key/);
  denied(U.member, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, reply_to) values ('${PRIV}', 'user', '${U.member}', 'x', ${m1})`, /msgr_reply_cross_channel|row-level security/); // BEFORE 트리거(타 채널 답글)가 RLS보다 먼저 막는다
  denied(U.owner, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, reply_to) values ('${PRIV}', 'user', '${U.owner}', 'x', ${m1})`, /msgr_reply_cross_channel/); // 쓰기 권한이 있어도 타 채널 답글은 트리거가 거부
  sql(`update public.msgr_crews set status = 'detached' where id = '${CREW}'`);
  denied(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body) values ('${PUB}', 'crew', '${CREW}', 'detached')`);
  sql(`update public.msgr_crews set status = 'active' where id = '${CREW}'`);
  sql(`update public.msgr_channels set archived_at = now() where id = '${PUB}'`);
  let archivedRead;
  try {
    denied(U.owner, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.owner}', 'archived')`);
    archivedRead = last(asUser(U.owner, `select count(*) from public.msgr_messages where channel_id = '${PUB}'`));
  } finally {
    sql(`update public.msgr_channels set archived_at = null where id = '${PUB}'`); // 단언 실패가 뒤 테스트를 연쇄로 깨지 않게 먼저 원복
  }
  assert.equal(archivedRead, sql(`select count(*) from public.msgr_messages where channel_id = '${PUB}'`), '보관 채널도 읽기는 유지');
  // 편집은 본인 글만
  assert.equal(last(asUser(U.admin, `update public.msgr_messages set body = 'hack' where id = ${m1} returning 1`)), '');
  assert.equal(last(asUser(U.member, `update public.msgr_messages set edited_at = now(), body = 'first!' where id = ${m1} returning body`)), 'first!');
  // 상주 노드(서비스 계정)도 같은 경로로 자기 크루 명의 발화
  assert.match(last(ins(U.svc, 'channel_id, author_kind, crew_id, body', `'${PUB}', 'crew', '${CREW_SVC}', '노드 답변'`)), /^\d+$/);
});

test('Realtime 방송: insert마다 org:<id> private topic으로 본문 없는 payload, 타이핑 송신·수신 정책은 멤버만', { skip }, () => {
  sql('delete from realtime.sent');
  const id = last(asUser(U.owner, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions) values ('${PUB}', 'user', '${U.owner}', '비밀 본문', '[{"kind":"crew","id":"${CREW}"}]') returning id`));
  const row = sql(`select event || '|' || topic || '|' || private::text || '|' || (payload ? 'body')::text || '|' || (payload->>'id') || '|' || (payload->'mentions'->0->>'id') from realtime.sent`);
  assert.equal(row, `message|org:${ORG}|true|false|${id}|${CREW}`);
  sql(`delete from realtime.messages; insert into realtime.messages (topic, extension, payload) values ('org:${ORG}', 'broadcast', '{}')`); // 수신 게이트는 심어 둔 행의 가시성으로(검수 MEDIUM-6: 0행 필터와 실제 0행을 구분)
  const recv = (u, topic) => last(asUser(u, `select set_config('realtime.topic', '${topic}', false); select count(*) from realtime.messages`));
  const canSend = (u, topic) => asUserRaw(u, `select set_config('realtime.topic', '${topic}', false); insert into realtime.messages (topic, extension, payload) values ('${topic}', 'broadcast', '{}')`).status === 0;
  assert.equal(recv(U.member, `org:${ORG}`), '1'); assert.equal(canSend(U.member, `org:${ORG}`), true);
  assert.equal(recv(U.outsider, `org:${ORG}`), '0'); assert.equal(canSend(U.outsider, `org:${ORG}`), false);
  assert.equal(recv(U.removed, `org:${ORG}`), '0'); assert.equal(canSend(U.removed, `org:${ORG}`), false);
  assert.equal(recv(U.member, 'org:not-a-uuid'), '0', '형식 불일치 topic은 예외가 아니라 0행');
  assert.equal(asUserRaw(U.member, `select set_config('realtime.topic', 'org:${ORG}', false); insert into realtime.messages (topic, extension, payload) values ('org:${ORG}', 'presence', '{}')`).status === 0, false, 'presence는 1차 미허용');
});

test('결재 미러: 브리지(크루 소유자)만 pending 생성, 확정은 소유자만·1회만, 확정 시 방송+감사', { skip }, () => {
  denied(U.admin, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action) values ('${ORG}', '${PUB}', '${CREW}', 'ap-1', '메일 발송')`);
  const ap = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action) values ('${ORG}', '${PUB}', '${CREW}', 'ap-1', '메일 발송') returning id`));
  assert.equal(last(asUser(U.owner, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.owner}', decided_at = now() where id = '${ap}' returning 1`)), '', 'owner 역할이라도 남의 크루 결재 불가');
  assert.equal(last(asUser(U.admin, `select status from public.msgr_crew_approvals where id = '${ap}'`)), 'pending', '멤버는 카드가 보인다');
  denied(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.admin}' where id = '${ap}'`); // decided_by 위조
  sql('delete from realtime.sent');
  assert.equal(last(asUser(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.member}', decided_at = now() where id = '${ap}' returning status`)), 'approved');
  assert.equal(sql(`select event || '|' || (payload->>'status') from realtime.sent`), 'approval|approved');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'approval.approved' and target_id = 'ap-1'`), '1');
  assert.equal(last(asUser(U.member, `update public.msgr_crew_approvals set status = 'rejected', decided_by = '${U.member}' where id = '${ap}' returning 1`)), '', '확정은 1회');
});

test('크루 행: admin은 타인 크루 detach만(허용 범위·커서 불변), 소유자는 커서·하트비트·허용 범위 갱신, 남의 크루 등록 불가', { skip }, () => {
  denied(U.admin, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean-ax-abcd', 'x', 'x')`);
  assert.equal(last(asUser(U.member, `update public.msgr_crews set cursor_msg_id = 42, last_seen_at = now(), allow = 'list', allow_users = array['${U.owner}'::uuid] where id = '${CREW}' returning cursor_msg_id`)), '42');
  denied(U.admin, `update public.msgr_crews set allow = 'all' where id = '${CREW}'`);
  denied(U.admin, `update public.msgr_crews set cursor_msg_id = 0 where id = '${CREW}'`);
  assert.equal(last(asUser(U.admin, `update public.msgr_crews set status = 'detached' where id = '${CREW}' returning status`)), 'detached');
  assert.equal(last(asUser(U.member, `update public.msgr_crews set status = 'active' where id = '${CREW}' returning status`)), 'active');
  assert.equal(last(asUser(U.guest, `select count(*) from public.msgr_crews where org_id = '${ORG}'`)), sql(`select count(*) from public.msgr_crews where org_id = '${ORG}'`), 'guest도 크루 목록은 본다(멘션 대상)');
});

test('첨부·Storage 경로: 메시지 작성자만 첨부 행, 버킷 msgr 1세그먼트 조직 멤버십', { skip }, () => {
  const m = last(asUser(U.owner, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.owner}', 'file') returning id`));
  denied(U.admin, `insert into public.msgr_attachments (message_id, org_id, storage_path, name) values (${m}, '${ORG}', '${ORG}/${PUB}/${m}/a.png', 'a.png')`);
  asUser(U.owner, `insert into public.msgr_attachments (message_id, org_id, storage_path, name) values (${m}, '${ORG}', '${ORG}/${PUB}/${m}/a.png', 'a.png')`);
  assert.equal(last(asUser(U.guest, `select count(*) from public.msgr_attachments where message_id = ${m}`)), '0', 'guest는 공개 채널 첨부 불가시');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_attachments where message_id = ${m}`)), '1');
  asUser(U.member, `insert into storage.objects (bucket_id, name) values ('msgr', '${ORG}/${PUB}/${m}/a.png')`);
  denied(U.outsider, `insert into storage.objects (bucket_id, name) values ('msgr', '${ORG}/x/y/z.png')`);
  assert.equal(last(asUser(U.outsider, `select count(*) from storage.objects where bucket_id = 'msgr'`)), '0');
  assert.equal(last(asUser(U.guest, `select count(*) from storage.objects where bucket_id = 'msgr'`)), '0', '공개 채널 첨부는 guest 불가시 — 버킷 정책은 채널 단위(검수 HIGH-5: authenticated 직접 다운로드 경로)');
  assert.equal(last(asUser(U.member, `select count(*) from storage.objects where bucket_id = 'msgr'`)), '1');
  asUser(U.admin, `insert into storage.objects (bucket_id, name) values ('msgr', '${ORG}/${PRIV}/1/secret.pdf')`);
  assert.equal(last(asUser(U.guest, `select count(*) from storage.objects where name like '%secret.pdf'`)), '1', '초대된 비공개 채널 첨부는 guest도');
  assert.equal(last(asUser(U.member, `select count(*) from storage.objects where name like '%secret.pdf'`)), '0', '비공개 채널 밖 멤버는 불가시');
  denied(U.member, `insert into storage.objects (bucket_id, name) values ('msgr', '${ORG}/${PRIV}/2/x.pdf')`);
  denied(U.member, `insert into storage.objects (bucket_id, name) values ('msgr', 'not-a-uuid/x.png')`, /row-level security/); // 형식 불일치 경로는 캐스트 예외가 아니라 정책 거부

});

test('권한: anon은 멤버십 함수 실행 불가, authenticated는 감사 직접 기록 불가', { skip }, () => {
  const r = psqlRaw(['-c', `set role anon; select public.msgr_is_member('${ORG}')`]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /permission denied/i);
  denied(U.owner, `select public.msgr_audit('${ORG}', 'fake', 'x', 'y')`, /permission denied/i);
  denied(U.owner, `insert into public.msgr_audit_log (org_id, action) values ('${ORG}', 'fake')`);
  denied(U.owner, `update public.msgr_org_entitlements set plan = 'team' where org_id = '${ORG}'`); // 자기 승격 불가
});

test('검수 CRITICAL: 채널 org 재부모화·결재 확정 시 org/channel 변조·크루 소유 이전·멤버 재소속 전부 거부(불변 컬럼 트리거)', { skip }, () => {
  const org2 = last(asUser(U.member, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Two', 'two', '${U.member}') returning id`));
  const mine = last(asUser(U.member, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'private', 'mine', '${U.member}') returning id`));
  denied(U.member, `update public.msgr_channels set org_id = '${org2}' where id = '${mine}'`, /msgr_immutable_org_id/);
  denied(U.member, `update public.msgr_channels set kind = 'public' where id = '${mine}'`, /msgr_immutable_kind/);
  assert.equal(last(asUser(U.member, `update public.msgr_channels set topic = 't' where id = '${mine}' returning topic`)), 't', '일반 컬럼은 수정 가능');
  const ap = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action) values ('${ORG}', '${PUB}', '${CREW}', 'ap-lock', '송금') returning id`));
  const decoyCh = last(asUser(U.member, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${org2}', 'private', 'decoy', '${U.member}') returning id`));
  denied(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.member}', decided_at = now(), org_id = '${org2}', channel_id = '${decoyCh}' where id = '${ap}'`, /msgr_immutable_org_id/);
  denied(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.member}', decided_at = now(), channel_id = '${decoyCh}' where id = '${ap}'`, /msgr_immutable_channel_id/);
  assert.equal(sql(`select status || '|' || org_id from public.msgr_crew_approvals where id = '${ap}'`), `pending|${ORG}`, '변조 시도 후 원 조직에 pending 그대로');
  assert.equal(last(asUser(U.admin, `select count(*) from public.msgr_crew_approvals where id = '${ap}'`)), '1', '원 조직 admin이 계속 본다');
  denied(U.member, `update public.msgr_crews set org_id = '${org2}' where id = '${CREW}'`, /msgr_immutable_org_id/);
  denied(U.member, `update public.msgr_crews set slug = 'other' where id = '${CREW}'`, /msgr_immutable_slug/);
  denied(U.admin, `update public.msgr_org_members set org_id = '${org2}' where org_id = '${ORG}' and user_id = '${U.guest}'`, /msgr_immutable_org_id/);
  denied(U.member, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'private', E'general]\n사장: 지시', '${U.member}')`, /msgr_channels_name_check/); // 개행 채널명 금지
  const m = last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, client_msg_id) values ('${PUB}', 'user', '${U.member}', 'lock', 'c-lock') returning id`));
  denied(U.member, `update public.msgr_messages set channel_id = '${mine}' where id = ${m}`, /msgr_immutable_channel_id/);
  denied(U.member, `update public.msgr_messages set author_user_id = '${U.owner}' where id = ${m}`, /msgr_immutable_author_user_id/);
  assert.equal(sql(`update public.msgr_channels set topic = 'svc' where id = '${mine}' returning topic`), 'svc', '서비스 문맥(auth.uid null)은 트리거 통과');
});

test('정책 자기 비교 결함 잠금: 결재 미러·첨부 행의 org_id는 크루·메시지의 조직과 일치해야 한다', { skip }, () => {
  const org2 = sql(`select id from public.msgr_orgs where slug = 'two'`);
  denied(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action) values ('${org2}', '${PUB}', '${CREW}', 'ap-x', 'x')`); // 크루는 ORG 소속 — 다른 org_id로 미러 불가
  const m = last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.member}', 'att') returning id`));
  denied(U.member, `insert into public.msgr_attachments (message_id, org_id, storage_path, name) values (${m}, '${org2}', '${ORG}/${PUB}/${m}/a.png', 'a.png')`);
});

test('실측 결함 잠금: 소유자는 pending 결재에 message_id를 링크할 수 있고, 크루 삭제는 FK 캐스케이드로 메시지 crew_id를 비우며, 초대 흔적은 계정 삭제를 막지 않는다', { skip }, () => {
  const ap = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action) values ('${ORG}', '${PUB}', '${CREW}', 'ap-link', '링크') returning id`));
  const card = last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${PUB}', 'crew', '${CREW}', 'approval_card', '카드') returning id`));
  assert.equal(last(asUser(U.member, `update public.msgr_crew_approvals set message_id = ${card} where id = '${ap}' returning message_id`)), card, '브리지의 카드 링크(pending 유지)');
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set message_id = null where id = '${ap}' returning 1`)), '', '비소유자는 링크도 불가');
  denied(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.admin}' where id = '${ap}'`); // 확정은 본인 명의
  assert.equal(last(asUser(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.member}', decided_at = now() where id = '${ap}' returning status`)), 'approved');
  // 크루 삭제 → FK on delete set null 캐스케이드가 불변 트리거에 막히지 않는다
  const tmpCrew = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean-ax-abcd', 'tmp', '임시') returning id`));
  const cm = last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body) values ('${PUB}', 'crew', '${tmpCrew}', '임시 발화') returning id`));
  assert.equal(last(asUser(U.member, `delete from public.msgr_crews where id = '${tmpCrew}' returning 1`)), '1');
  assert.equal(sql(`select coalesce(crew_id::text, 'null') from public.msgr_messages where id = ${cm}`), 'null');
  // 초대를 수락한 계정 삭제(auth 관리자 경로) — 초대 행이 막지 않는다
  sql(`insert into auth.users (id, created_at, email) values ('99999999-9999-4999-8999-999999999999', now(), 'temp@example.test')`);
  const code = last(asUser(U.admin, `insert into public.msgr_invites (org_id, created_by) values ('${ORG}', '${U.admin}') returning code`));
  sql(`update public.msgr_org_entitlements set seats = 20 where org_id = '${ORG}'`);
  asUser('99999999-9999-4999-8999-999999999999', `select public.msgr_accept_invite('${code}')`);
  sql(`delete from auth.users where id = '99999999-9999-4999-8999-999999999999'`);
  assert.equal(sql(`select coalesce(accepted_by::text, 'null') from public.msgr_invites where code = '${code}'`), 'null');
});

test('검수 HIGH-4: client_msg_id는 작성자 축 포함 — 멤버가 reply:<crew>:<msg>를 선점해도 크루 답글은 들어간다', { skip }, () => {
  const m = last(asUser(U.owner, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.owner}', 'src') returning id`));
  asUser(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, client_msg_id) values ('${PUB}', 'user', '${U.admin}', '선점', 'reply:${CREW}:${m}')`);
  assert.match(last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, client_msg_id) values ('${PUB}', 'crew', '${CREW}', '진짜 답', 'reply:${CREW}:${m}') returning id`)), /^\d+$/);
  const dup = asUserRaw(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, client_msg_id) values ('${PUB}', 'crew', '${CREW}', '재실행', 'reply:${CREW}:${m}')`);
  assert.notEqual(dup.status, 0); assert.match(dup.stderr, /msgr_messages_client_id/, '같은 크루의 재실행은 여전히 1건');
});

test('검수 HIGH-3: 좌석 게이트는 동시 insert를 직렬화한다(advisory lock) — free 3좌석에 4명이 들어가지 않는다', { skip }, async () => {
  const org = last(asUser(U.extra, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Race', 'race', '${U.extra}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${org}', '${U.guest}', 'member')`); // 2/3
  const aSql = `begin; insert into public.msgr_org_members (org_id, user_id, role) values ('${org}', '${U.member}', 'member'); select pg_sleep(1.5); commit;`;
  const a = spawn('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-c', aSql]);
  const aDone = new Promise((res, rej) => { a.on('error', rej); a.on('close', (code) => (code === 0 ? res() : rej(new Error(`A 실패 exit ${code}`)))); });
  await new Promise((r) => setTimeout(r, 400));
  const t0 = Date.now();
  const b = psqlRaw(['-c', `insert into public.msgr_org_members (org_id, user_id, role) values ('${org}', '${U.admin}', 'member')`]);
  const elapsed = Date.now() - t0;
  await aDone;
  assert.notEqual(b.status, 0, 'B가 통과 — 레이스 재현'); assert.match(b.stderr, /msgr_seat_limit/);
  assert.ok(elapsed >= 800, `B가 락에 블록되지 않았다(${elapsed}ms)`);
  assert.equal(sql(`select count(*) from public.msgr_org_members where org_id = '${org}' and removed_at is null`), String(FREE_SEATS));
});

test('검수 2R: DM 멤버 정책 — 생성자만 구성, 참가자는 나가기만, 관리자 조항은 DM 제외, 구성 상한(msgr_dm_full)', { skip }, () => {
  // 멤버(생성자)가 크루 DM: 나 + 크루 + 크루 소유자(=member 본인이 소유자라 2행). 상대 사람 DM은 owner와.
  const DM = last(asUser(U.member, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'dm', 'dm:owner', '${U.member}') returning id`));
  assert.ok(DM, 'DM 채널 생성');
  assert.equal(asUserRaw(U.member, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${DM}', 'user', '${U.member}', '${U.member}'), ('${DM}', 'user', '${U.owner}', '${U.member}'), ('${DM}', 'crew', '${CREW}', '${U.member}')`).status, 0, '생성자의 3행 한 문장 insert(사람 2·크루 1)는 통과');
  // 참가자(owner — 조직 소유자이기도 하다)가 제3자를 끼워 넣기 → 거절(관리자 조항은 dm 제외)
  // BEFORE 트리거(msgr_dm_shape)가 RLS with check보다 먼저 돈다 — 어느 쪽이 막든 거절이면 된다
  denied(U.owner, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${DM}', 'user', '${U.admin}', '${U.owner}')`, /row-level security policy|msgr_dm_full/);
  // 참가자(조직 소유자)가 생성자 행을 삭제 → 0행
  assert.equal(last(asUser(U.owner, `delete from public.msgr_channel_members where channel_id = '${DM}' and member_kind = 'user' and member_id = '${U.member}' returning 1`)), '', '참가 중인 관리자도 DM에서 생성자를 축출할 수 없다');
  // 생성자가 3번째 사람 추가 → 구성 상한
  denied(U.member, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${DM}', 'user', '${U.admin}', '${U.member}')`, /msgr_dm_full/);
  // 참가자가 자기 행 삭제(나가기) → 1행
  assert.equal(last(asUser(U.owner, `delete from public.msgr_channel_members where channel_id = '${DM}' and member_kind = 'user' and member_id = '${U.owner}' returning 1`)), '1', '나가기는 허용');
  sql(`delete from public.msgr_channels where id = '${DM}'`);
});

test('조직 정책(H-0): 행 자동 생성·멤버 열람·관리자만 편집, allow 잠금이면 기존 크루 정리·소유자 변경 거절·등록은 기본값으로, crew_memory 잠금 동형, 감사 행', { skip }, () => {
  assert.equal(last(asUser(U.member, `select allow_locked from public.msgr_org_policies where org_id = '${ORG}'`)), 'f'); // 조직 생성 트리거가 만든 행
  assert.equal(last(asUser(U.outsider, `select count(*) from public.msgr_org_policies where org_id = '${ORG}'`)), '0');
  assert.equal(last(asUser(U.member, `update public.msgr_org_policies set allow_locked = true where org_id = '${ORG}' returning 1`)), ''); // 멤버는 0행
  const auditN = () => Number(last(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'policy.update' and meta->>'allow_locked' = 'true'`))); // 경계표 프로브의 무잠금 갱신은 제외
  const before = auditN();
  // 소유자가 크루를 'all'로 열어 둔 상태에서 관리자가 'owner' 잠금 → 기존 크루가 정리된다
  assert.equal(last(asUser(U.member, `update public.msgr_crews set allow = 'all' where id = '${CREW}' returning allow`)), 'all');
  assert.equal(last(asUser(U.admin, `update public.msgr_org_policies set allow_default = 'owner', allow_locked = true where org_id = '${ORG}' returning allow_locked`)), 't');
  assert.equal(last(sql(`select allow from public.msgr_crews where id = '${CREW}'`)), 'owner');
  denied(U.member, `update public.msgr_crews set allow = 'all' where id = '${CREW}'`, /msgr_policy_locked/);              // 소유자도 못 넓힌다
  assert.equal(last(asUser(U.member, `update public.msgr_crews set last_seen_at = now() where id = '${CREW}' returning allow`)), 'owner'); // 하트비트는 그대로
  assert.equal(last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, allow) values ('${ORG}', '${U.member}', 'ws-pol', 'p', 'p', 'all') returning allow`)), 'owner'); // 등록은 기본값으로 맞춤
  sql(`delete from public.msgr_crews where org_id = '${ORG}' and ws_id = 'ws-pol'`);
  // crew_memory 잠금: 기존 채널 정리·생성자도 못 켬·새 채널은 기본값
  assert.equal(last(asUser(U.admin, `update public.msgr_org_policies set crew_memory_default = false, crew_memory_locked = true where org_id = '${ORG}' returning crew_memory_locked`)), 't');
  assert.equal(last(sql(`select crew_memory from public.msgr_channels where id = '${PUB}'`)), 'f');
  denied(U.owner, `update public.msgr_channels set crew_memory = true where id = '${PUB}'`, /msgr_policy_locked/);
  assert.equal(last(asUser(U.admin, `insert into public.msgr_channels (org_id, kind, name, created_by, crew_memory) values ('${ORG}', 'private', 'pol-ch', '${U.admin}', true) returning crew_memory`)), 'f');
  sql(`delete from public.msgr_channels where org_id = '${ORG}' and name = 'pol-ch'`);
  assert.equal(last(sql(`select updated_by from public.msgr_org_policies where org_id = '${ORG}'`)), U.admin);
  assert.equal(auditN() - before, 2, '잠금 갱신 2회 = 감사 행 2건');
  // 잠금 해제 → 소유자가 다시 바꿀 수 있다(뒤 테스트 격리)
  assert.equal(last(asUser(U.admin, `update public.msgr_org_policies set allow_locked = false, crew_memory_locked = false, crew_memory_default = true where org_id = '${ORG}' returning 1`)), '1');
  assert.equal(last(asUser(U.member, `update public.msgr_crews set allow = 'list', allow_users = array['${U.owner}'::uuid] where id = '${CREW}' returning allow`)), 'list');
  assert.equal(last(asUser(U.owner, `update public.msgr_channels set crew_memory = true where id = '${PUB}' returning crew_memory`)), 't');
});
