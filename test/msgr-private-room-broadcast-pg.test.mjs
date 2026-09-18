// 비공개 방 방송 경로(20260918184500) — 공개 채널만 org:<조직>, 조직 DM·비공개 채널·개인 공간은 받을 사람 각각의 u:<uid>.
// 실측(2026-09-18): 내가 없는 B↔C DM의 message 방송이 org: 토픽으로 조직 전원에게 닿고 0.1.28 앱이 OS 알림까지 띄웠다.
// realtime.send는 realtime.sent 표에 기록하는 스텁 — 어느 토픽으로 무엇을 보냈는지 그대로 본다. 수신 정책은 realtime.messages 행 가시성으로.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  outsider: '66666666-6666-4666-8666-666666666666', svc: '77777777-7777-4777-8777-777777777777', extra: '88888888-8888-4888-8888-888888888888',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();                 // 슈퍼유저(RLS 우회) — 시드·관찰 전용. BEFORE 트리거는 슈퍼유저에도 돈다
const sqlRaw = (q) => psqlRaw(['-A', '-t', '-c', q]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';        // set_config 출력 뒤 마지막 결과 줄
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };

let ORG, OTHER_ORG, CREW, OTHER_CREW, PUB;
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
  // Supabase's outbound HTTP extension is stubbed; all Messenger SQL, RLS and triggers run unchanged.
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const migrationDir=fileURLToPath(new URL('../supabase/migrations/',import.meta.url));
  for(const f of readdirSync(migrationDir).filter(f=>/^\d+_msgr.*\.sql$/.test(f)).sort()) {
    const source=readFileSync(mig(f),'utf8');
    psql(['-c',source.replace(/^create extension if not exists pg_net;$/m,'')]);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  OTHER_ORG = last(asUser(U.guest, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.guest}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const uid of [U.admin, U.member, U.extra]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  OTHER_CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean', 'theirs', 'Theirs') returning id`));
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Work')`));
  sql(`update public.msgr_crews set dm_delivery_protocol=1,work_protocol=1,last_seen_at=now(),allow='all',role_text=case when id='${CREW}' then '총괄 moderator' else 'Research' end where org_id='${ORG}'`);

});


// realtime.sent에서 이벤트별 토픽 집합을 읽는다(정렬 — 순서 무관)
const topicsOf = (event, id) => sql(`select coalesce(string_agg(topic, ',' order by topic), '') from realtime.sent where event = '${event}' and payload->>'id' = '${id}'`);
const u = (...ids) => ids.map((x) => `u:${x}`).sort().join(',');
const msg = (uid, ch, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions) values ('${ch}', 'user', '${uid}', '비밀 본문', '${mentions}') returning id`));

let BC, BCREW, BCREW_DM, PERSONAL;
test('setup: B↔C 조직 DM, B의 크루와 C가 있는 비공개 방(소유자 B는 방 멤버가 아님), 개인 1:1(A↔B)', { skip }, () => {
  BC = last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'dm', 'b-c', '[{"kind":"user","id":"${U.extra}"}]')`));
  BCREW = OTHER_CREW; // 소유자 = member(B)
  BCREW_DM = last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'private', 'c-theirs', '[{"kind":"user","id":"${U.extra}"},{"kind":"crew","id":"${BCREW}"}]')`));
  // 지금 스키마에서는 소유자가 방을 나가면 그 크루도 함께 빠진다(실측) — "소유자 없는 방의 크루"는 정상 흐름으로 생기지 않는다.
  // 수신자 규칙의 크루 소유자 갈래는 방어이므로, 트리거를 잠시 끄고(replica) 그 상태를 직접 만들어 검증한다.
  psql(['-c', `set session_replication_role = replica; delete from public.msgr_channel_members where channel_id = '${BCREW_DM}' and member_kind = 'user' and member_id = '${U.member}'; set session_replication_role = origin;`]);
  assert.equal(sql(`select string_agg(member_kind, ',' order by member_kind) from public.msgr_channel_members where channel_id = '${BCREW_DM}'`), 'crew,user', '전제: 방 = C(사람) + B의 크루, 소유자 B는 방에 없음');
  sql(`update public.msgr_org_members set role = 'admin' where org_id = '${ORG}' and user_id = '${U.admin}'`);
  assert.equal(sql(`select string_agg(member_kind, ',' order by member_kind) from public.msgr_channel_members where channel_id = '${BCREW_DM}'`), 'crew,user', '전제: 방 = C(사람) + B의 크루');
  sql(`insert into public.msgr_friends (a, b, status, requested_by) values (least('${U.owner}'::uuid, '${U.member}'::uuid), greatest('${U.owner}'::uuid, '${U.member}'::uuid), 'accepted', '${U.owner}') on conflict do nothing`);
  PERSONAL = last(asUser(U.owner, `select public.msgr_dm_personal('${U.member}')`));
  assert.ok(BC && BCREW_DM && PERSONAL);
});

test('message: 공개 채널은 org:로만, B↔C DM은 B·C의 u:로만(조직 멤버 A·관리자에게 가지 않는다) — u: payload엔 org_id, 본문은 어디에도 없다', { skip }, () => {
  sql('delete from realtime.sent');
  const pub = msg(U.owner, PUB);
  assert.equal(topicsOf('message', pub), `org:${ORG}`, '공개 채널 = 조직 토픽');
  const dm = msg(U.member, BC, `[{"kind":"user","id":"${U.extra}"}]`);
  assert.equal(topicsOf('message', dm), u(U.member, U.extra), 'DM = 방 사람 멤버의 u:만');
  assert.equal(sql(`select count(*) from realtime.sent where topic = 'org:${ORG}' and payload->>'id' = '${dm}'`), '0', 'DM 글이 조직 토픽으로 나가지 않는다');
  assert.equal(sql(`select distinct payload->>'org_id' from realtime.sent where payload->>'id' = '${dm}'`), ORG, 'u: payload는 어느 공간의 글인지 싣는다');
  assert.equal(sql(`select count(*) from realtime.sent where payload ? 'body'`), '0', '본문은 싣지 않는다');
});

test('message: 크루가 있는 방은 그 크루의 소유자도 u:로 받는다(브리지 깨우기) — 소유자가 방 멤버가 아니어도', { skip }, () => {
  sql('delete from realtime.sent');
  const id = msg(U.extra, BCREW_DM);
  assert.equal(topicsOf('message', id), u(U.extra, U.member), 'C(멤버) + B(크루 소유자)');
});

test('message: 개인 공간은 u:(두 사람) + 옛 dm:<채널>(0.1.28 호환), org:는 없다', { skip }, () => {
  sql('delete from realtime.sent');
  const id = msg(U.owner, PERSONAL);
  assert.equal(topicsOf('message', id), [`dm:${PERSONAL}`, `u:${U.member}`, `u:${U.owner}`].sort().join(','));
});

test('approval: 비공개 방 결재는 멤버 + 크루 소유자 + 확정권자의 u:로 — 고위험은 관리자, 저위험은 크루 소유자, 무관한 멤버에게는 가지 않는다', { skip }, () => {
  sql('delete from realtime.sent');
  const hi = sql(`insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${BCREW_DM}', '${BCREW}', 'ap-hi', '메일 발송', 'high') returning id`);
  assert.equal(topicsOf('approval', hi), u(U.extra, U.member, U.owner, U.admin), '고위험: C(멤버)·B(크루 소유자)·관리자(owner·admin)');
  const lo = sql(`insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${BCREW_DM}', '${BCREW}', 'ap-lo', '초안 저장', 'low') returning id`);
  assert.equal(topicsOf('approval', lo), u(U.extra, U.member), '저위험: 확정권자는 크루 소유자(B) — 관리자에게 가지 않는다');
  assert.equal(sql(`select count(*) from realtime.sent where event = 'approval' and topic like 'org:%'`), '0', '비공개 방 결재가 조직 토픽으로 나가지 않는다');
  const pubAp = sql(`insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${PUB}', '${BCREW}', 'ap-pub', '공지', 'high') returning id`);
  assert.equal(topicsOf('approval', pubAp), `org:${ORG}`, '공개 채널 결재는 지금처럼 조직 토픽');
});

test('approval: 확정권자도 지금 유효한 조직 멤버만 — (a) approvers 목록의 조직 밖 사용자에게 가지 않는다(검수 #605)', { skip }, () => {
  sql('delete from realtime.sent');
  // 조직 밖 사용자는 이제 목록에 넣을 수 없다(msgr_approvers_check, #606) — 그 전에 남은 목록을 흉내 내려 트리거를 끈 채 심는다
  psql(['-c', `set session_replication_role = replica; insert into public.msgr_org_policies (org_id, approval_high_by, approver_user_ids) values ('${ORG}', 'approvers', array['${U.outsider}', '${U.extra}']::uuid[])
       on conflict (org_id) do update set approval_high_by = 'approvers', approver_user_ids = excluded.approver_user_ids; set session_replication_role = origin;`]);
  const hi = sql(`insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${BCREW_DM}', '${BCREW}', 'ap-a', '메일 발송', 'high') returning id`);
  assert.equal(sql(`select count(*) from realtime.sent where event = 'approval' and topic = 'u:${U.outsider}'`), '0', '(a) 조직 밖 사용자의 u:로 결재가 나가지 않는다');
  assert.ok(topicsOf('approval', hi).split(',').includes(`u:${U.extra}`), '목록의 조직 멤버는 받는다');
  sql(`delete from public.msgr_org_policies where org_id = '${ORG}'`);
});

test('approval: (b) 조직 멤버 자격이 끝난 크루 소유자에게는 결재가 가지 않는다(검수 #605)', { skip }, () => {
  sql('delete from realtime.sent');
  // 조직에서 빠진 상태 = 만료 시각이 지난 멤버(시간이 흐르는 것만으로는 offboard 트리거가 돌지 않아 크루가 방에 남는다). 트리거를 끈 채 만료를 과거로 옮겨 그 상태를 만든다.
  const expire = (v) => psql(['-c', `set session_replication_role = replica; update public.msgr_org_members set expires_at = ${v} where org_id = '${ORG}' and user_id = '${U.member}'; set session_replication_role = origin;`]);
  expire("now() - interval '1 minute'");
  try {
    const lo = sql(`insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${BCREW_DM}', '${BCREW}', 'ap-b', '초안 저장', 'low') returning id`);
    assert.equal(topicsOf('approval', lo), u(U.extra), '(b) 조직 멤버 자격이 끝난 크루 소유자(B)에게는 저위험 결재도 가지 않는다');
  } finally { expire('null'); }
});

test('message: 방 멤버가 아닌 크루 소유자는 깨우기 필드만 받는다({id, channel_id, crew_id, org_id}) — 작성자·멘션은 방 멤버에게만', { skip }, () => {
  sql('delete from realtime.sent');
  const id = msg(U.extra, BCREW_DM, `[{"kind":"user","id":"${U.extra}"}]`);
  const keys = (who) => sql(`select string_agg(k, ',' order by k) from realtime.sent, jsonb_object_keys(payload) k where event = 'message' and topic = 'u:${who}' and payload->>'id' = '${id}'`);
  assert.equal(keys(U.member), 'channel_id,crew_id,id,org_id', '방 밖 소유자(B)');
  assert.equal(keys(U.extra), 'author_kind,author_user_id,channel_id,crew_id,id,kind,mentions,org_id,reply_to', '방 멤버(C)는 전체');
});

test('crew_request: 비공개 방이면 방 사람들의 u:, 채널 없는(조직 범위) 요청과 공개 채널은 org:', { skip }, () => {
  sql('delete from realtime.sent');
  const priv = sql(`insert into public.msgr_crew_requests (org_id, channel_id, name, prompt, created_by) values ('${ORG}', '${BC}', '리서처', '조사', '${U.member}') returning id`);
  assert.equal(topicsOf('crew_request', priv), u(U.member, U.extra));
  const none = sql(`insert into public.msgr_crew_requests (org_id, channel_id, name, prompt, created_by) values ('${ORG}', null, '리서처', '조사', '${U.member}') returning id`);
  assert.equal(topicsOf('crew_request', none), `org:${ORG}`);
});

test('수신 정책: u:<uid>는 본인만 받고, 누구도 u:로 보낼 수 없다 — 비멤버는 조직 토픽에서 DM 방송을 받을 길이 없다', { skip }, () => {
  sql(`delete from realtime.messages; insert into realtime.messages (topic, extension, payload) values ('u:${U.member}', 'broadcast', '{}'), ('u:${U.owner}', 'broadcast', '{}')`);
  const recv = (who, topic) => last(asUser(who, `select set_config('realtime.topic', '${topic}', false); select count(*) from realtime.messages where topic = '${topic}'`));
  assert.equal(recv(U.member, `u:${U.member}`), '1', '본인 토픽은 받는다');
  assert.equal(recv(U.owner, `u:${U.member}`), '0', '남의 u: 토픽은 받지 못한다(조직 소유자라도)');
  assert.equal(recv(U.outsider, `u:${U.member}`), '0');
  const canSend = (who, topic) => asUserRaw(who, `select set_config('realtime.topic', '${topic}', false); insert into realtime.messages (topic, extension, payload) values ('${topic}', 'broadcast', '{}')`).status === 0;
  assert.equal(canSend(U.member, `u:${U.member}`), false, '자기 u:로도 보낼 수 없다(서버 트리거만 보낸다)');
  assert.equal(canSend(U.owner, `u:${U.member}`), false);
});

test('msgr_unread_totals: 공간별 합계(조직·개인 null) — 채널별 셈은 msgr_unread와 같고, 음소거 채널은 뺀다', { skip }, () => {
  // A(owner)에게: 공개 채널 1(멘션 1) + 개인 1:1 1. B↔C DM은 A가 못 읽으므로 세지 않는다.
  sql(`delete from public.msgr_messages; delete from public.msgr_reads`);
  msg(U.member, PUB, `[{"kind":"user","id":"${U.owner}"}]`);
  msg(U.member, PERSONAL);
  msg(U.member, BC);
  const totals = () => asUser(U.owner, `select coalesce(org_id::text, 'personal') || '=' || n || '/' || mention from public.msgr_unread_totals() order by 1`).split('\n').filter((l) => /=/.test(l)).join(',');
  assert.equal(totals(), [`${ORG}=1/1`, 'personal=1/0'].sort().join(','));
  const perChannel = last(asUser(U.owner, `select sum(n) from public.msgr_unread('${ORG}')`));
  assert.equal(perChannel, '1', '조직 합계 = 기존 채널별 셈의 합');
  sql(`insert into public.msgr_channel_prefs (user_id, channel_id, muted) values ('${U.owner}', '${PERSONAL}', true) on conflict (channel_id, user_id) do update set muted = true`);
  assert.equal(totals(), `${ORG}=1/1`, '음소거한 개인 방은 합계에서 빠진다(독 배지와 같은 규칙)');
});
