// 업무 > 자동화 1단계 — msgr_crew_routines·msgr_crew_routine_edits RLS·RPC 통합 테스트(실 Postgres).
// 순수 로직(해시 스킵·나중 수정 우선·채널 필터)은 test/msgr-crew-routines.test.mjs. 실행: npm run test:pg 또는
// scripts/billing-pg-drill.sh test/msgr-crew-routines-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const sqlRaw = (q) => psqlRaw(['-A', '-t', '-c', q]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };

let ORG, CREW, OTHER_CREW, CH;
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
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const migrationDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(migrationDir).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort()) {
    const source = readFileSync(mig(f), 'utf8');
    psql(['-c', source.replace(/^create extension if not exists pg_net;$/m, '')]);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const uid of [U.admin, U.member]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  OTHER_CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean', 'theirs', 'Theirs') returning id`));
  CH = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Work')`));
});

const rowsSql = `p_org=>'${ORG}',p_crew=>'${CREW}',p_rows=>'[{"ext_id":"r1","title":"아침 보고","prompt":"오늘 할 일 정리","schedule":{"type":"daily","time":"09:00"},"enabled":true}]'::jsonb`;

test('routines — 소유자 sync·읽기, 다른 조직원은 0행', { skip }, () => {
  assert.equal(last(asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`)) !== '', true);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_crew_routines where crew_id = '${CREW}'`)), '1');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_crew_routines where crew_id = '${CREW}'`)), '0', '조직원(비소유자)은 안 보인다');
  assert.equal(last(asUser(U.guest, `select count(*) from public.msgr_crew_routines where crew_id = '${CREW}'`)), '0', '다른 조직원도 안 보인다');
});

test('routines — 비소유자 sync는 42501, 남의 크루 지정 불가', { skip }, () => {
  fails(asUserRaw(U.member, `select public.msgr_crew_routines_sync(${rowsSql})`), /42501|msgr_routine_forbidden/, '남의 크루로 sync');
});

test('routines — 같은 내용으로 다시 sync하면 쓰기 0(xmin 불변)', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const before = last(asUser(U.owner, `select xmin::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const after = last(asUser(U.owner, `select xmin::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  assert.equal(after, before, '같은 값이면 행을 다시 쓰지 않는다');
});

test('routines — sync 스냅샷에서 빠진 ext_id는 삭제된다', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  asUser(U.owner, `select public.msgr_crew_routines_sync(p_org=>'${ORG}',p_crew=>'${CREW}',p_rows=>'[]'::jsonb)`);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_crew_routines where crew_id='${CREW}'`)), '0');
});

test('edits — 소유자만 편집 걸 수 있고, 이전 pending은 replaced로 접힌다(H3: 폴드 — 메신저 쪽 판정)', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  fails(asUserRaw(U.member, `select public.msgr_crew_routine_edit('${rid}','update','{"title":"침입"}'::jsonb)`), /42501|msgr_routine_forbidden/, '비소유자 편집 거절');
  const e1 = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','update','{"title":"1차"}'::jsonb))->>'id' as id) x`));
  const e2 = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','update','{"title":"2차"}'::jsonb))->>'id' as id) x`));
  assert.equal(last(asUser(U.owner, `select status from public.msgr_crew_routine_edits where id='${e1}'`)), 'replaced', 'superseded가 아니라 replaced — PC 판정이 아니라 메신저 쪽 자동 폴드다(M3)');
  assert.equal(last(asUser(U.owner, `select status from public.msgr_crew_routine_edits where id='${e2}'`)), 'pending');
  const pending = last(asUser(U.owner, `select edit_id::text from public.msgr_crew_routine_edits_pending('${ORG}', array['${CREW}']::uuid[])`));
  assert.equal(pending, e2, 'PC는 최신 편집만 가져온다');
  fails(asUserRaw(U.member, `select public.msgr_crew_routine_edit_done('${e2}','applied')`), /42501|msgr_routine_forbidden/, '비소유자 done 거절');
  asUser(U.owner, `select public.msgr_crew_routine_edit_done('${e2}','applied')`);
  assert.equal(last(asUser(U.owner, `select status from public.msgr_crew_routine_edits where id='${e2}'`)), 'applied');
});

test('edits(H3) — 폴드는 이전 patch를 새 patch에 병합한다(얕은 병합, 새 값이 이긴다) + delete가 항상 우선', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  asUser(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"title":"1차"}'::jsonb)`);
  const e2 = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','update','{"enabled":false}'::jsonb))->>'id' as id) x`));
  assert.equal(last(asUser(U.owner, `select patch::text from public.msgr_crew_routine_edits where id='${e2}'`)), '{"title": "1차", "enabled": false}', '1차 편집의 title이 2차 patch에 살아있어야 한다(H3 폴드 손실 방지)');
  const e3 = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','delete','{}'::jsonb))->>'id' as id) x`));
  assert.equal(last(asUser(U.owner, `select op||' '||patch::text from public.msgr_crew_routine_edits where id='${e3}'`)), 'delete {}', 'delete는 이전 patch를 이어받지 않고 우선한다');
  // 재검수(2차, probe2-pg "C delete-then-update"): 지워달라 했다가 다시 update로 마음을 바꾸면 최종은 update다 — delete가 영구히 못 박히면 안 된다.
  const e4 = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','update','{"title":"after-delete"}'::jsonb))->>'id' as id) x`));
  assert.equal(last(asUser(U.owner, `select op||' '||patch::text from public.msgr_crew_routine_edits where id='${e4}'`)), 'update {"title": "after-delete"}');
  assert.equal(last(asUser(U.owner, `select status from public.msgr_crew_routine_edits where id='${e3}'`)), 'replaced');
});

test('edits(M1) — patch 허용 목록 밖 필드(agentSlug 등)는 서버가 거절한다', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"agentSlug":"evil"}'::jsonb)`), /msgr_routine_invalid_patch/, 'agentSlug');
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"notifications":{"channels":["telegram"]}}'::jsonb)`), /msgr_routine_invalid_patch/, 'notifications');
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"loop":{"maxUsd":999}}'::jsonb)`), /msgr_routine_invalid_patch/, 'loop');
});

test('edits(N3) — patch 필드 타입도 검사한다(문자열 "false"가 boolean으로 통과하면 안 된다)', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"enabled":"false"}'::jsonb)`), /msgr_routine_invalid_patch/, 'enabled 문자열');
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"title":123}'::jsonb)`), /msgr_routine_invalid_patch/, 'title 숫자');
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"prompt":123}'::jsonb)`), /msgr_routine_invalid_patch/, 'prompt 숫자');
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"schedule":"daily"}'::jsonb)`), /msgr_routine_invalid_patch/, 'schedule 문자열');
  asUser(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"enabled":false}'::jsonb)`); // 진짜 boolean은 통과
  assert.equal(last(asUser(U.owner, `select (patch->>'enabled') from public.msgr_crew_routine_edits where routine_id='${rid}' and status='pending'`)), 'false');
});

test('만료된 게스트 — sync·edit 모두 거절(msgr_channel_member_ok와 같은 기준: expires_at)', { skip }, () => {
  // U.guest를 ORG의 시한부 멤버로 합류시킨다(role: member — 게스트 role은 채널 지정이 따로 필요해 여기서는 만료 판정만 본다).
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
  assert.equal(last(asUser(U.guest, `select public.msgr_accept_invite('${code}')`)), ORG);
  const guestCrew = last(asUser(U.guest, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.guest}', 'lean', 'guestcrew', 'GuestCrew') returning id`));
  asUser(U.guest, `select public.msgr_crew_routines_sync('${ORG}','${guestCrew}','[{"ext_id":"g1","title":"t","prompt":"p","schedule":{"type":"daily"}}]'::jsonb)`);
  const grid = last(asUser(U.guest, `select id::text from public.msgr_crew_routines where crew_id='${guestCrew}'`));
  assert.notEqual(grid, '');
  sql(`update public.msgr_org_members set expires_at = now() - interval '1 day' where org_id='${ORG}' and user_id='${U.guest}'`);
  fails(asUserRaw(U.guest, `select public.msgr_crew_routines_sync('${ORG}','${guestCrew}','[{"ext_id":"g1","title":"t","prompt":"p","schedule":{"type":"daily"}}]'::jsonb)`), /42501|msgr_routine_forbidden/, '기한 지난 게스트 sync');
  fails(asUserRaw(U.guest, `select public.msgr_crew_routine_edit('${grid}','update','{"title":"x"}'::jsonb)`), /42501|msgr_routine_forbidden/, '기한 지난 게스트 edit');
});

test('edits — 다른 조직원은 edits 표도 0행', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  asUser(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"title":"1"}'::jsonb)`);
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_crew_routine_edits where routine_id='${rid}'`)), '0');
});

test('edits(H2) — edits_pending은 넘긴 crewIds에 한정된다(다른 크루의 편집은 안 나온다)', { skip }, () => {
  const crew2 = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'other-ws', 'mine2', 'Mine2') returning id`));
  asUser(U.owner, `select public.msgr_crew_routines_sync('${ORG}','${crew2}','[{"ext_id":"rx","title":"t","prompt":"p","schedule":{"type":"daily","time":"09:00"}}]'::jsonb)`);
  const rid2 = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${crew2}'`));
  asUser(U.owner, `select public.msgr_crew_routine_edit('${rid2}','update','{"title":"n"}'::jsonb)`);
  // CREW 자신은 앞선 테스트들이 만든 pending을 이미 가지고 있을 수 있다 — "0행"이 아니라 "crew2(rx)가 안 섞인다"를 본다.
  const onlyCrewExtIds = asUser(U.owner, `select ext_id from public.msgr_crew_routine_edits_pending('${ORG}', array['${CREW}']::uuid[])`).split('\n').filter(Boolean);
  assert.ok(!onlyCrewExtIds.includes('rx'), 'CREW만 넘겼으니 crew2(rx)의 대기 편집은 안 섞여야 한다(H2 — 다른 워크스페이스 오염 방지)');
  const bothExtIds = asUser(U.owner, `select ext_id from public.msgr_crew_routine_edits_pending('${ORG}', array['${CREW}','${crew2}']::uuid[])`).split('\n').filter(Boolean);
  assert.ok(bothExtIds.includes('rx'), 'crew2를 넘기면 rx가 보여야 한다');
});

test('sync(M2) — 없는 채널(FK 오염)은 예외 대신 null로 떨어지고, 나머지 행은 그대로 반영된다', { skip }, () => {
  const poison = `p_org=>'${ORG}',p_crew=>'${CREW}',p_rows=>'[{"ext_id":"rp1","title":"t1","prompt":"p","schedule":{"type":"daily"},"channel_id":"99999999-9999-4999-8999-999999999999"},{"ext_id":"rp2","title":"t2","prompt":"p","schedule":{"type":"daily"}}]'::jsonb`;
  const r = asUserRaw(U.owner, `select public.msgr_crew_routines_sync(${poison})`);
  assert.equal(r.status, 0, '없는 채널 하나 때문에 전체 sync가 죽으면 안 된다');
  assert.equal(last(asUser(U.owner, `select channel_id is null from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='rp1'`)), 't');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='rp2'`)), '1', '같은 배치의 다른 행은 정상 반영');
});

test('sync(M2) — 201자 제목은 거절 대신 200자로 잘려 반영된다(크루 전체 미러가 막히지 않는다)', { skip }, () => {
  const t = 'x'.repeat(201);
  const r = asUserRaw(U.owner, `select public.msgr_crew_routines_sync('${ORG}','${CREW}','[{"ext_id":"r9","title":"${t}","prompt":"p","schedule":{"type":"daily"}}]'::jsonb)`);
  assert.equal(r.status, 0);
  assert.equal(last(asUser(U.owner, `select length(title) from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r9'`)), '200');
});

test('sync(M2) — 구조가 이상한 행(ext_id·title·prompt 없음)은 그 행만 건너뛰고 나머지는 반영된다', { skip }, () => {
  const rows = `'[{"ext_id":"","title":"t","prompt":"p","schedule":{"type":"daily"}},{"ext_id":"rok","title":"t","prompt":"p","schedule":{"type":"daily"}}]'::jsonb`;
  const out = last(asUser(U.owner, `select public.msgr_crew_routines_sync('${ORG}','${CREW}',${rows})`));
  assert.match(out, /"skipped": ?1/);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='rok'`)), '1');
});

test('M5 — 크루가 detached되면 미러 행·대기 편집이 트리거로 지워지고, 재동기화·편집은 거절된다', { skip }, () => {
  const crew3 = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'offb', 'Offb') returning id`));
  asUser(U.owner, `select public.msgr_crew_routines_sync('${ORG}','${crew3}','[{"ext_id":"ro1","title":"t","prompt":"p","schedule":{"type":"daily"}}]'::jsonb)`);
  const rid3 = last(sql(`select id::text from public.msgr_crew_routines where crew_id='${crew3}'`));
  assert.notEqual(rid3, '');
  sql(`update public.msgr_crews set status='detached' where id='${crew3}'`);
  assert.equal(last(sql(`select count(*) from public.msgr_crew_routines where crew_id='${crew3}'`)), '0', '트리거가 미러 행을 지운다(슈퍼유저로 관찰 — RLS 우회)');
  fails(asUserRaw(U.owner, `select public.msgr_crew_routines_sync('${ORG}','${crew3}','[{"ext_id":"ro1","title":"t","prompt":"p","schedule":{"type":"daily"}}]'::jsonb)`), /42501|msgr_routine_forbidden/, 'detached 크루로는 재동기화도 거절');
});

test('M5 — 오프보딩(회사 멤버 제거)도 크루를 detached로 돌려 미러가 지워진다', { skip }, () => {
  asUser(U.member, `select public.msgr_crew_routines_sync('${ORG}','${OTHER_CREW}','[{"ext_id":"mo1","title":"t","prompt":"p","schedule":{"type":"daily"}}]'::jsonb)`);
  assert.equal(last(sql(`select count(*) from public.msgr_crew_routines where crew_id='${OTHER_CREW}'`)), '1', '오프보딩 전에는 행이 있어야 한다');
  sql(`update public.msgr_org_members set removed_at = now() where org_id='${ORG}' and user_id='${U.member}'`);
  assert.equal(last(sql(`select status from public.msgr_crews where id='${OTHER_CREW}'`)), 'detached');
  assert.equal(last(sql(`select count(*) from public.msgr_crew_routines where crew_id='${OTHER_CREW}'`)), '0');
});

test('retention — 30일 지난 applied/replaced/superseded/failed 편집은 정리 대상(직접 실행)', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync(${rowsSql})`);
  const rid = last(asUser(U.owner, `select id::text from public.msgr_crew_routines where crew_id='${CREW}' and ext_id='r1'`));
  const eid = last(asUser(U.owner, `select id::text from (select (public.msgr_crew_routine_edit('${rid}','update','{"title":"x"}'::jsonb))->>'id' as id) x`));
  sql(`update public.msgr_crew_routine_edits set status='applied', applied_at=now()-interval '31 days' where id='${eid}'`);
  sql(`delete from public.msgr_crew_routine_edits where status in ('applied','replaced','superseded','failed') and coalesce(applied_at,created_at) < now() - interval '30 days'`);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_crew_routine_edits where id='${eid}'`)), '0');
});
