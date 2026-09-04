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
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.guest}', 'guest')`); // 게스트는 채널 링크로만 생긴다(검수 L-3) — 시드는 슈퍼유저
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member']]) {
    sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`); // 시드 동안 좌석 넉넉히(좌석 테스트는 별도)
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG, `초대 수락 ${role}`);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role, removed_at) values ('${ORG}', '${U.removed}', 'member', now())`); // 제거된 멤버
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.svc}', 'member')`);                        // 상주 노드 서비스 계정
  PUB = last(asUser(U.owner, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'public', 'general', '${U.owner}') returning id`));
  PRIV = last(asUser(U.admin, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'private', 'secret', '${U.admin}') returning id`));
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.admin}', '${U.admin}')`); // 앱과 같게: 만든 사람은 첫 멤버(나가기 실측 뒤 생성자 예외가 '멤버 0명일 때'로 좁혀짐)
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.guest}', '${U.admin}')`);
  CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean-ax-abcd', 'seoyun', '서윤') returning id`));
  CREW_SVC = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values ('${ORG}', '${U.svc}', 'lean-node', 'node-crew', '노드', 'resident') returning id`)); // 시드는 슈퍼유저: resident는 서비스 계정 지정 뒤에만 사용자 문맥으로 등록 가능(검수 LOW-1 게이트)
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
  denied(U.owner, `update public.msgr_orgs set owner_user_id = '${U.outsider}' where id = '${ORG}'`, /msgr_transfer_needs_accept/); // J-2: 소유자도 제안 없는 직접 이전은 불가
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

test('결재권 규칙(H-1): 저위험은 크루 소유자만, 고위험은 정책(기본 admin)의 결재권자만 — 소유자 0행·관리자 확정, 정책 owner면 소유자, risk 잠김, 카드 링크는 소유자', { skip }, () => {
  const lo = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${PUB}', '${CREW}', 'ap-lo', '초안 정리', 'low') returning id`));
  const hi = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${PUB}', '${CREW}', 'ap-hi', '견적서 메일 발송', 'high') returning id`));
  assert.equal(last(sql(`select approval_high_by from public.msgr_org_policies where org_id = '${ORG}'`)), 'admin');
  // 저위험: 관리자 0행, 소유자 확정
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.admin}', decided_at = now() where id = '${lo}' returning 1`)), '');
  assert.equal(last(asUser(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.member}', decided_at = now() where id = '${lo}' returning status`)), 'approved');
  // 고위험: 소유자(비관리자)는 0행, risk 하향도 잠김, 카드 링크(pending 유지)는 소유자 가능, 관리자 확정
  denied(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.member}', decided_at = now() where id = '${hi}'`); // 소유자는 USING(링크 갱신용)은 지나고 WITH CHECK에서 막힌다 → RLS 위반 오류
  denied(U.member, `update public.msgr_crew_approvals set risk = 'low' where id = '${hi}'`, /msgr_immutable|immutable|permission|row-level/i);
  assert.equal(last(asUser(U.member, `update public.msgr_crew_approvals set message_id = null where id = '${hi}' returning status`)), 'pending');
  assert.equal(last(asUser(U.guest, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.guest}', decided_at = now() where id = '${hi}' returning 1`)), '');
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.admin}', decided_at = now() where id = '${hi}' returning status`)), 'approved');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'approval.approved' and target_id = 'ap-hi'`), '1');
  // 정책 owner → 고위험도 소유자가 확정, 관리자는 0행
  const hi2 = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${PUB}', '${CREW}', 'ap-hi2', '광고비 결제', 'high') returning id`));
  assert.equal(last(asUser(U.admin, `update public.msgr_org_policies set approval_high_by = 'owner' where org_id = '${ORG}' returning approval_high_by`)), 'owner');
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set status = 'rejected', decided_by = '${U.admin}', decided_at = now() where id = '${hi2}' returning 1`)), '');
  assert.equal(last(asUser(U.member, `update public.msgr_crew_approvals set status = 'rejected', decided_by = '${U.member}', decided_at = now() where id = '${hi2}' returning status`)), 'rejected');
  assert.equal(last(asUser(U.admin, `update public.msgr_org_policies set approval_high_by = 'admin' where org_id = '${ORG}' returning 1`)), '1');
  sql(`delete from public.msgr_crew_approvals where approval_id in ('ap-lo', 'ap-hi', 'ap-hi2')`);
});

test('허용 판정 서버 이관(H-2): msgr_can_instruct는 소유자·allow·멤버십·상태를 보고, 크루 답글(reply:<crew>:<src>)은 트리거가 원문 작성자를 재판정해 정책 밖이면 거절', { skip }, () => {
  const can = (u, author) => last(asUser(u, `select public.msgr_can_instruct('${CREW}', '${author}')`));
  sql(`update public.msgr_crews set allow = 'owner', allow_users = '{}' where id = '${CREW}'`);
  assert.equal(can(U.member, U.member), 't', '소유자는 항상');
  assert.equal(can(U.member, U.admin), 'f', "'owner'면 관리자도 못 시킨다");
  sql(`update public.msgr_crews set allow = 'list', allow_users = array['${U.admin}'::uuid, '${U.removed}'::uuid] where id = '${CREW}'`);
  assert.equal(can(U.member, U.admin), 't'); assert.equal(can(U.member, U.owner), 'f'); assert.equal(can(U.member, U.removed), 'f', '목록에 있어도 제거된 멤버는 불가');
  sql(`update public.msgr_crews set allow = 'all' where id = '${CREW}'`);
  assert.equal(can(U.member, U.guest), 't', "'all' = 활성 멤버 전원(guest 포함)"); assert.equal(can(U.member, U.outsider), 'f'); assert.equal(can(U.member, U.removed), 'f');
  sql(`update public.msgr_crews set status = 'detached' where id = '${CREW}'`); assert.equal(can(U.member, U.member), 'f', 'detached면 소유자도 불가'); sql(`update public.msgr_crews set status = 'active' where id = '${CREW}'`);
  assert.equal(last(asUser(U.member, `select public.msgr_can_instruct('00000000-0000-4000-8000-000000000000', '${U.member}')`)), 'f', '없는 크루');
  // 답글 게이트: 정책 밖 작성자의 지시에 대한 크루 답글은 서버가 거절, 소유자 원문·다른 접두(deny:)·크루 원문은 통과
  sql(`update public.msgr_crews set allow = 'owner' where id = '${CREW}'`);
  const src = last(asUser(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.admin}', '@서윤 해줘') returning id`));
  denied(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, client_msg_id, reply_to) values ('${PUB}', 'crew', '${CREW}', '답', 'reply:${CREW}:${src}', ${src})`, /msgr_not_allowed/);
  assert.match(last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id, reply_to) values ('${PUB}', 'crew', '${CREW}', 'system', '거절 안내', 'deny:${CREW}:${src}', ${src}) returning id`)), /^\d+$/, '거절 안내(deny:)는 통과');
  const own = last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.member}', '소유자 지시') returning id`));
  assert.match(last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, client_msg_id, reply_to) values ('${PUB}', 'crew', '${CREW}', '답', 'reply:${CREW}:${own}', ${own}) returning id`)), /^\d+$/, '소유자 원문 답글 통과');
  sql(`update public.msgr_crews set allow = 'all' where id = '${CREW}'`);
  assert.match(last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, client_msg_id, reply_to) values ('${PUB}', 'crew', '${CREW}', '답', 'reply:${CREW}:${src}', ${src}) returning id`)), /^\d+$/, "정책을 'all'로 열면 같은 원문 답글 통과");
  sql(`delete from public.msgr_messages where id in (${src}, ${own}) or reply_to in (${src}, ${own})`);
  sql(`update public.msgr_crews set allow = 'list', allow_users = array['${U.owner}'::uuid] where id = '${CREW}'`); // 앞 테스트가 남긴 상태로 복원
});

test('회사 크루 판별(I-1): msgr_crew_tier는 "서비스 계정 소유 + resident"만 company — 서비스 계정 지정은 관리자만·활성 멤버만, 변경은 감사', { skip }, () => {
  const tier = (u, id) => last(asUser(u, `select public.msgr_crew_tier('${id}')`));
  assert.equal(last(sql(`select service_user_id is null from public.msgr_orgs where id = '${ORG}'`)), 't');
  assert.equal(tier(U.member, CREW_SVC), 'personal', '서비스 계정 미지정이면 resident여도 personal');
  assert.equal(last(asUser(U.member, `update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}' returning 1`)), '', '멤버는 0행(RLS admin)');
  denied(U.owner, `update public.msgr_orgs set service_user_id = '${U.outsider}' where id = '${ORG}'`, /msgr_service_not_member/);
  denied(U.admin, `update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}'`, /msgr_owner_only/); // 검수 H-6: 관리자는 지정 불가(자기 지정으로 회사 크루 위조 경로)
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}' returning 1`)), '1');
  assert.equal(tier(U.member, CREW_SVC), 'company');
  assert.equal(tier(U.guest, CREW), 'personal', '사람 소유 크루는 personal');
  sql(`update public.msgr_crews set hosting = 'local' where id = '${CREW_SVC}'`);
  assert.equal(tier(U.member, CREW_SVC), 'personal', '서비스 계정 소유라도 local이면 personal(회사 크루는 노드에서만)');
  sql(`update public.msgr_crews set hosting = 'resident' where id = '${CREW_SVC}'`);
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'org.service_account'`), '1');
  assert.equal(last(asUser(U.outsider, `select public.msgr_crew_tier('${CREW_SVC}')`)), '', '비멤버는 판정 자체가 빈 값(행 없음)');
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set service_user_id = null where id = '${ORG}' returning 1`)), '1'); // 복원
});

test('채널 개인 크루 정책(I-3): read_only/blocked면 개인 크루는 소유자 지시도 channel_policy, 회사 크루는 ok, blocked는 멤버 추가 거절·전환 시 기존 개인 크루 멤버 제거·감사, 답글 게이트 연동', { skip }, () => {
  const chk = (u, crewId, author, ch) => last(asUser(u, `select public.msgr_instruct_check('${crewId}', '${author}', ${ch ? `'${ch}'` : 'null'})`));
  sql(`update public.msgr_crews set allow = 'all' where id in ('${CREW}', '${CREW_SVC}')`); // H-0 잠금 sweep이 남긴 'owner'를 되돌린다
  sql(`update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}'`);
  assert.equal(chk(U.member, CREW, U.member, PRIV), 'ok', '기본 allowed');
  assert.equal(last(asUser(U.admin, `update public.msgr_channels set personal_crews = 'read_only' where id = '${PRIV}' returning personal_crews`)), 'read_only');
  assert.equal(chk(U.member, CREW, U.member, PRIV), 'channel_policy', 'read_only: 개인 크루는 소유자도 지시 불가');
  assert.equal(chk(U.member, CREW, U.member, null), 'ok', '채널 없이 물으면 크루 규칙만');
  assert.equal(chk(U.svc, CREW_SVC, U.member, PRIV), 'ok', '회사 크루는 채널 정책 무관');
  assert.equal(chk(U.member, CREW, U.outsider, PRIV), 'channel_policy', '채널 정책이 크루 규칙보다 먼저');
  sql(`update public.msgr_channels set personal_crews = 'allowed' where id = '${PRIV}'`);
  assert.equal(chk(U.member, CREW, U.outsider, PRIV), 'crew_allow');
  // 답글 게이트 연동: read_only 채널에서 개인 크루 답글 거절
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.member}', '${U.admin}') on conflict do nothing`);
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${CREW}', '${U.admin}') on conflict do nothing`);
  const src = last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PRIV}', 'user', '${U.member}', '@서윤 해줘') returning id`));
  sql(`update public.msgr_channels set personal_crews = 'read_only' where id = '${PRIV}'`);
  denied(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, client_msg_id, reply_to) values ('${PRIV}', 'crew', '${CREW}', '답', 'reply:${CREW}:${src}', ${src})`, /msgr_not_allowed/);
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'crew' and member_id = '${CREW}'`), '1', 'read_only는 멤버 유지');
  // blocked: 전환 시 기존 개인 크루 멤버 제거 + 감사, 추가 거절, 회사 크루는 추가 가능
  assert.equal(last(asUser(U.admin, `update public.msgr_channels set personal_crews = 'blocked' where id = '${PRIV}' returning 1`)), '1');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'crew' and member_id = '${CREW}'`), '0', 'blocked 전환이 개인 크루 멤버를 제거');
  denied(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${CREW}', '${U.admin}')`, /msgr_channel_personal_blocked/);
  assert.match(last(asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${CREW_SVC}', '${U.admin}') returning member_id`)), /^[0-9a-f-]{36}$/, '회사 크루는 추가 가능');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'channel.personal_crews' and target_id = '${PRIV}'`), '4', '전환 4회(allowed→read_only→allowed→read_only→blocked) = 감사 4건');
  // 복원
  sql(`delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_id in ('${CREW_SVC}', '${U.member}')`);
  sql(`delete from public.msgr_messages where id = ${src}`);
  sql(`update public.msgr_channels set personal_crews = 'allowed' where id = '${PRIV}'`);
  sql(`update public.msgr_orgs set service_user_id = null where id = '${ORG}'`);
  sql(`update public.msgr_crews set allow = 'list', allow_users = array['${U.owner}'::uuid] where id = '${CREW}'`);
});

test('조직 문서(G-1): 전사 문서는 멤버 열람·관리자 편집, 채널 문서는 채널 열람자만·쓰기 가능 채널 멤버 편집, 갱신마다 버전+1·경로 잠김·org 위조 무력화·감사, 경로는 폴더 3종만', { skip }, () => {
  denied(U.member, `insert into public.msgr_org_docs (org_id, path, title, body, created_by, updated_by) values ('${ORG}', 'rules/handbook.md', '규칙집', '존댓말', '${U.member}', '${U.member}')`); // 멤버는 전사 문서 못 만듦
  denied(U.admin, `insert into public.msgr_org_docs (org_id, path, title, body, created_by, updated_by) values ('${ORG}', 'notes/x.md', 'x', '', '${U.admin}', '${U.admin}')`, /check constraint|violates/); // 폴더 3종만
  const d = last(asUser(U.admin, `insert into public.msgr_org_docs (org_id, path, title, body, created_by, updated_by) values ('${ORG}', 'rules/handbook.md', '규칙집', '답은 존댓말로', '${U.admin}', '${U.admin}') returning id`));
  assert.equal(last(asUser(U.guest, `select title from public.msgr_org_docs where id = '${d}'`)), '', '전사 문서는 guest에게 안 보인다(검수 MEDIUM-1 — 채널 한정 외부 계정)');
  assert.equal(last(asUser(U.outsider, `select count(*) from public.msgr_org_docs where org_id = '${ORG}'`)), '0');
  assert.equal(last(asUser(U.member, `update public.msgr_org_docs set body = '해킹' where id = '${d}' returning 1`)), '', '멤버는 전사 문서 편집 0행');
  assert.equal(last(asUser(U.admin, `update public.msgr_org_docs set body = '답은 존댓말로. 숫자는 표로.' where id = '${d}' returning version || '|' || updated_by`)), `2|${U.admin}`, '갱신마다 버전 +1');
  denied(U.admin, `update public.msgr_org_docs set path = 'rules/other.md' where id = '${d}'`, /msgr_immutable|immutable|permission|row-level/i);
  denied(U.admin, `insert into public.msgr_org_docs (org_id, path, title, created_by, updated_by) values ('${ORG}', 'rules/handbook.md', '중복', '${U.admin}', '${U.admin}')`, /duplicate key|msgr_org_docs_path/);
  // 채널 문서: 비공개 채널(PRIV) — 채널 열람자만 보고, 쓰기 가능 채널 멤버가 편집. org_id 위조는 채널의 org로 덮임
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.member}', '${U.admin}') on conflict do nothing`);
  const cd = last(asUser(U.member, `insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values ('${U.outsider}', '${PRIV}', 'glossary/terms.md', '용어집', 'CTR = 클릭률', '${U.member}', '${U.member}') returning id`));
  assert.equal(sql(`select org_id from public.msgr_org_docs where id = '${cd}'`), ORG, 'org_id 위조는 채널의 org로');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_org_docs where id = '${cd}'`)), '0', '채널 밖 owner 역할은 비공개 채널 문서를 못 본다(멤버가 아니면)');
  assert.equal(last(asUser(U.guest, `select title from public.msgr_org_docs where id = '${cd}'`)), '용어집', '초대된 guest는 본다');
  assert.equal(last(asUser(U.guest, `update public.msgr_org_docs set body = 'x' where id = '${cd}' returning version`)), '2', '채널 열람자(guest 포함)는 채널 문서를 편집한다');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action in ('doc.insert', 'doc.update') and target_kind = 'doc'`), '4', '생성 2 + 갱신 2 = 감사 4건(거절된 시도는 기록 없음)');
  assert.equal(last(asUser(U.member, `delete from public.msgr_org_docs where id = '${d}' returning 1`)), '', '멤버는 전사 문서 삭제 0행');
  assert.equal(last(asUser(U.admin, `delete from public.msgr_org_docs where id = '${d}' returning 1`)), '1');
  sql(`delete from public.msgr_org_docs where org_id = '${ORG}'`);
  sql(`delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_id = '${U.member}'`);
});

test('조직 문서 제안 결재(G-4): 크루 소유자가 org_doc 결재를 올리면(payload) 관리자만 확정하고, 승인 시 서버가 승인자 권한으로 문서를 만들거나 갱신(version+1)·감사, 거절은 미반영, payload 잠김', { skip }, () => {
  const pl = (title, body, ch = null) => `'${JSON.stringify({ scope: ch ? 'channel' : 'org', channel_id: ch, path: 'glossary/terms.md', title, body }).replace(/'/g, "''")}'::jsonb`;
  const a1 = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk, kind, payload) values ('${ORG}', '${PUB}', '${CREW}', 'ap-doc1', '조직 문서 제안 — 용어집', 'high', 'org_doc', ${pl('용어집', 'CTR = 클릭률')}) returning id`));
  denied(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.member}', decided_at = now() where id = '${a1}'`); // 소유자(비관리자)는 확정 불가(고위험)
  denied(U.member, `update public.msgr_crew_approvals set payload = ${pl('용어집', '바꿔치기')} where id = '${a1}'`, /msgr_immutable|immutable|permission|row-level/i);
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.admin}', decided_at = now() where id = '${a1}' returning status`)), 'approved');
  assert.equal(sql(`select title || '|' || body || '|' || version || '|' || (created_by = '${U.admin}') from public.msgr_org_docs where org_id = '${ORG}' and channel_id is null and path = 'glossary/terms.md'`), '용어집|CTR = 클릭률|1|true', '승인자 명의로 생성'); // boolean || text = 'true'
  const a2 = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk, kind, payload) values ('${ORG}', '${PUB}', '${CREW}', 'ap-doc2', '조직 문서 제안 — 용어집(갱신)', 'high', 'org_doc', ${pl('용어집', 'CTR = 클릭률\nCVR = 전환율')}) returning id`));
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.admin}', decided_at = now() where id = '${a2}' returning status`)), 'approved');
  assert.equal(sql(`select version || '|' || (updated_by = '${U.admin}') from public.msgr_org_docs where org_id = '${ORG}' and channel_id is null and path = 'glossary/terms.md'`), '2|true', '같은 경로는 갱신(version+1)');
  const a3 = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk, kind, payload) values ('${ORG}', '${PUB}', '${CREW}', 'ap-doc3', '제안', 'high', 'org_doc', ${pl('용어집', '거절될 내용')}) returning id`));
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set status = 'rejected', decided_by = '${U.admin}', decided_at = now() where id = '${a3}' returning status`)), 'rejected');
  assert.equal(sql(`select version from public.msgr_org_docs where org_id = '${ORG}' and channel_id is null and path = 'glossary/terms.md'`), '2', '거절은 미반영');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'doc.proposal.applied'`), '2');
  // 채널 범위 제안: 채널의 org와 다른 채널 id는 거절
  const a4 = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk, kind, payload) values ('${ORG}', '${PUB}', '${CREW}', 'ap-doc4', '채널 제안', 'high', 'org_doc', ${pl('채널 용어', 'x', PRIV)}) returning id`));
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.admin}', decided_at = now() where id = '${a4}' returning status`)), 'approved');
  assert.equal(sql(`select count(*) from public.msgr_org_docs where org_id = '${ORG}' and channel_id = '${PRIV}' and path = 'glossary/terms.md'`), '1', '채널 범위 문서 생성(관리자)');
  // 방어 2층: RLS를 우회한 서비스 문맥에서 비관리자 명의로 승인해도 트리거가 거절(승인자 권한 검사)
  const a5 = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk, kind, payload) values ('${ORG}', '${PUB}', '${CREW}', 'ap-doc5', '제안', 'high', 'org_doc', ${pl('용어집', 'x')}) returning id`));
  const forced = psqlRaw(['-A', '-t', '-c', `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.guest}', decided_at = now() where id = '${a5}'`]); // 슈퍼유저(RLS 우회)
  assert.notEqual(forced.status, 0); assert.match(forced.stderr, /msgr_org_doc_forbidden/, '비관리자 명의 강제 승인은 트리거가 거절');
  sql(`delete from public.msgr_crew_approvals where approval_id like 'ap-doc%'`); sql(`delete from public.msgr_org_docs where org_id = '${ORG}'`);
});

test('조직 운영(F2): 본인은 표시명만(역할·제거 표시 변경 거절), 관리자가 멤버를 제거하면 그 사람의 크루 detach·비공개 채널/DM 멤버십과 크루 멤버십 제거·감사, 되살리면 크루 복구', { skip }, () => {
  assert.equal(last(asUser(U.member, `update public.msgr_org_members set display_name = '민수(마케팅)' where org_id = '${ORG}' and user_id = '${U.member}' returning display_name`)), '민수(마케팅)');
  denied(U.member, `update public.msgr_org_members set role = 'admin' where org_id = '${ORG}' and user_id = '${U.member}'`, /msgr_member_self_only_name/);
  assert.equal(last(asUser(U.member, `update public.msgr_org_members set display_name = 'x' where org_id = '${ORG}' and user_id = '${U.admin}' returning 1`)), '', '남의 표시명은 0행');
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.member}', '${U.admin}') on conflict do nothing`);
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${CREW}', '${U.admin}') on conflict do nothing`);
  assert.equal(last(asUser(U.admin, `update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.member}' returning 1`)), '1');
  assert.equal(sql(`select status from public.msgr_crews where id = '${CREW}'`), 'detached', '제거 → 크루 detach');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${PRIV}' and ((member_kind = 'user' and member_id = '${U.member}') or (member_kind = 'crew' and member_id = '${CREW}'))`), '0', '비공개 채널 멤버십·크루 멤버십 제거');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'member.offboard' and target_id = '${U.member}'`), '1');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_channels where org_id = '${ORG}'`)), '0', '제거된 멤버는 조직이 안 보인다');
  assert.equal(last(asUser(U.admin, `update public.msgr_org_members set removed_at = null where org_id = '${ORG}' and user_id = '${U.member}' returning 1`)), '1');
  assert.equal(sql(`select status from public.msgr_crews where id = '${CREW}'`), 'active', '되살림 → 크루 복구');
  sql(`update public.msgr_org_members set display_name = null where org_id = '${ORG}' and user_id = '${U.member}'`);
});

test('역할 정식화(J-1): 채널 관리자는 자기 채널 설정·멤버만(지정은 조직 관리자·생성자만, 멤버여야), 지정 결재권자는 정책 approvers일 때 고위험 결재 확정(관리자도 유지)', { skip }, () => {
  const priv2 = last(asUser(U.admin, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'private', 'ops', '${U.admin}') returning id`));
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${priv2}', 'user', '${U.admin}', '${U.admin}')`); // 앱과 같게 만든 사람이 첫 멤버
  assert.equal(last(asUser(U.member, `update public.msgr_channels set topic = 'x' where id = '${priv2}' returning 1`)), '', '멤버는 남의 채널 설정 0행');
  assert.equal(last(asUser(U.guest, `update public.msgr_channels set admin_user_ids = array['${U.guest}'::uuid] where id = '${priv2}' returning 1`)), '', '관리자 아님 → USING 실패 = 0행');
  denied(U.admin, `update public.msgr_channels set admin_user_ids = array['${U.outsider}'::uuid] where id = '${priv2}'`, /msgr_channel_admin_not_member/);
  denied(U.admin, `update public.msgr_channels set admin_user_ids = array['${U.member}'::uuid] where id = '${priv2}'`, /msgr_channel_admin_not_channel_member/); // 비공개 채널 관리자는 채널 멤버 중에서
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${priv2}', 'user', '${U.member}', '${U.admin}')`);
  assert.equal(last(asUser(U.admin, `update public.msgr_channels set admin_user_ids = array['${U.member}'::uuid] where id = '${priv2}' returning 1`)), '1');
  assert.equal(last(asUser(U.member, `update public.msgr_channels set topic = '운영' where id = '${priv2}' returning topic`)), '운영', '채널 관리자는 설정 가능');
  assert.match(last(asUser(U.member, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${priv2}', 'user', '${U.guest}', '${U.member}') returning member_id`)), /^[0-9a-f-]{36}$/, '채널 관리자는 멤버 추가 가능');
  denied(U.member, `update public.msgr_channels set admin_user_ids = array['${U.member}'::uuid, '${U.guest}'::uuid] where id = '${priv2}'`, /msgr_channel_admins_owner_only/); // 관리자가 관리자를 늘리지 못한다
  assert.equal(last(asUser(U.member, `update public.msgr_channels set topic = 'y' where id = '${PRIV}' returning 1`)), '', '다른 채널은 여전히 0행');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'channel.admins' and target_id = '${priv2}'`), '1');
  // 지정 결재권자
  sql(`update public.msgr_crews set allow = 'all' where id = '${CREW}'`);
  const hi = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${PUB}', '${CREW}', 'ap-appr', '결제', 'high') returning id`));
  assert.equal(last(asUser(U.admin, `update public.msgr_org_policies set approval_high_by = 'approvers', approver_user_ids = array['${U.svc}'::uuid] where org_id = '${ORG}' returning approval_high_by`)), 'approvers'); // 결재권자는 채널을 읽을 수 있어야 한다(게스트는 공개 채널 열람 불가 → 0행)
  denied(U.member, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.member}', decided_at = now() where id = '${hi}'`); // 소유자(비권자)
  assert.equal(last(asUser(U.svc, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.svc}', decided_at = now() where id = '${hi}' returning status`)), 'approved', '지정 결재권자 확정');
  const hi2 = last(asUser(U.member, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${PUB}', '${CREW}', 'ap-appr2', '결제', 'high') returning id`));
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_approvals set status = 'rejected', decided_by = '${U.admin}', decided_at = now() where id = '${hi2}' returning status`)), 'rejected', 'approvers 정책에서도 관리자는 확정 가능');
  sql(`update public.msgr_org_policies set approval_high_by = 'admin', approver_user_ids = '{}' where org_id = '${ORG}'`);
  sql(`delete from public.msgr_channels where id = '${priv2}'`); sql(`delete from public.msgr_crew_approvals where approval_id like 'ap-appr%'`);
  sql(`update public.msgr_crews set allow = 'list', allow_users = array['${U.owner}'::uuid] where id = '${CREW}'`);
});

test('I-4 노드 초대 수락 = 서비스 계정 지정, 하트비트는 서비스 계정만, 관리 계정·일반 초대는 무관', () => {
  if (!DB) return;
  const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', N2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const [id, m] of [[NODE, 'node'], [N2, 'n2']]) sql(`insert into auth.users (id, created_at, email) values ('${id}', now(), '${m}@example.test') on conflict do nothing`);
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 50 where org_id = '${ORG}'`);
  sql(`update public.msgr_orgs set service_user_id = null, node_seen_at = null where id = '${ORG}'`);
  denied(U.owner, `insert into public.msgr_invites (org_id, role, for_node, created_by) values ('${ORG}', 'admin', true, '${U.owner}')`, /msgr_invites_node_role/); // 노드는 member로만
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, for_node, created_by) values ('${ORG}', true, '${U.owner}') returning code`));
  denied(U.admin, `select public.msgr_accept_invite('${code}')`, /msgr_node_not_admin/); // 관리 계정은 노드가 될 수 없다(강등 방지)
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.admin}'`), 'admin', '거절된 수락은 역할을 건드리지 않는다');
  assert.equal(last(asUser(NODE, `select public.msgr_accept_invite('${code}')`)), ORG, '노드 수락');
  assert.equal(sql(`select service_user_id from public.msgr_orgs where id = '${ORG}'`), NODE, '서비스 계정 = 노드');
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${NODE}'`), 'member');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'org.service_account' and meta->>'to' = '${NODE}'`), '1', '서비스 계정 지정 감사');
  denied(U.outsider, `select public.msgr_accept_invite('${code}')`, /msgr_invite_invalid/); // 1회용
  sql(`update public.msgr_orgs set node_seen_at = null where id = '${ORG}'`);
  assert.equal(last(asUser(U.member, `select public.msgr_node_heartbeat('${ORG}')`)), 'f', '멤버는 노드 하트비트 불가');
  assert.equal(last(asUser(U.owner, `select public.msgr_node_heartbeat('${ORG}')`)), 'f', '소유자도 노드 하트비트 불가(서비스 계정 본인만)');
  assert.equal(sql(`select node_seen_at is null from public.msgr_orgs where id = '${ORG}'`), 't');
  assert.equal(last(asUser(NODE, `select public.msgr_node_heartbeat('${ORG}')`)), 't', '서비스 계정 하트비트');
  assert.equal(last(asUser(NODE, `select public.msgr_node_heartbeat('${ORG}', '{"runners":[{"id":"openrouter","name":"OpenRouter","models":[{"id":"minimax/minimax-m3:free","label":"MiniMax M3","free":true}]}]}'::jsonb)`)), 't', '하트비트에 러너 목록');
  assert.equal(last(asUser(U.member, `select node_info->'runners'->0->>'id' from public.msgr_orgs where id = '${ORG}'`)), 'openrouter', '멤버가 서버의 러너 목록을 본다(드롭다운)');
  assert.equal(last(asUser(NODE, `select public.msgr_node_heartbeat('${ORG}')`)), 't');
  assert.equal(sql(`select node_info->'runners'->0->>'id' from public.msgr_orgs where id = '${ORG}'`), 'openrouter', '정보 없는 하트비트는 목록을 지우지 않는다');
  assert.equal(last(asUser(U.member, `select node_seen_at is not null from public.msgr_orgs where id = '${ORG}'`)), 't', '멤버가 노드 상태를 본다');
  const code2 = last(asUser(U.owner, `insert into public.msgr_invites (org_id, created_by) values ('${ORG}', '${U.owner}') returning code`));
  assert.equal(last(asUser(N2, `select public.msgr_accept_invite('${code2}')`)), ORG);
  assert.equal(sql(`select service_user_id from public.msgr_orgs where id = '${ORG}'`), NODE, '일반 초대는 서비스 계정 불변');
});

test('I-5 회사 크루 요청 — 정책 게이트(관리자·채널 관리자·멤버), 노드 없으면 거절, 상태 갱신은 서비스 계정만, done이면 채널 멤버(크루+서비스 계정)·감사', () => {
  if (!DB) return;
  const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // I-4 케이스가 서비스 계정으로 지정한 노드
  assert.equal(sql(`select service_user_id from public.msgr_orgs where id = '${ORG}'`), NODE, '전제: 노드 연결');
  sql(`update public.msgr_org_policies set crew_create = 'channel_admin' where org_id = '${ORG}'`);
  sql(`update public.msgr_channels set admin_user_ids = '{}' where id = '${PUB}'`);
  const ins = (u, ch, name = '온보딩 봇') => `insert into public.msgr_crew_requests (org_id, channel_id, name, role_text, prompt, created_by) values ('${ORG}', ${ch ? `'${ch}'` : 'null'}, '${name}', '온보딩', '신입에게 첫 주 안내를 한다', '${u}') returning id`;
  denied(U.member, ins(U.member, PUB), /row-level security/);                 // channel_admin 정책: 채널 관리자 아닌 멤버 불가
  denied(U.member, ins(U.member, null), /row-level security/);                // 조직 전체 범위는 관리자만
  asUser(U.owner, `update public.msgr_channels set admin_user_ids = array['${U.member}'::uuid] where id = '${PUB}'`);
  const r1 = last(asUser(U.member, ins(U.member, PUB)));
  assert.match(r1, /^[0-9a-f-]{36}$/, '채널 관리자는 자기 채널 범위 크루 요청 가능');
  denied(U.member, ins(U.member, null), /row-level security/);                // 채널 관리자여도 조직 전체 범위는 불가
  sql(`update public.msgr_org_policies set crew_create = 'admin' where org_id = '${ORG}'`);
  denied(U.member, ins(U.member, PUB, '봇2'), /row-level security/);          // admin 정책: 채널 관리자도 불가
  sql(`update public.msgr_org_policies set crew_create = 'member' where org_id = '${ORG}'`);
  assert.match(last(asUser(U.svc, ins(U.svc, PUB, '봇3'))), /^[0-9a-f-]{36}$/, 'member 정책: 일반 멤버도 채널 범위 요청 가능');
  denied(U.guest, ins(U.guest, PUB, '봇4'), /row-level security/);            // 게스트는 불가
  const rOrg = last(asUser(U.admin, ins(U.admin, null, '전사 봇')));
  assert.match(rOrg, /^[0-9a-f-]{36}$/, '관리자는 조직 전체 범위');
  sql(`update public.msgr_orgs set service_user_id = null where id = '${ORG}'`);
  denied(U.admin, ins(U.admin, PUB, '봇5'), /row-level security/);            // 노드 없으면 관리자도 불가(서버 쪽 "안 될 버튼")
  sql(`update public.msgr_orgs set service_user_id = '${NODE}' where id = '${ORG}'`);
  // 상태 갱신: 요청자·관리자는 0행, 서비스 계정만. done은 crew_id 필수.
  assert.equal(last(asUser(U.member, `update public.msgr_crew_requests set status = 'done' where id = '${r1}' returning status`)), '', '요청자는 상태 갱신 불가');
  assert.equal(last(asUser(U.admin, `update public.msgr_crew_requests set status = 'failed', error = 'x' where id = '${r1}' returning status`)), '', '관리자도 상태 갱신 불가(노드 몫)');
  denied(NODE, `update public.msgr_crew_requests set status = 'done' where id = '${r1}'`, /msgr_crew_request_no_crew/);
  const crewId = last(asUser(NODE, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${NODE}', 'org-lean', 'onboarding-bot', '온보딩 봇', 'resident', 'active', 'all') returning id`));
  assert.equal(last(asUser(NODE, `update public.msgr_crew_requests set status = 'done', crew_id = '${crewId}' where id = '${r1}' returning status`)), 'done', '서비스 계정이 완료 표시');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${PUB}' and ((member_kind = 'crew' and member_id = '${crewId}') or (member_kind = 'user' and member_id = '${NODE}'))`), '2', '채널에 크루+서비스 계정');
  assert.equal(sql(`select done_at is not null from public.msgr_crew_requests where id = '${r1}'`), 't');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'crew.create' and target_id = '${crewId}'`), '1', '생성 감사');
  assert.equal(sql(`select public.msgr_crew_tier('${crewId}'::uuid)`), 'company', '노드가 만든 크루 = 회사 크루');
  assert.equal(last(asUser(NODE, `update public.msgr_crew_requests set status = 'failed', error = '카드 쓰기 실패' where id = '${rOrg}' returning status`)), 'failed');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind = 'crew' and member_id = '${crewId}'`), '1', '조직 전체 범위 요청은 채널에 넣지 않는다');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_crew_requests where org_id = '${ORG}'`)), '3', '멤버가 요청 목록을 본다');
  sql(`update public.msgr_org_policies set crew_create = 'channel_admin' where org_id = '${ORG}'`);
  // I-5b 기본 엔진: 관리자만 쓰고, 노드(멤버)는 읽는다. 러너 id 형식은 check.
  assert.equal(last(asUser(U.admin, `update public.msgr_org_policies set crew_runner = 'openrouter', crew_model = 'minimax/minimax-m3:free' where org_id = '${ORG}' returning crew_runner`)), 'openrouter');
  assert.equal(last(asUser(U.member, `update public.msgr_org_policies set crew_model = 'x' where org_id = '${ORG}' returning crew_model`)), '', '멤버는 정책 수정 불가');
  assert.equal(last(asUser(NODE, `select crew_runner || ' ' || crew_model from public.msgr_org_policies where org_id = '${ORG}'`)), 'openrouter minimax/minimax-m3:free', '노드가 기본 엔진을 읽는다');
  denied(U.admin, `update public.msgr_org_policies set crew_runner = 'Bad Runner!' where org_id = '${ORG}'`, /msgr_org_policies_crew_runner_check/);
  sql(`update public.msgr_org_policies set crew_runner = null, crew_model = null where org_id = '${ORG}'`);
});

test('J-2 소유권 제안→수락·승계 관리자·결제 문제 읽기 전용 — 제안은 소유자만(관리자 대상), 거절은 당사자만, 수락은 당사자만, 잠금은 쓰기 전부 차단', () => {
  if (!DB) return;
  assert.equal(sql(`select owner_user_id from public.msgr_orgs where id = '${ORG}'`), U.owner, '전제');
  denied(U.admin, `update public.msgr_orgs set pending_owner_user_id = '${U.admin}' where id = '${ORG}'`, /msgr_owner_only/);            // 관리자가 스스로 제안 불가
  denied(U.owner, `update public.msgr_orgs set pending_owner_user_id = '${U.member}' where id = '${ORG}'`, /msgr_transfer_not_admin/);    // 멤버에게는 불가
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set pending_owner_user_id = '${U.admin}' where id = '${ORG}' returning pending_owner_user_id`)), U.admin, '관리자에게 제안');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'org.transfer.offer' and target_id = '${U.admin}'`), '1');
  assert.equal(last(asUser(U.svc, `update public.msgr_orgs set owner_user_id = '${U.svc}' where id = '${ORG}' returning 1`)), '', '제3자(멤버) 수락 불가 — RLS 0행');
  denied(U.admin, `update public.msgr_orgs set owner_user_id = '${U.svc}' where id = '${ORG}'`, /msgr_owner_only/); // 제안받은 관리자라도 자기 아닌 사람으로 확정은 불가
  denied(U.owner, `update public.msgr_orgs set owner_user_id = '${U.admin}' where id = '${ORG}'`, /msgr_transfer_needs_accept/);          // 소유자가 대신 확정 불가
  assert.equal(last(asUser(U.admin, `update public.msgr_orgs set pending_owner_user_id = null where id = '${ORG}' returning pending_owner_user_id is null`)), 't', '당사자 거절');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'org.transfer.decline'`), '1');
  asUser(U.owner, `update public.msgr_orgs set pending_owner_user_id = '${U.admin}' where id = '${ORG}'`);
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set pending_owner_user_id = null where id = '${ORG}' returning 1`)), '1', '소유자 취소');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'org.transfer.cancel'`), '1');
  // 승계 관리자
  denied(U.owner, `update public.msgr_orgs set successor_user_id = '${U.member}' where id = '${ORG}'`, /msgr_successor_not_admin/);
  denied(U.admin, `update public.msgr_orgs set successor_user_id = '${U.admin}' where id = '${ORG}'`, /msgr_owner_only/);
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set successor_user_id = '${U.admin}' where id = '${ORG}' returning successor_user_id`)), U.admin);
  // 수락 = 소유자 교대(역할 스왑·제안 비움·승계 지정이 새 소유자면 비움·감사)
  asUser(U.owner, `update public.msgr_orgs set pending_owner_user_id = '${U.admin}' where id = '${ORG}'`);
  assert.equal(last(asUser(U.admin, `update public.msgr_orgs set owner_user_id = '${U.admin}' where id = '${ORG}' returning owner_user_id`)), U.admin, '당사자 수락');
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.admin}'`), 'owner');
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.owner}'`), 'admin');
  assert.equal(sql(`select pending_owner_user_id is null and successor_user_id is null from public.msgr_orgs where id = '${ORG}'`), 't');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'org.transfer' and target_id = '${U.admin}'`), '1');
  // 되돌리기(뒤 케이스·재실행 안정): 새 소유자가 제안 → 옛 소유자 수락
  asUser(U.admin, `update public.msgr_orgs set pending_owner_user_id = '${U.owner}' where id = '${ORG}'`);
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set owner_user_id = '${U.owner}' where id = '${ORG}' returning owner_user_id`)), U.owner);
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.admin}'`), 'admin');
  // 결제 문제 = 읽기 전용: 메시지·크루 답글·크루 생성 요청 차단, 열람은 그대로
  sql(`update public.msgr_org_entitlements set ls_status = 'past_due' where org_id = '${ORG}'`);
  assert.equal(last(asUser(U.owner, `select public.msgr_org_locked('${ORG}')`)), 't');
  denied(U.owner, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body) values ('${ORG}', '${PUB}', 'user', '${U.owner}', '잠금 중')`, /row-level security/);
  denied(U.admin, `insert into public.msgr_crew_requests (org_id, channel_id, name, prompt, created_by) values ('${ORG}', '${PUB}', '봇', 'x', '${U.admin}')`, /row-level security/);
  assert.notEqual(last(asUser(U.member, `select count(*) from public.msgr_messages where org_id = '${ORG}'`)), '0', '열람은 된다');
  sql(`update public.msgr_org_entitlements set ls_status = null where org_id = '${ORG}'`);
  assert.equal(last(asUser(U.owner, `select public.msgr_org_locked('${ORG}')`)), 'f');
  assert.match(last(asUser(U.owner, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body) values ('${ORG}', '${PUB}', 'user', '${U.owner}', '잠금 해제') returning id`)), /^[0-9]+$/, '해제 후 쓰기 복귀');
});

test('J-3 도메인 자동 가입 — 등록은 소유자만·본인 도메인만·공개 도메인 거절, 목록은 같은 도메인 미가입자만, 가입 RPC는 좌석 게이트·감사', () => {
  if (!DB) return;
  // 픽스처: 소유자 이메일 도메인을 회사 도메인으로, 같은 도메인의 외부인 2명(하나는 제거됐던 멤버)
  sql(`update auth.users set email = 'owner@lean.co' where id = '${U.owner}'`);
  sql(`update auth.users set email = 'admin@lean.co' where id = '${U.admin}'`);
  const D1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', D2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  sql(`insert into auth.users (id, created_at, email) values ('${D1}', now(), 'newbie@lean.co'), ('${D2}', now(), 'stranger@other.co') on conflict do nothing`);
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 50 where org_id = '${ORG}'`);
  denied(U.admin, `update public.msgr_orgs set auto_join_domain = 'lean.co' where id = '${ORG}'`, /msgr_owner_only/);
  denied(U.owner, `update public.msgr_orgs set auto_join_domain = 'gmail.com' where id = '${ORG}'`, /msgr_domain_public/);
  denied(U.owner, `update public.msgr_orgs set auto_join_domain = 'other.co' where id = '${ORG}'`, /msgr_domain_not_owners/);
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set auto_join_domain = 'Lean.CO' where id = '${ORG}' returning auto_join_domain`)), 'lean.co', '소문자 정규화');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'org.domain'`), '1');
  assert.equal(last(asUser(D1, `select count(*) from public.msgr_joinable_orgs()`)), '1', '같은 도메인 미가입자에게 보인다');
  assert.equal(last(asUser(D2, `select count(*) from public.msgr_joinable_orgs()`)), '0', '다른 도메인은 안 보인다');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_joinable_orgs()`)), '0', '이미 멤버면 안 보인다');
  denied(D2, `select public.msgr_join_by_domain('${ORG}')`, /msgr_domain_mismatch/);
  assert.equal(last(asUser(D1, `select public.msgr_join_by_domain('${ORG}')`)), ORG, '가입');
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${D1}'`), 'member');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'member.join.domain' and target_id = '${D1}'`), '1');
  assert.equal(last(asUser(D1, `select count(*) from public.msgr_joinable_orgs()`)), '0', '가입 뒤엔 목록에서 사라진다');
  sql(`update public.msgr_org_entitlements set seats = 1 where org_id = '${ORG}'`); // 좌석이 차면 가입도 막힌다(초대 수락과 같은 게이트)
  sql(`update auth.users set email = 'late@lean.co' where id = '${D2}'`);
  denied(D2, `select public.msgr_join_by_domain('${ORG}')`, /msgr_seat_limit/);
  sql(`update public.msgr_org_entitlements set seats = 50 where org_id = '${ORG}'`);
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set auto_join_domain = null where id = '${ORG}' returning auto_join_domain is null`)), 't', '끄기');
  assert.equal(last(asUser(D2, `select count(*) from public.msgr_joinable_orgs()`)), '0', '끄면 목록 없음');
});

test('J-4 게스트 — 채널 관리자의 비공개 채널 게스트 링크(공개 채널·비관리자 거절), 수락 = 게스트+기간+채널 멤버, 만료 즉시 판정 null, 좌석은 정책 guest_seats에 따라', () => {
  if (!DB) return;
  const G1 = 'ffffffff-ffff-4fff-8fff-ffffffffffff', G2 = '12121212-1212-4121-8121-121212121212';
  for (const [id, m] of [[G1, 'guest1'], [G2, 'guest2']]) sql(`insert into auth.users (id, created_at, email) values ('${id}', now(), '${m}@partner.co') on conflict do nothing`);
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 50 where org_id = '${ORG}'`);
  sql(`update public.msgr_org_policies set guest_seats = false where org_id = '${ORG}'`);
  sql(`update public.msgr_channels set admin_user_ids = '{}' where id in ('${PUB}', '${PRIV}')`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PRIV}', 'user', '${U.member}') on conflict do nothing`); // 픽스처: 앞 케이스가 남긴 상태에 의존하지 않는다
  const inv = (u, ch, days = 30) => `insert into public.msgr_invites (org_id, role, channel_id, guest_days, created_by) values ('${ORG}', 'guest', ${ch ? `'${ch}'` : 'null'}, ${days}, '${u}') returning code`;
  denied(U.member, inv(U.member, PRIV), /row-level security/);                                   // 채널 관리자 아님
  assert.equal(last(asUser(U.admin, `update public.msgr_channels set admin_user_ids = array['${U.member}'::uuid] where id = '${PRIV}' returning 1`)), '1', '채널 관리자 지정(생성자 — 소유자는 앞 케이스가 PRIV 멤버에서 뺐다: UPDATE는 SELECT 열람도 지나야 해 0행이 된다)');
  asUser(U.owner, `update public.msgr_channels set admin_user_ids = array['${U.member}'::uuid] where id = '${PUB}'`); // 공개 채널 관리자로 만들어도
  denied(U.member, inv(U.member, PUB), /row-level security/);                                    // 공개 채널 게스트 링크 불가(kind = private 조건 — 변이 배터리가 드러낸 구멍)
  denied(U.member, `insert into public.msgr_invites (org_id, role, channel_id, created_by) values ('${ORG}', 'member', '${PRIV}', '${U.member}')`, /msgr_invites_channel_guest|row-level security/); // 채널 한정은 게스트만
  const code = last(asUser(U.member, inv(U.member, PRIV, 1)));
  assert.match(code, /^[0-9a-f]{48}$/, '채널 관리자의 게스트 링크');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_invites where channel_id = '${PRIV}'`)), '1', '채널 관리자는 자기 채널 초대를 본다');
  assert.equal(last(asUser(G1, `select public.msgr_accept_invite('${code}')`)), ORG, '게스트 수락');
  assert.equal(sql(`select role || ' ' || (expires_at > now() + interval '23 hours' and expires_at < now() + interval '25 hours') from public.msgr_org_members where org_id = '${ORG}' and user_id = '${G1}'`), 'guest true', '게스트 + 1일 기간');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'user' and member_id = '${G1}'`), '1', '채널에 자동 등록');
  assert.equal(last(asUser(G1, `select count(*) from public.msgr_channels where id = '${PRIV}'`)), '1', '게스트가 그 채널을 본다');
  assert.equal(last(asUser(G1, `select count(*) from public.msgr_channels where id = '${PUB}'`)), '0', '공개 채널은 안 보인다');
  // 좌석: 기본 게스트 미차지 — 좌석 1로 줄여도 게스트는 들어오고 멤버는 막힌다
  sql(`update public.msgr_org_entitlements set seats = 1 where org_id = '${ORG}'`);
  const code2 = last(asUser(U.member, inv(U.member, PRIV, 7)));
  assert.equal(last(asUser(G2, `select public.msgr_accept_invite('${code2}')`)), ORG, '게스트는 좌석을 안 쓴다');
  const mcode = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
  const M3 = '13131313-1313-4131-8131-131313131313'; sql(`insert into auth.users (id, created_at, email) values ('${M3}', now(), 'm3@partner.co') on conflict do nothing`);
  denied(M3, `select public.msgr_accept_invite('${mcode}')`, /msgr_seat_limit/);
  sql(`update public.msgr_org_policies set guest_seats = true where org_id = '${ORG}'`);
  const code3 = last(asUser(U.member, inv(U.member, PRIV, 7)));
  const G3 = '14141414-1414-4141-8141-141414141414'; sql(`insert into auth.users (id, created_at, email) values ('${G3}', now(), 'g3@partner.co') on conflict do nothing`);
  denied(G3, `select public.msgr_accept_invite('${code3}')`, /msgr_seat_limit/);                  // 정책이 켜지면 게스트도 좌석
  sql(`update public.msgr_org_entitlements set seats = 50 where org_id = '${ORG}'`);
  sql(`update public.msgr_org_policies set guest_seats = false where org_id = '${ORG}'`);
  // 만료 → 즉시 판정 null(채널·조직 불가시), 정식 멤버가 게스트 링크를 열어도 강등되지 않는다
  sql(`update public.msgr_org_members set expires_at = now() - interval '1 second' where org_id = '${ORG}' and user_id = '${G1}'`);
  assert.equal(last(asUser(G1, `select count(*) from public.msgr_channels where id = '${PRIV}'`)), '0', '만료 게스트는 채널 불가시');
  assert.equal(last(asUser(G1, `select public.msgr_is_member('${ORG}')`)), 'f');
  const code4 = last(asUser(U.member, inv(U.member, PRIV, 7)));
  assert.equal(last(asUser(U.svc, `select public.msgr_accept_invite('${code4}')`)), ORG);
  assert.equal(sql(`select role || ' ' || (expires_at is null) from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.svc}'`), 'member true', '정식 멤버는 강등 없이 채널만 추가');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'user' and member_id = '${U.svc}'`), '1');
});

test('J-5 조직 삭제 유예·복구 — 소유자만 삭제 표시(즉시 전원 불가시·감사), 30일 안 소유자 복구 RPC, 지나면 복구 거절·purge(service_role만)', () => {
  if (!DB) return;
  const TMP = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('지울 조직', 'to-delete', '${U.owner}') returning id`));
  assert.equal(sql(`select display_name from public.msgr_org_members where org_id = '${TMP}' and user_id = '${U.owner}'`), 'owner', '새 조직 소유자 표시명 = 이메일 앞부분');
  asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${TMP}', 'admin', '${U.owner}')`);
  const code = last(asUser(U.owner, `select code from public.msgr_invites where org_id = '${TMP}' limit 1`));
  asUser(U.admin, `select public.msgr_accept_invite('${code}')`);
  denied(U.admin, `update public.msgr_orgs set deleted_at = now() where id = '${TMP}'`, /msgr_owner_only/);
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set deleted_at = now() where id = '${TMP}' returning 1`)), '1', '소유자 삭제 표시');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${TMP}' and action = 'org.delete'`), '1');
  assert.equal(last(asUser(U.admin, `select public.msgr_is_member('${TMP}')`)), 'f', '삭제 즉시 멤버십 판정 null');
  assert.equal(last(asUser(U.admin, `select count(*) from public.msgr_channels where org_id = '${TMP}'`)), '0');
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set deleted_at = null where id = '${TMP}' returning 1`)), '', '삭제 뒤엔 일반 UPDATE 정책을 못 지난다(0행) — 복구는 RPC');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_my_deleted_orgs()`)), '1', '소유자의 삭제 예정 목록');
  assert.equal(last(asUser(U.admin, `select count(*) from public.msgr_my_deleted_orgs()`)), '0', '관리자에겐 없다');
  denied(U.admin, `select public.msgr_restore_org('${TMP}')`, /msgr_owner_only/);
  assert.equal(last(asUser(U.owner, `select public.msgr_restore_org('${TMP}')`)), 't', '소유자 복구');
  assert.equal(last(asUser(U.admin, `select public.msgr_is_member('${TMP}')`)), 't', '복구 즉시 멤버십 복귀');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${TMP}' and action = 'org.restore'`), '1');
  assert.equal(last(asUser(U.owner, `select public.msgr_restore_org('${TMP}')`)), 'f', '이미 살아 있으면 false');
  sql(`update public.msgr_orgs set deleted_at = now() - interval '31 days' where id = '${TMP}'`);
  denied(U.owner, `select public.msgr_restore_org('${TMP}')`, /msgr_restore_expired/);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_my_deleted_orgs()`)), '0', '유예가 끝난 조직은 복구 목록에 없다');
  denied(U.owner, `select public.msgr_purge_orgs()`, /msgr_service_only|permission denied/);
  assert.equal(sql(`select public.msgr_purge_orgs()`), '1', '서비스 문맥 purge');
  assert.equal(sql(`select count(*) from public.msgr_orgs where id = '${TMP}'`), '0', '영구 삭제(cascade)');
});

test('검수 반영 — 크루 요청 컬럼 잠금·완료 크루 검증(CRITICAL-1), 채널 멤버 대상 조직 검증(HIGH-1), 게스트 전사 문서 차단(MEDIUM-1), resident는 서비스 계정만(LOW-1)', () => {
  if (!DB) return;
  const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', G2 = '12121212-1212-4121-8121-121212121212';
  sql(`update public.msgr_orgs set service_user_id = '${NODE}' where id = '${ORG}'`);
  sql(`update public.msgr_org_policies set crew_create = 'admin' where org_id = '${ORG}'`);
  const rq = last(asUser(U.admin, `insert into public.msgr_crew_requests (org_id, channel_id, name, prompt, created_by) values ('${ORG}', '${PUB}', '잠금 봇', 'x', '${U.admin}') returning id`));
  denied(NODE, `update public.msgr_crew_requests set channel_id = '${PRIV}' where id = '${rq}'`, /msgr_immutable_channel_id/);      // 노드가 소속 채널을 바꿔 주입하던 경로
  denied(NODE, `update public.msgr_crew_requests set status = 'done', crew_id = '${CREW}' where id = '${rq}'`, /msgr_crew_request_bad_crew/); // 서비스 계정 소유 아닌 크루로 완료 불가
  const OTHER = last(sql(`insert into public.msgr_orgs (name, slug, owner_user_id) values ('타 조직', 'other-org', '${U.owner}') returning id`));
  const oc = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${OTHER}', '${U.owner}', 'other', 'spy', '스파이', 'local', 'active', 'all') returning id`));
  denied(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${oc}', '${U.admin}')`, /row-level security/); // 다른 조직 크루 주입 불가
  denied(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.outsider}', '${U.admin}')`, /row-level security/); // 비멤버 주입 불가
  const mine = last(asUser(NODE, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${NODE}', 'org-lean', 'lockbot', '잠금 봇', 'resident', 'active', 'all') returning id`));
  assert.equal(last(asUser(NODE, `update public.msgr_crew_requests set status = 'done', crew_id = '${mine}' where id = '${rq}' returning status`)), 'done', '서비스 계정 소유 resident 크루로만 완료');
  denied(NODE, `update public.msgr_crew_requests set status = 'failed' where id = '${rq}'`, /msgr_crew_request_final/);            // 확정 뒤 재변경 불가
  denied(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.member}', 'w', 'fake', '가짜', 'resident', 'active', 'all')`, /row-level security/); // 개인이 resident 주장 불가
  denied(NODE, `update public.msgr_crews set hosting = 'local' where id = '${mine}'`, /msgr_immutable_hosting/);
  sql(`insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values ('${ORG}', null, 'rules/handbook.md', '규칙집', '비밀 규칙', '${U.admin}', '${U.admin}') on conflict do nothing`);
  assert.notEqual(last(asUser(U.member, `select count(*) from public.msgr_org_docs where org_id = '${ORG}' and channel_id is null`)), '0', '멤버는 전사 문서를 본다');
  assert.equal(last(asUser(G2, `select count(*) from public.msgr_org_docs where org_id = '${ORG}' and channel_id is null`)), '0', '채널 한정 게스트는 전사 문서를 못 본다');
  assert.equal(last(asUser(U.owner, `select public.msgr_public_email_domain('QQ.com')`)), 't', '확장된 공개 도메인 목록');
  sql(`update public.msgr_org_policies set crew_create = 'channel_admin' where org_id = '${ORG}'`);
});

test('검수 반영 2 — 게스트 자기 만료 삭제(C-1)·도메인 함수 권한(H-1)·퇴사자 재가입·기존 멤버 강등(H-4·M-7)·관리자 서비스 계정 자기 지정(H-6)·member 정책은 쓸 수 있는 채널만(M-1)·채널 없는 게스트 초대(L-3)·잠금 시 초대·채널 생성(M-6)', () => {
  if (!DB) return;
  const G2 = '12121212-1212-4121-8121-121212121212', NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  sql(`update public.msgr_orgs set service_user_id = '${NODE}', auto_join_domain = null where id = '${ORG}'`);
  sql(`update public.msgr_org_members set expires_at = now() + interval '1 day' where org_id = '${ORG}' and user_id = '${G2}'`);
  denied(G2, `update public.msgr_org_members set expires_at = null where org_id = '${ORG}' and user_id = '${G2}'`, /msgr_member_self_only_name/);          // C-1
  denied(G2, `update public.msgr_org_members set expires_at = now() + interval '365 days' where org_id = '${ORG}' and user_id = '${G2}'`, /msgr_member_self_only_name/);
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_email_domain(uuid)', 'execute') or has_function_privilege('authenticated', 'public.msgr_email_domain(uuid)', 'execute')`), 'f', 'H-1: 도메인 함수는 내부 전용');
  // H-4·M-7: 퇴사자는 도메인으로 못 돌아오고, 기존 멤버는 강등되지 않는다
  sql(`update auth.users set email = 'owner@lean.co' where id = '${U.owner}'`);
  sql(`update auth.users set email = 'removed@lean.co' where id = '${U.removed}'`);
  sql(`update auth.users set email = 'member@lean.co' where id = '${U.member}'`);
  asUser(U.owner, `update public.msgr_orgs set auto_join_domain = 'lean.co' where id = '${ORG}'`);
  assert.equal(last(asUser(U.removed, `select count(*) from public.msgr_joinable_orgs()`)), '0', '퇴사자에게는 후보로 안 뜬다');
  denied(U.removed, `select public.msgr_join_by_domain('${ORG}')`, /msgr_removed_rejoin/);
  denied(U.member, `select public.msgr_join_by_domain('${ORG}')`, /msgr_already_member/);
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.member}'`), 'member', '강등 없음');
  denied(U.owner, `update public.msgr_orgs set auto_join_role = 'guest' where id = '${ORG}'`, /msgr_orgs_auto_join_role_check/); // L-3
  asUser(U.owner, `update public.msgr_orgs set auto_join_domain = null where id = '${ORG}'`);
  // H-6: 관리자가 자기를 서비스 계정으로 지정 불가(소유자·노드 수락 RPC만)
  denied(U.admin, `update public.msgr_orgs set service_user_id = '${U.admin}' where id = '${ORG}'`, /msgr_owner_only/);
  assert.equal(sql(`select service_user_id from public.msgr_orgs where id = '${ORG}'`), NODE);
  assert.equal(last(asUser(U.owner, `update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}' returning 1`)), '1', '소유자는 지정 가능');
  sql(`update public.msgr_orgs set service_user_id = '${NODE}' where id = '${ORG}'`);
  // M-1: member 정책이어도 못 보는(=못 쓰는) 비공개 채널엔 크루 요청 불가
  sql(`update public.msgr_org_policies set crew_create = 'member' where org_id = '${ORG}'`);
  sql(`delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'user' and member_id = '${U.svc}'`);
  denied(U.svc, `insert into public.msgr_crew_requests (org_id, channel_id, name, prompt, created_by) values ('${ORG}', '${PRIV}', '몰래', 'x', '${U.svc}')`, /row-level security/);
  sql(`update public.msgr_org_policies set crew_create = 'channel_admin' where org_id = '${ORG}'`);
  // L-3: 채널 없는 게스트 초대 불가
  denied(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'guest', '${U.owner}')`, /msgr_invites_guest_needs_channel/);
  // M-6: 잠금이면 초대·채널·크루 파견·전사 문서 편집도 막힌다
  sql(`update public.msgr_org_entitlements set ls_status = 'unpaid' where org_id = '${ORG}'`);
  denied(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}')`, /row-level security/);
  denied(U.owner, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'public', 'locked-ch', '${U.owner}')`, /row-level security/);
  denied(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'w2', 'lockedcrew', 'x')`, /row-level security/);
  assert.equal(last(asUser(U.admin, `select public.msgr_can_edit_doc('${ORG}', null)`)), 'f', '잠금이면 전사 문서 편집 불가');
  sql(`update public.msgr_org_entitlements set ls_status = null where org_id = '${ORG}'`);
  assert.equal(last(asUser(U.admin, `select public.msgr_can_edit_doc('${ORG}', null)`)), 't');
});

test('나가기(레일 메뉴) — 만든 사람이 비공개 채널·1:1에서 나가면 열람도 끝난다(생성 직후 예외만), 남은 멤버는 그대로', () => {
  if (!DB) return;
  const ch = last(asUser(U.member, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'private', 'leave-me', '${U.member}') returning id`));
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_channels where id = '${ch}'`)), '1', '생성 직후(멤버 0) 생성자가 본다');
  asUser(U.member, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${U.member}', '${U.member}'), ('${ch}', 'user', '${U.svc}', '${U.member}')`);
  assert.equal(last(asUser(U.member, `delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${U.member}' returning 1`)), '1', '본인 나가기');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_channels where id = '${ch}'`)), '0', '나간 생성자는 더 이상 못 본다');
  assert.equal(last(asUser(U.svc, `select count(*) from public.msgr_channels where id = '${ch}'`)), '1', '남은 멤버는 본다');
  assert.equal(last(asUser(U.admin, `select count(*) from public.msgr_channels where id = '${ch}'`)), '0', '조직 관리자도 비공개 채널은 멤버가 아니면 안 본다(기존 규칙 유지)');
});
