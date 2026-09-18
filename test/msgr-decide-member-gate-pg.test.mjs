// 결재 확정권은 현재 멤버에게만 — msgr_can_decide 자체가 떠난 사람·만료 게스트·게스트를 거절한다(방어 두 겹, 20260918193000).
// 재현(2026-09-18): 수정 전에는 함수가 true를 주고, 확정 UPDATE만 SELECT 정책이 행을 가려 0행이었다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-decide-member-gate-pg.test.mjs
// 수정 전과 비교: DECIDE_GATE_OFF=1 이면 20260918193000을 적용하지 않는다(판정·정리·검사 단언이 red).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-decide-member-gate-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const GATE = '20260918193000_msgr_decide_member_gate.sql';
const U = { owner: '11111111-1111-4111-8111-111111111111', approver: '22222222-2222-4222-8222-222222222222', crewOwner: '33333333-3333-4333-8333-333333333333',
  guest: '44444444-4444-4444-8444-444444444444', outsider: '55555555-5555-4555-8555-555555555555', spare: '66666666-6666-4666-8666-666666666666' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, PUB, CREW;
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
  const files = readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort().filter((x) => !(process.env.DECIDE_GATE_OFF && x === GATE));
  for (const f of files) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.approver, U.crewOwner, U.guest, U.spare]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  sql(`update public.msgr_org_members set role = 'guest' where org_id = '${ORG}' and user_id = '${U.guest}'`); // 게스트 초대는 채널이 필요 — 역할만 바꾼다
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','General')`));
  CREW = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, allow) values ('${ORG}', '${U.crewOwner}', 'ws-crew', 'crew', '크루', 'all') returning id`));
});

const newAp = (risk, tag) => last(sql(`insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, risk) values ('${ORG}', '${PUB}', '${CREW}', '${tag}', '결제', '${risk}') returning id`));
const canDecide = (uid, ap) => last(asUser(uid, `select public.msgr_can_decide('${ap}')`));
const decide = (uid, ap) => last(asUser(uid, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${uid}', decided_at = now() where id = '${ap}' returning status`));
const status = (ap) => sql(`select status from public.msgr_crew_approvals where id = '${ap}'`);
const approvers = () => sql(`select array_to_string(approver_user_ids, ',') from public.msgr_org_policies where org_id = '${ORG}'`);
// 트리거를 끄고 목록을 심는다 — 정리 트리거와 별개로 "목록에 남은 떠난 사람"을 판정이 스스로 거절하는지 본다(두 번째 겹)
const plant = (ids) => sql(`set session_replication_role = replica; update public.msgr_org_policies set approval_high_by = 'approvers', approver_user_ids = array[${ids.map((i) => `'${i}'::uuid`).join(',')}]::uuid[] where org_id = '${ORG}'; set session_replication_role = origin;`);
const member = (uid, set) => sql(`update public.msgr_org_members set ${set} where org_id = '${ORG}' and user_id = '${uid}'`);
const reset = () => { for (const u of [U.approver, U.crewOwner, U.spare]) member(u, `removed_at = null, expires_at = null, role = 'member'`); member(U.guest, `removed_at = null, expires_at = null, role = 'guest'`); sql(`update public.msgr_crews set status = 'active' where id = '${CREW}'`); };

test('대조 — 현재 멤버인 지정 결재권자는 high 결재를 확정한다', { skip }, () => {
  reset(); plant([U.approver]);
  const ap = newAp('high', 'g-ctl');
  assert.equal(canDecide(U.approver, ap), 't');
  assert.equal(decide(U.approver, ap), 'approved');
});

test('판정이 스스로 거절 — 목록에 남은 제거된 결재권자·만료 게스트·현재 게스트', { skip }, () => {
  reset();
  member(U.approver, `removed_at = now()`); plant([U.approver]);
  let ap = newAp('high', 'g-removed');
  assert.equal(canDecide(U.approver, ap), 'f', '제거된 결재권자');
  assert.equal(decide(U.approver, ap), '', '확정 0행'); assert.equal(status(ap), 'pending');
  reset();
  member(U.guest, `expires_at = now() - interval '1 second'`); plant([U.guest]);
  ap = newAp('high', 'g-expired');
  assert.equal(canDecide(U.guest, ap), 'f', '만료 게스트');
  reset(); plant([U.guest]);
  ap = newAp('high', 'g-guest');
  assert.equal(canDecide(U.guest, ap), 'f', '현재 게스트도 확정권 없음(총괄 결정)');
});

test('판정이 스스로 거절 — 조직에서 제거된 크루 소유자의 low 결재·카드 갱신', { skip }, () => {
  reset(); sql(`update public.msgr_org_policies set approval_high_by = 'admin', approver_user_ids = '{}' where org_id = '${ORG}'`);
  const ap = newAp('low', 'g-owner');
  assert.equal(canDecide(U.crewOwner, ap), 't', '대조: 멤버인 소유자');
  member(U.crewOwner, `removed_at = now()`);
  assert.equal(canDecide(U.crewOwner, ap), 'f', '제거된 소유자');
  assert.equal(decide(U.crewOwner, ap), '', '확정 0행');
  assert.equal(last(asUser(U.crewOwner, `update public.msgr_crew_approvals set reason = 'x' where id = '${ap}' returning 1`)), '', 'pending 유지 갱신도 0행');
  assert.equal(status(ap), 'pending');
});

test('떠나면 목록에서도 빠진다 — 제거·게스트 강등·행 삭제, 감사 남김', { skip }, () => {
  reset(); plant([U.approver, U.spare, U.crewOwner]);
  const since = sql(`select coalesce(max(id), 0) from public.msgr_audit_log`); // 앞선 테스트의 제거도 정당하게 감사를 남긴다 — 이 테스트 것만 센다
  member(U.approver, `removed_at = now()`);
  assert.ok(!approvers().includes(U.approver), '제거');
  member(U.spare, `role = 'guest'`);
  assert.ok(!approvers().includes(U.spare), '게스트 강등');
  sql(`delete from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.crewOwner}'`);
  assert.ok(!approvers().includes(U.crewOwner), '행 삭제');
  assert.equal(sql(`select string_agg(meta->>'reason', ',' order by id) from public.msgr_audit_log where org_id = '${ORG}' and action = 'policy.approver.pruned' and id > ${since}`), 'removed,guest,deleted');
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.crewOwner}', 'member') on conflict do nothing`);
});

test('새로 넣는 결재권자는 현재 멤버만 — 남아 있던 항목은 다른 저장을 막지 않는다', { skip }, () => {
  reset(); sql(`update public.msgr_org_policies set approval_high_by = 'admin', approver_user_ids = '{}' where org_id = '${ORG}'`);
  const put = (ids) => asUserRaw(U.owner, `update public.msgr_org_policies set approval_high_by = 'approvers', approver_user_ids = array[${ids.map((i) => `'${i}'::uuid`).join(',')}]::uuid[] where org_id = '${ORG}' returning 1`);
  let r = put([U.outsider]); assert.notEqual(r.status, 0, '조직 밖 사람'); assert.match(r.stderr, /msgr_approver_not_member/);
  r = put([U.guest]); assert.notEqual(r.status, 0, '게스트'); assert.match(r.stderr, /msgr_approver_not_member/);
  member(U.spare, `removed_at = now()`); r = put([U.spare]); assert.notEqual(r.status, 0, '제거된 사람'); assert.match(r.stderr, /msgr_approver_not_member/);
  r = put([U.approver]); assert.equal(r.status, 0, r.stderr); assert.equal(approvers(), U.approver, '현재 멤버는 된다');
  // 트리거가 못 닿는 경로(만료 등)로 남은 항목이 있어도 다른 설정 저장은 된다
  plant([U.approver, U.guest]);
  r = asUserRaw(U.owner, `update public.msgr_org_policies set allow_default = allow_default where org_id = '${ORG}' returning 1`);
  assert.equal(r.status, 0, r.stderr);
});
