// 채팅(DM — 1:1·여러 명)에서 참여자가 자기 에이전트를 넣으면 방을 연 사람이 결재한다(유건 2026-09-18, 20260918170000).
// ① 결재자 본인의 에이전트는 바로 ② 다른 참여자는 요청 → 결재자만 허락 ③ 방을 연 사람이 나가면 남은 사람 중 가장 먼저 들어온 사람
// ④ 서버 강제 — RPC(msgr_crew_join·decide)와 RLS 직접 삽입 둘 다. 채널(방장 결재)은 그대로다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-dm-crew-approval-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { psqlSpawn } from './helpers/pg.mjs';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-dm-crew-approval-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { host: '11111111-1111-4111-8111-111111111111', mate: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333', svc: '44444444-4444-4444-8444-444444444444', out: '55555555-5555-4555-8555-555555555555' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 160)}`); };
const why = (crew, author, ch) => sql(`select public.msgr_instruct_check('${crew}', '${author}', '${ch}')`);
const inCh = (ch, crew) => sql(`select public.msgr_crew_in_channel('${ch}', '${crew}')`);

let ORG, PRIV, PUB, DM, HOSTC, MATEC, OTHERC, COMP, MATEBOT;
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
  const crew = (owner, slug, hosting = 'local') => last(sql(`select set_config('msgr.bot_create', '${hosting === 'bot' ? '1' : ''}', false); insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status, allow, hosting) values ('${ORG}', '${owner}', 'lean', '${slug}', '${slug}', 'active', 'owner', '${hosting}') returning id`));
  HOSTC = crew(U.host, 'hostc'); MATEC = crew(U.mate, 'matec'); OTHERC = crew(U.other, 'otherc'); COMP = crew(U.svc, 'company', 'resident'); MATEBOT = crew(U.mate, 'matebot', 'bot');
});
const join = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_join('${ch}', '${crew}')`));
const approver = (ch) => sql(`select public.msgr_dm_approver('${ch}')`);
const reqOf = (ch, crew) => sql(`select id from public.msgr_channel_crew_requests where channel_id = '${ch}' and crew_id = '${crew}' and status = 'pending'`);
const seesReq = (uid, ch) => last(asUser(uid, `select count(*) from public.msgr_channel_crew_requests where channel_id = '${ch}'`));
const decide = (uid, req, ok = true) => asUserRaw(uid, `select public.msgr_crew_join_decide('${req}', ${ok})`);
const groupDm = (name) => last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'dm', '${name}', '[{"kind":"user","id":"${U.mate}"},{"kind":"user","id":"${U.other}"}]'::jsonb)`));

test('① 방을 연 사람의 에이전트는 바로 들어간다 — 결재자 = 방을 연 사람', { skip }, () => {
  const g = groupDm('g1');
  assert.equal(approver(g), U.host);
  assert.equal(join(U.host, g, HOSTC), 'joined');
  assert.equal(inCh(g, HOSTC), 't');
});

test('② 다른 참여자의 에이전트는 요청이 되고, 결재자만 허락한다(요청자·다른 참여자는 못 한다)', { skip }, () => {
  const g = groupDm('g2');
  assert.equal(join(U.mate, g, MATEC), 'requested');
  assert.equal(inCh(g, MATEC), 'f', '허락 전에는 방에 없다');
  const req = reqOf(g, MATEC);
  assert.ok(req, '대기 요청이 있다');
  assert.equal(seesReq(U.mate, g), '1', '요청한 사람은 본다');
  assert.equal(seesReq(U.host, g), '1', '결재자는 본다');
  assert.equal(seesReq(U.other, g), '0', '다른 참여자는 보지 않는다(채팅에서 msgr_can_manage_channel은 참여자 전원)');
  fails(decide(U.mate, req), /msgr_forbidden/, '요청자 스스로 허락');
  fails(decide(U.other, req), /msgr_forbidden/, '다른 참여자의 허락');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join_decide('${req}', true)`)), 'approved');
  assert.equal(inCh(g, MATEC), 't', '허락 뒤 방에 들어온다');
  // 남의 에이전트를 데려오는 길은 여전히 없다(주인만 요청)
  fails(asUserRaw(U.other, `select public.msgr_crew_join('${g}', '${HOSTC}')`), /msgr_forbidden/, '남의 에이전트 요청');
});

test('④ RLS 직접 삽입 — 결재자가 아니면 자기 에이전트도 바로 못 넣는다(결재를 건너뛰는 길)', { skip }, () => {
  const g = groupDm('g3');
  fails(asUserRaw(U.mate, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${g}', 'crew', '${MATEC}', '${U.mate}')`), /row-level security/, '비결재자의 직접 삽입');
  assert.equal(asUserRaw(U.host, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${g}', 'crew', '${HOSTC}', '${U.host}')`).status, 0, '결재자는 자기 에이전트를 직접 넣을 수 있다');
  // 채팅을 만들며 others로 끼워 넣는 길: 만든 사람의 에이전트만(만든 사람이 곧 결재자)
  const made = asUserRaw(U.mate, `select public.msgr_create_channel('${ORG}', 'dm', 'g3b', '[{"kind":"user","id":"${U.host}"},{"kind":"crew","id":"${HOSTC}"}]'::jsonb)`);
  fails(made, /msgr_bad_member/, '남의 에이전트를 만들며 끼워 넣기');
  assert.equal(asUserRaw(U.mate, `select public.msgr_create_channel('${ORG}', 'dm', 'g3c', '[{"kind":"user","id":"${U.host}"},{"kind":"crew","id":"${MATEC}"}]'::jsonb)`).status, 0, '만든 사람은 자기 에이전트를 함께 넣는다');
});

test('③ 방을 연 사람이 나가면 남은 사람 중 가장 먼저 들어온 사람이 결재자 — 대기 요청이 그대로 넘어간다', { skip }, () => {
  const g = groupDm('g4');
  assert.equal(join(U.other, g, OTHERC), 'requested');
  const req = reqOf(g, OTHERC);
  assert.equal(seesReq(U.mate, g), '0', '나가기 전에는 mate가 결재자가 아니다');
  assert.equal(last(asUser(U.host, `select public.msgr_leave_dm('${g}')`)), 't');
  // 한 트랜잭션에서 함께 들어온 mate·other는 added_at이 같다 → user id 순(결정적)
  assert.equal(approver(g), U.mate, '남은 사람 중 가장 먼저 들어온 사람');
  assert.equal(seesReq(U.mate, g), '1', '새 결재자에게 대기 요청이 보인다');
  fails(decide(U.host, req), /msgr_forbidden/, '나간 사람은 더 이상 결정하지 못한다');
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join_decide('${req}', true)`)), 'approved');
  assert.equal(inCh(g, OTHERC), 't');
  assert.equal(join(U.mate, g, MATEC), 'joined', '새 결재자의 에이전트는 바로');
});

test('요청한 사람이 나가면 요청은 닫히고, 그 에이전트만 들어오지 않는다', { skip }, () => {
  const g = groupDm('g5');
  assert.equal(join(U.other, g, OTHERC), 'requested');
  const req = reqOf(g, OTHERC);
  assert.equal(last(asUser(U.other, `select public.msgr_leave_dm('${g}')`)), 't');
  fails(decide(U.host, req), /msgr_request_closed|msgr_bad_member/, '주인이 나간 뒤의 허락');
  assert.equal(inCh(g, OTHERC), 'f');
});

test('1:1도 같은 규칙 — 대화를 연 사람이 결재자, 상대의 에이전트는 요청', { skip }, () => {
  const d = last(asUser(U.mate, `select public.msgr_create_channel('${ORG}', 'dm', 'one', '[{"kind":"user","id":"${U.host}"}]'::jsonb)`));
  assert.equal(approver(d), U.mate);
  assert.equal(join(U.host, d, HOSTC), 'requested');
  assert.equal(join(U.mate, d, MATEC), 'joined');
});

test('채팅이 아니면 결재자 없음 — 채널은 방장 결재 그대로', { skip }, () => {
  const p = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'private', 'room', '[{"kind":"user","id":"${U.mate}"}]'::jsonb)`));
  assert.equal(approver(p), '');
  assert.equal(join(U.mate, p, MATEC), 'requested', '방장이 아닌 멤버는 요청');
  assert.equal(seesReq(U.host, p), '1', '방장은 본다(채널은 msgr_can_manage_channel 그대로)');
  fails(decide(U.mate, reqOf(p, MATEC)), /msgr_forbidden/, '채널에서 요청자 스스로 허락(결재자 NULL이 판정을 NULL로 만들면 plpgsql IF가 통과시킨다)');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join_decide('${reqOf(p, MATEC)}', true)`)), 'approved');
  assert.equal(join(U.host, p, HOSTC), 'joined', '방장 자기 에이전트는 바로');
});
