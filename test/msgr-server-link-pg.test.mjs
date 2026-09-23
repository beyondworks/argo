// VPS 서버 연결(20260923120000_msgr_server_links.sql) 실행 검증 — 하네스·시드는 msgr-bots-pg.test.mjs와 같다(auth.uid() 스텁 + set role).
// 토큰 원문은 서버에 오지 않는다: 스크립트가 보고한 sha256으로 봇이 만들어지고, 같은 서버·같은 에이전트는 봇을 새로 만들지 않고 해시만 교체한다.
// 하네스는 msgr-pg-integration.test.mjs와 같다(auth.uid() 스텁 + set role). ARGO_PG_TEST_URL 미설정이면 skip.
// 실행: `npm run test:pg` (scripts/billing-pg-drill.sh — 파일마다 별도 임시 DB). 사용자 흉내: set role authenticated +
// argo.uid 세션 변수(auth.uid() 스텁이 읽는다) — 슈퍼유저는 RLS를 우회하므로 반드시 역할을 낮춰 실행한다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  removed: '55555555-5555-4555-8555-555555555555', outsider: '66666666-6666-4666-8666-666666666666',
  svc: '77777777-7777-4777-8777-777777777777', extra: '88888888-8888-4888-8888-888888888888',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();                 // 슈퍼유저(RLS 우회) — 시드·관찰 전용
const asAnon = (q) => sql(`set role anon; ${q}`);                      // 봇 쪽 RPC는 토큰이 자격 — anon으로 호출
const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]);
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
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false); -- 아바타 버킷(20260909005000)
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
    '20260903120000_msgr.sql', '20260907120000_msgr_crew_inventory.sql', '20260908120000_msgr_bots.sql', '20260908140000_msgr_crew_autodispatch.sql', '20260909000000_msgr_bot_external_id.sql', '20260909002000_msgr_profiles_friends.sql', '20260909003000_msgr_message_meta.sql', '20260909004000_msgr_p0_reads_reactions_prefs.sql', '20260909005000_msgr_avatars.sql', '20260920070335_msgr_bot_rename.sql', '20260920071438_msgr_bot_rename_lock.sql', '20260920072631_msgr_bot_set_role.sql', '20260920073108_msgr_bot_role_gate.sql', '20260923120000_msgr_server_links.sql']) psql(['-f', mig(f)]); // 배포될 그 파일을 그대로 적용
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
  PRIV = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}', 'private', 'secret')`)); // 앱과 같게 RPC — 만든 사람이 첫 멤버로 함께 등록된다(생성 직후 열람 예외 폐지, 검수 HIGH 2026-09-05)
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.guest}', '${U.admin}')`);
  CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean-ax-abcd', 'seoyun', '서윤') returning id`));
  CREW_SVC = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values ('${ORG}', '${U.svc}', 'lean-node', 'node-crew', '노드', 'resident') returning id`)); // 시드는 슈퍼유저: resident는 서비스 계정 지정 뒤에만 사용자 문맥으로 등록 가능(검수 LOW-1 게이트)
});

const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const q = (s) => s.replace(/'/g, "''");

import { createHash, randomBytes } from 'node:crypto';
const tok = () => `argo_bot_${randomBytes(24).toString('hex')}`;
const hashOf = (t) => createHash('sha256').update(t).digest('hex');
const agent = (kind, id, name, t) => ({ kind, id, name, default: id === 'default' || id === 'main', token_hash: hashOf(t), token_hint: t.slice(0, 12) });
const mkLink = (uid = U.admin) => JSON.parse(last(asUser(uid, `select public.msgr_server_link_create('${ORG}')`)));
const report = (code, host, agents) => asAnon(`select public.msgr_server_link_report('${q(code)}', '${q(host)}', '${q(JSON.stringify(agents))}'::jsonb)`);
const reportRaw = (code, host, agents) => asAnonRaw(`select public.msgr_server_link_report('${q(code)}', '${q(host)}', '${q(JSON.stringify(agents))}'::jsonb)`);
const approve = (uid, link, picks) => JSON.parse(last(asUser(uid, `select public.msgr_server_link_approve('${link}', '${q(JSON.stringify(picks))}'::jsonb)`)));
const status = (code) => JSON.parse(last(asAnon(`select public.msgr_server_link_status('${q(code)}')`)));
const me = (t) => JSON.parse(last(asAnon(`select public.msgr_bot_me('${t}')`)));

test('연결 코드: 관리자만 만든다 · 원문은 1회 반환, 저장은 해시 · 행은 관리자만 읽는다', { skip }, () => {
  fails(asUserRaw(U.member, `select public.msgr_server_link_create('${ORG}')`), /msgr_admin_only/, '멤버');
  fails(asUserRaw(U.outsider, `select public.msgr_server_link_create('${ORG}')`), /msgr_admin_only/, '외부인');
  const l = mkLink();
  assert.match(l.code, /^argo_link_[0-9a-f]{48}$/);
  assert.equal(sql(`select code_hash = encode(sha256(convert_to('${l.code}', 'utf8')), 'hex') from public.msgr_server_links where id = '${l.link_id}'`), 't');
  assert.equal(last(asUser(U.admin, `select status from public.msgr_server_links where id = '${l.link_id}'`)), 'waiting');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_server_links where id = '${l.link_id}'`)), '0');
  denied(U.admin, `update public.msgr_server_links set status = 'done' where id = '${l.link_id}'`);
});

test('서버 보고 → 관리자 승인: 고른 에이전트만 봇이 되고, 서버가 만든 토큰으로 바로 인증된다(원문은 DB에 없음)', { skip }, () => {
  const l = mkLink();
  const tA = tok(), tB = tok(), tC = tok();
  fails(reportRaw('argo_link_' + '0'.repeat(48), 'vps-1', [agent('hermes', 'default', 'Hermes', tA)]), /msgr_link_invalid/, '틀린 코드');
  fails(reportRaw(l.code, 'vps 1', [agent('hermes', 'default', 'Hermes', tA)]), /msgr_link_bad_agents/, '호스트명 형식');
  fails(reportRaw(l.code, 'vps-1', [{ ...agent('hermes', 'default', 'Hermes', tA), token_hash: 'x' }]), /msgr_link_bad_agents/, '해시 형식');
  fails(reportRaw(l.code, 'vps-1', [agent('slack', 'x', 'X', tA)]), /msgr_link_bad_agents/, '모르는 종류');
  report(l.code, 'vps-1', [agent('hermes', 'default', 'Hermes', tA), agent('hermes', 'research', 'research', tB), agent('openclaw', 'main', 'OpenClaw', tC)]);
  assert.equal(status(l.code).status, 'reported');
  fails(reportRaw(l.code, 'evil', [agent('hermes', 'default', 'Hermes', tok())]), /msgr_link_used/, '승인 전 재보고(코드를 본 사람의 목록·해시 바꿔치기) 거절 — 검수 #688 MEDIUM');
  assert.equal(last(asUser(U.admin, `select host from public.msgr_server_links where id = '${l.link_id}'`)), 'vps-1');
  assert.deepEqual(status(l.code).approved, [], '승인 전에는 목록을 내주지 않는다');
  fails(asUserRaw(U.member, `select public.msgr_server_link_approve('${l.link_id}', '[{"kind":"hermes","id":"default"}]'::jsonb)`), /msgr_admin_only/, '멤버 승인');
  last(asUser(U.member, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other-link', '${U.member}') returning id`));
  fails(asUserRaw(U.member, `select public.msgr_server_link_approve('${l.link_id}', '[{"kind":"hermes","id":"default"}]'::jsonb)`), /msgr_admin_only/, '다른 조직의 조직장은 이 조직 연결을 승인하지 못한다(검수 #688 LOW)');
  fails(asUserRaw(U.admin, `select public.msgr_server_link_approve('${l.link_id}', '[{"kind":"hermes","id":"ghost"}]'::jsonb)`), /msgr_link_no_picks/, '보고에 없는 에이전트');
  const out = approve(U.admin, l.link_id, [{ kind: 'hermes', id: 'default' }, { kind: 'openclaw', id: 'main' }, { kind: 'hermes', id: 'default' }]);
  assert.equal(out.length, 2, '같은 에이전트를 두 번 골라도 봇은 하나');
  assert.equal(me(tA).name, 'Hermes'); assert.equal(me(tC).kind, 'openclaw');
  fails(asAnonRaw(`select public.msgr_bot_me('${tB}')`), /msgr_bot_unauthorized/, '고르지 않은 에이전트는 봇이 없다');
  assert.equal(sql(`select count(*) from public.msgr_bots where token_hash in ('${tA}', '${tC}')`), '0', '원문 저장 금지');
  assert.equal(sql(`select external_id from public.msgr_bots where id = '${out[0].bot_id}'`), 'vps:vps-1:hermes:default');
  assert.equal(sql(`select token_hint from public.msgr_bots where id = '${out[0].bot_id}'`), tA.slice(0, 12));
  assert.deepEqual(status(l.code), { status: 'approved', approved: [{ kind: 'hermes', id: 'default' }, { kind: 'openclaw', id: 'main' }] });
  fails(reportRaw(l.code, 'vps-1', [agent('hermes', 'default', 'Hermes', tok())]), /msgr_link_used/, '승인 뒤 재보고(해시 바꿔치기) 거절');
  fails(asUserRaw(U.admin, `select public.msgr_server_link_approve('${l.link_id}', '[{"kind":"hermes","id":"research"}]'::jsonb)`), /msgr_link_used/, '두 번 승인');
  asAnon(`select public.msgr_server_link_done('${l.code}', '${q(JSON.stringify([{ kind: 'hermes', id: 'default', ok: true, detail: 'x'.repeat(500) }]))}'::jsonb)`);
  assert.equal(last(asUser(U.admin, `select status || '|' || length(results->0->>'detail') from public.msgr_server_links where id = '${l.link_id}'`)), 'done|300');
  fails(asAnonRaw(`select public.msgr_server_link_done('${l.code}', '[]'::jsonb)`), /msgr_link_used/, '두 번 완료');
});

test('같은 서버에서 다시 연결: 새 봇을 만들지 않고 토큰만 교체(옛 토큰 무효) · 다른 서버의 같은 이름은 별개 봇', { skip }, () => {
  const before = sql(`select count(*) from public.msgr_bots where org_id = '${ORG}' and revoked_at is null`);
  const l = mkLink(); const t1 = tok();
  report(l.code, 'vps-1', [agent('hermes', 'default', 'Hermes', t1)]);
  const [r] = approve(U.admin, l.link_id, [{ kind: 'hermes', id: 'default' }]);
  assert.equal(r.reused, true);
  assert.equal(sql(`select count(*) from public.msgr_bots where org_id = '${ORG}' and revoked_at is null`), before, '봇 수 그대로');
  assert.equal(me(t1).bot_id, r.bot_id);
  assert.equal(sql(`select count(*) from public.msgr_audit_log where action = 'bot.rotate' and target_id = '${r.bot_id}'`), '1');
  const l2 = mkLink(); const t2 = tok();
  report(l2.code, 'vps-2', [agent('hermes', 'default', 'Hermes', t2)]);
  const [r2] = approve(U.admin, l2.link_id, [{ kind: 'hermes', id: 'default' }]);
  assert.equal(r2.reused, false); assert.notEqual(r2.bot_id, r.bot_id);
});

test('만료된 코드는 보고·조회·승인 모두 거절', { skip }, () => {
  const l = mkLink();
  report(l.code, 'vps-9', [agent('hermes', 'default', 'Hermes', tok())]);
  sql(`update public.msgr_server_links set expires_at = now() - interval '1 second' where id = '${l.link_id}'`);
  fails(reportRaw(l.code, 'vps-9', []), /msgr_link_invalid/, '보고');
  fails(asAnonRaw(`select public.msgr_server_link_status('${l.code}')`), /msgr_link_invalid/, '조회');
  fails(asUserRaw(U.admin, `select public.msgr_server_link_approve('${l.link_id}', '[{"kind":"hermes","id":"default"}]'::jsonb)`), /msgr_link_invalid/, '승인');
});
