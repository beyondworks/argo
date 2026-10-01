// 아르고 오피스 '크루에게 맡기기'(유건 2026-09-29) — 오피스 웹이 로그인 사용자 권한으로 부르는 DB 계약을 실제 마이그레이션으로 잠근다.
// 클라이언트(apps/office/src/core/transport.js crew.assign)가 부르는 그대로: 사전 확인 RPC 4개 → 내 크루와의 1:1 방(msgr_create_channel)
// → msgr_messages insert(meta.source = office_*). 게이트웨이는 이 meta.source를 보고 풀 오토를 끈다(src/gateway/msgr-handoff.mjs).
// 준비(역할·스키마·전체 msgr 마이그레이션)는 msgr-trial-pg.test.mjs와 같다. 실행: bash scripts/billing-pg-drill.sh test/office-crew-assign-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/office-crew-assign-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { me: '11111111-1111-4111-8111-111111111111', other: '22222222-2222-4222-8222-222222222222', late: '33333333-3333-4333-8333-333333333333' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (r, re) => { assert.notEqual(r.status, 0, '허용되면 안 된다'); if (re) assert.match(r.stderr, re); };

let ORG, MINE, THEIRS, EXPIRED, EXPIRED_CREW;
before(() => {
  if (!DB) return;
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
  ORG = last(asUser(U.me, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Office', 'office-assign', '${U.me}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${ORG}', '${U.other}', 'member', 'other') on conflict do nothing`);
  MINE = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.me}', 'ws-me', 'pepper', '페퍼') returning id`));
  THEIRS = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.other}', 'ws-other', 'otto', '오토') returning id`));
  EXPIRED = last(asUser(U.late, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Expired', 'office-expired', '${U.late}') returning id`));
  sql(`update public.msgr_org_entitlements set trial_ends_at = now() - interval '1 day' where org_id = '${EXPIRED}'`);
  EXPIRED_CREW = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${EXPIRED}', '${U.late}', 'ws-late', 'mia', '미아') returning id`));
});

test('사전 확인 RPC 4개를 로그인 사용자가 부를 수 있고, 활성 조직·내 크루·동의한 사용자면 모두 통과', { skip }, () => {
  asUser(U.me, `select public.msgr_set_ai_consent(true)`);
  assert.equal(last(asUser(U.me, `select public.msgr_org_locked('${ORG}')`)), 'f');
  assert.equal(last(asUser(U.me, `select public.msgr_org_entitled('${ORG}')`)), 't', '새 조직은 무료 기간');
  assert.equal(last(asUser(U.me, `select public.msgr_instruct_check('${MINE}', '${U.me}', null)`)), 'ok', '내 크루');
  assert.notEqual(last(asUser(U.me, `select coalesce(public.msgr_my_ai_consent()::text, '')`)), '', '동의 시각');
});

test('내 크루와의 1:1 방을 만들고, 오피스 출처 meta를 그대로 담은 글이 들어간다 — 같은 client_msg_id 재전송은 23505', { skip }, () => {
  const ch = last(asUser(U.me, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:페퍼', '[{"kind":"crew","id":"${MINE}"}]'::jsonb)`));
  assert.match(ch, /^[0-9a-f-]{36}$/);
  const members = asUser(U.me, `select member_kind || ':' || member_id from public.msgr_channel_members where channel_id = '${ch}' order by 1`).split('\n');
  assert.deepEqual(members, [`crew:${MINE}`, `user:${U.me}`], '나 + 내 크루 하나(오피스가 기존 방을 찾는 조건)');
  const cid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const meta = JSON.stringify({ source: 'office_mail', office_ref: { kind: 'mail', id: 'g-1' } });
  const insert = `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, meta, client_msg_id) values ('${ch}', 'user', '${U.me}', '요약해 주세요', '${meta}'::jsonb, '${cid}')`;
  asUser(U.me, insert);
  const saved = JSON.parse(last(asUser(U.me, `select meta from public.msgr_messages where channel_id = '${ch}' and client_msg_id = '${cid}'`)));
  assert.equal(saved.source, 'office_mail', 'meta.source가 저장된다(게이트웨이가 풀 오토를 끄는 표지)');
  assert.deepEqual(saved.office_ref, { kind: 'mail', id: 'g-1' });
  fails(asUserRaw(U.me, insert), /duplicate key|23505/);
  // 표지를 위조해 넣어도 권한이 오르지 않는다 — 게이트웨이는 이 값으로 풀 오토를 끄기만 한다(내리는 방향)
});

test('남의 크루와는 1:1 방을 만들 수 없다(P0001) — 오피스는 이것을 권한 없음으로 알리고 재시도하지 않는다', { skip }, () => {
  fails(asUserRaw(U.me, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:오토', '[{"kind":"crew","id":"${THEIRS}"}]'::jsonb)`), /msgr_bad_member|msgr_forbidden/);
  assert.notEqual(last(asUser(U.me, `select public.msgr_instruct_check('${THEIRS}', '${U.me}', null)`)), '', '판정 값은 돌려준다');
});

// 2026-10-01 유건 승인(9/30 요금 개편 — 무료는 조직·개인 구분 없음): 무료 기간이 지난 무료 조직도 크루에게 일을 맡길 수 있다(20261001100000).
test('무료 기간이 지난 무료 조직도 msgr_org_entitled = true — 오피스는 그대로 보낸다', { skip }, () => {
  assert.equal(last(asUser(U.late, `select public.msgr_org_entitled('${EXPIRED}')`)), 't');
  assert.equal(last(asUser(U.late, `select public.msgr_instruct_check('${EXPIRED_CREW}', '${U.late}', null)`)), 'ok');
});

test('동의를 거두면 msgr_my_ai_consent가 비어 오피스는 보내기 전에 거절한다', { skip }, () => {
  asUser(U.other, `select public.msgr_set_ai_consent(true)`);
  asUser(U.other, `select public.msgr_set_ai_consent(false)`);
  assert.equal(last(asUser(U.other, `select coalesce(public.msgr_my_ai_consent()::text, '(null)')`)), '(null)');
});

// ── 좌측 크루 목록(유건 9/30): 주인 이름·쓸 수 있는지(메신저와 같은 판정)·내 고정/순서(메신저 레일과 같은 행)
const crewList = (uid, orgs) => JSON.parse(last(asUser(uid, `select public.office_crew_list(array[${orgs.map((o) => `'${o}'`).join(',')}]::uuid[])`)));
const listed = (uid, orgs = [ORG]) => Object.fromEntries(crewList(uid, orgs).map((c) => [c.display_name, c]));
test('크루 목록: 주인 이름과 쓸 수 있는지 — 주인이 "주인만"으로 바꾸면 남에게는 crew_allow, 꺼진 크루는 inactive', { skip }, () => {
  psql(['-f', mig('20260930120000_office_crew_list.sql')]);
  let l = listed(U.me);
  assert.equal(l['오토'].owner_name, 'other'); assert.equal(l['오토'].access, 'ok'); assert.equal(l['페퍼'].access, 'ok'); assert.equal(l['오토'].company, false);
  sql(`update public.msgr_crews set allow = 'owner' where id = '${THEIRS}'`);
  l = listed(U.me);
  assert.equal(l['오토'].access, 'crew_allow');
  assert.equal(listed(U.other)['오토'].access, 'ok'); // 주인은 그대로
  sql(`update public.msgr_crews set allow = 'all' where id = '${THEIRS}'`);
  sql(`update public.msgr_crews set status = 'available' where id = '${THEIRS}'`);
  assert.equal(listed(U.me)['오토'].access, 'inactive');
  sql(`update public.msgr_crews set status = 'active' where id = '${THEIRS}'`);
});
test('크루 목록: 고정·순서는 내 것만(메신저 msgr_target_prefs와 같은 행), 조직 밖 사람은 아무것도 못 본다', { skip }, () => {
  asUser(U.me, `insert into public.msgr_target_prefs (user_id, org_id, target_kind, target_id, pinned, pin_pos, sort_pos) values ('${U.me}', '${ORG}', 'crew', '${THEIRS}', true, 0, 3)`);
  const mine = listed(U.me)['오토'];
  assert.deepEqual([mine.pinned, mine.pin_pos, mine.sort_pos], [true, 0, 3]);
  const theirs = listed(U.other)['오토'];
  assert.deepEqual([theirs.pinned, theirs.pin_pos, theirs.sort_pos], [false, null, null]);
  assert.deepEqual(crewList(U.late, [ORG]), []);
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public.office_crew_list(array['${ORG}']::uuid[])`]), /permission denied/);
});

// ── 고정·순서 쓰기(분리 검수 MEDIUM-2): 바꾸려는 칸만 — 오피스의 오래된 화면이 메신저에서 켠 고정을 끄지 않는다
const prefs = (uid, action, ids, on = null) => asUser(uid, `select public.office_crew_prefs('${ORG}', '${action}', array[${ids.map((i) => `'${i}'`).join(',')}]::uuid[], ${on === null ? 'null' : on})`);
const prefRow = (uid, crew) => last(sql(`select coalesce(pinned::text,'-')||'|'||coalesce(pin_pos::text,'-')||'|'||coalesce(sort_pos::text,'-') from public.msgr_target_prefs where user_id='${uid}' and org_id='${ORG}' and target_kind='crew' and target_id='${crew}'`));
test('순서 쓰기는 sort_pos만 — 메신저에서 켠 고정은 그대로, 새 행은 고정 꺼짐(표 기본값 true 함정)', { skip }, () => {
  sql(`delete from public.msgr_target_prefs where user_id='${U.other}'`);
  asUser(U.other, `insert into public.msgr_target_prefs (user_id, org_id, target_kind, target_id, pinned, pin_pos) values ('${U.other}', '${ORG}', 'crew', '${THEIRS}', true, 4)`); // 메신저가 켠 고정
  prefs(U.other, 'sort', [MINE, THEIRS]);
  assert.equal(prefRow(U.other, THEIRS), 'true|4|1');
  assert.equal(prefRow(U.other, MINE), 'false|-|0');
});
test('고정 순서는 쓰던 번호 칸을 다시 나눈다, 고정이 다른 곳에서 바뀌었으면 stale — 고정 켜기는 채널 즐겨찾기까지 본 맨 뒤 번호', { skip }, () => {
  sql(`delete from public.msgr_target_prefs where user_id='${U.me}'`);
  prefs(U.me, 'pin', [MINE], true); prefs(U.me, 'pin', [THEIRS], true);
  assert.equal(prefRow(U.me, MINE), 'true|0|-'); assert.equal(prefRow(U.me, THEIRS), 'true|1|-');
  prefs(U.me, 'pin_order', [THEIRS, MINE]);
  assert.equal(prefRow(U.me, THEIRS), 'true|0|-'); assert.equal(prefRow(U.me, MINE), 'true|1|-');
  prefs(U.me, 'pin', [MINE], false);
  fails(asUserRaw(U.me, `select public.office_crew_prefs('${ORG}', 'pin_order', array['${MINE}','${THEIRS}']::uuid[])`), /crew_prefs_stale/);
  assert.equal(prefRow(U.me, MINE), 'false|-|-');
  fails(asUserRaw(U.other, `select public.office_crew_prefs('${ORG}', 'sort', array['${EXPIRED_CREW}']::uuid[])`)); // 다른 조직 크루는 RLS가 거절
});
