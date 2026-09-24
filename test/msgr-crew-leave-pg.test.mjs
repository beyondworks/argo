// 규칙 14 — 에이전트는 주인이 데려오고, 주인이 나가면 같이 나가며, 주인은 언제든 한 방에서 데려갈 수 있다.
// 전에는 "내 에이전트가 있으면 못 나간다"가 앱에만 있어 API로 나가면 에이전트가 주인 없이 죽은 채 남았고,
// 주인이 자기 에이전트를 한 채널에서만 빼는 경로가 없었다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-leave-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-leave-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { host: '11111111-1111-4111-8111-111111111111', mate: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333', svc: '44444444-4444-4444-8444-444444444444' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const crewIn = (ch, crew) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'crew' and member_id = '${crew}'`);
const userIn = (ch, uid) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${uid}'`);
const put = (ch, kind, id) => sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', '${kind}', '${id}') on conflict do nothing`);

let ORG, MINE, MINE2, OTHERS, COMPANY, BOT;
const room = (kind, name) => last(asUser(U.host, `select public.msgr_create_channel('${ORG}','${kind}','${name}')`));
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
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select null::void $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.host, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.host}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.mate, U.other]) {
    const code = last(asUser(U.host, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.host}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.svc}', 'member')`);
  sql(`update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}'`);
  const crew = (owner, slug, hosting = 'local') => last(sql(`select set_config('msgr.bot_create', '1', false); insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status, hosting) values ('${ORG}', '${owner}', 'lean', '${slug}', '${slug}', 'active', '${hosting}') returning id`));
  MINE = crew(U.mate, 'mine'); MINE2 = crew(U.mate, 'mine2'); OTHERS = crew(U.other, 'others');
  COMPANY = crew(U.svc, 'company', 'resident');
  BOT = crew(U.mate, 'mate-bot', 'bot'); // 멤버가 연결한 봇 — 주인은 이 멤버다(2026-09-24부터 봇도 개인 등급: Argo 에이전트처럼 소유자만)
  assert.equal(sql(`select public.msgr_crew_is_company('${COMPANY}')`), 't');
  assert.equal(sql(`select public.msgr_crew_is_company('${BOT}')`), 'f', '봇은 회사 에이전트가 아니다(주인이 사람)');
  assert.equal(sql(`select public.msgr_crew_tier('${BOT}')`), 'personal', '봇은 개인 등급(20260924180000)');
  assert.equal(sql(`select public.msgr_crew_is_company('${BOT}')`), 'f', '회사 에이전트가 아니다 — 주인을 따라 나간다');
});

test('주인이 비공개 채널을 나가면 그 주인의 에이전트·봇도 나간다 — 남의 에이전트·회사 에이전트는 남는다', { skip }, () => {
  const ch = room('private', 'Leave');
  for (const [k, id] of [['user', U.mate], ['user', U.other], ['crew', MINE], ['crew', MINE2], ['crew', BOT], ['crew', OTHERS], ['crew', COMPANY]]) put(ch, k, id);
  // 앱을 거치지 않고 API로 직접 자기 행을 지운다(종전에 클라이언트 차단을 우회하던 바로 그 경로)
  assert.equal(last(asUser(U.mate, `delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${U.mate}' returning member_id`)), U.mate);
  assert.equal(userIn(ch, U.mate), '0');
  for (const c of [MINE, MINE2, BOT]) assert.equal(crewIn(ch, c), '0', '주인이 나가면 같이 나간다');
  assert.equal(crewIn(ch, OTHERS), '1', '남의 에이전트는 남는다');
  assert.equal(crewIn(ch, COMPANY), '1', '회사 에이전트는 사람이 주인이 아니다');
  const audit = sql(`select count(*) from public.msgr_audit_log where action = 'crew_left_with_owner' and meta->>'channel_id' = '${ch}'`);
  assert.equal(audit, '3', '빠진 에이전트마다 감사 기록');
});

test('방장이 서비스 계정을 빼도 회사 에이전트는 남는다 — 사람이 주인이 아니다', { skip }, () => {
  // 회사 에이전트의 owner_user_id는 조직 서비스 계정이다. 그 계정의 사람 행이 지워지면 "주인이 나갔다"로 보여
  // 회사 에이전트까지 빠질 수 있다 — 트리거의 회사 보호절(msgr_crew_is_company)이 막는 유일한 경로.
  const ch = room('private', 'Service');
  put(ch, 'user', U.svc); put(ch, 'crew', COMPANY);
  asUser(U.host, `delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${U.svc}'`);
  assert.equal(userIn(ch, U.svc), '0');
  assert.equal(crewIn(ch, COMPANY), '1', '회사 에이전트는 남는다');
});

test('방장이 사람을 빼도 그 사람의 에이전트가 같이 빠진다 — 경로를 가리지 않는다', { skip }, () => {
  const ch = room('private', 'Kick');
  put(ch, 'user', U.mate); put(ch, 'crew', MINE);
  asUser(U.host, `delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${U.mate}'`);
  assert.equal(crewIn(ch, MINE), '0');
});

test('주인은 자기 에이전트를 한 채널에서만 뺄 수 있다 — 다른 채널에는 남는다', { skip }, () => {
  const a = room('private', 'A'); const b = room('private', 'B');
  for (const ch of [a, b]) { put(ch, 'user', U.mate); put(ch, 'crew', MINE); }
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_leave_channel('${a}', '${MINE}')`)), 'removed');
  assert.equal(crewIn(a, MINE), '0');
  assert.equal(crewIn(b, MINE), '1', '다른 채널은 그대로');
  assert.equal(userIn(a, U.mate), '1', '에이전트만 빠지고 주인은 남는다');
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_leave_channel('${a}', '${MINE}')`)), 'absent', '두 번 눌러도 한 번');
  assert.equal(sql(`select meta->>'by' from public.msgr_audit_log where action = 'crew_removed_from_channel' and meta->>'channel_id' = '${a}'`), 'owner');
});

test('주인도 방장도 아니면 남의 에이전트를 뺄 수 없다 — 방장은 뺄 수 있다', { skip }, () => {
  const ch = room('private', 'Guard');
  put(ch, 'user', U.mate); put(ch, 'user', U.other); put(ch, 'crew', MINE);
  const r = asUserRaw(U.other, `select public.msgr_crew_leave_channel('${ch}', '${MINE}')`);
  assert.notEqual(r.status, 0, '같은 방 멤버라도 남의 에이전트는 못 뺀다'); assert.match(r.stderr, /msgr_forbidden/);
  assert.equal(crewIn(ch, MINE), '1');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_leave_channel('${ch}', '${MINE}')`)), 'removed', '방장');
  assert.equal(sql(`select meta->>'by' from public.msgr_audit_log where action = 'crew_removed_from_channel' and meta->>'channel_id' = '${ch}'`), 'host');
});

test('주인이 나가면 그 주인의 대기 요청도 닫힌다 — 방장이 나중에 승인해도 나간 사람이 다시 끌려오지 않는다', { skip }, () => {
  const ch = room('private', 'Request');
  put(ch, 'user', U.mate);
  sql(`update public.msgr_channels set personal_crews = 'approval' where id = '${ch}'`);
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${ch}', '${MINE}')`)), 'requested');
  const req = sql(`select id from public.msgr_channel_crew_requests where channel_id = '${ch}' and crew_id = '${MINE}' and status = 'pending'`);
  assert.ok(req, '요청이 걸려 있다');
  asUser(U.mate, `delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${U.mate}'`);
  assert.equal(sql(`select count(*) from public.msgr_channel_crew_requests where id = '${req}'`), '0', '대기 요청이 닫혔다');
  const late = asUserRaw(U.host, `select public.msgr_crew_join_decide('${req}', true)`);
  assert.notEqual(late.status, 0, '닫힌 요청은 승인할 수 없다');
  assert.equal(userIn(ch, U.mate), '0', '나간 사람이 다시 들어오지 않는다');
  assert.equal(crewIn(ch, MINE), '0');
});

test('공개 채널에서 사람을 제외 목록에 넣으면 그 사람의 에이전트도 빠진다 — 참여 행을 안 지우는 호출이어도', { skip }, () => {
  const ch = room('public', 'Exclude');
  for (const [k, id] of [['user', U.mate], ['user', U.other], ['crew', MINE], ['crew', BOT], ['crew', OTHERS], ['crew', COMPANY]]) put(ch, k, id);
  // 제외 목록만 갱신한다(참여 행 삭제 트리거가 걸리지 않는 경로)
  asUser(U.host, `update public.msgr_channels set excluded_user_ids = array['${U.mate}']::uuid[] where id = '${ch}'`);
  assert.equal(userIn(ch, U.mate), '1', '사람 행은 이 호출이 지우지 않았다');
  for (const c of [MINE, BOT]) assert.equal(crewIn(ch, c), '0', '제외된 사람의 에이전트는 빠진다');
  assert.equal(crewIn(ch, OTHERS), '1', '남의 에이전트는 남는다');
  assert.equal(crewIn(ch, COMPANY), '1', '회사 에이전트는 남는다');
  // 이미 제외된 사람은 다시 세지 않는다 — 다른 사람을 더 넣어도 그 사람 것만
  asUser(U.host, `update public.msgr_channels set excluded_user_ids = array['${U.mate}', '${U.other}']::uuid[] where id = '${ch}'`);
  assert.equal(crewIn(ch, OTHERS), '0', '새로 제외된 사람의 에이전트');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where action = 'crew_left_with_owner' and meta->>'channel_id' = '${ch}' and meta->>'via' = 'excluded'`), '3');
});

test('채널을 통째로 지워도 트리거가 넘어지지 않는다(연쇄 삭제 중 발화)', { skip }, () => {
  const ch = room('private', 'Gone');
  put(ch, 'user', U.mate); put(ch, 'crew', MINE);
  sql(`delete from public.msgr_channels where id = '${ch}'`);
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}'`), '0');
});
