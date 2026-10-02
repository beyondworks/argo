// 개인 방 파일 첨부(20261002100000) — 유건 2026-10-02 "개인 채팅에도 파일 첨부".
// 고정하는 것: 구성원은 올리고 읽는다 / 비구성원·나간 사람은 거절 / 1:1 차단이면 새 파일 못 올림(지난 파일은 읽음) /
// 그룹은 차단 관계가 있어도 계속 / 에이전트 글은 주인만 붙인다 / 첨부 행은 객체가 있고 25MB 이하일 때만 /
// 조직 경로 정책은 마이그레이션 전후 정의가 같다 / 개인 방이 지워지면 그 방 경로 객체도 지운다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-personal-attachments-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh로 실행';
const MINE = '20261002100000_msgr_personal_attachments.sql';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: 'aaaaaaaa-1111-4111-8111-111111111111', b: 'bbbbbbbb-2222-4222-8222-222222222222', c: 'cccccccc-3333-4333-8333-333333333333', d: 'dddddddd-4444-4444-8444-444444444444' };

const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const post = (uid, ch, body = 'x') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
// Storage가 업로드 때 하는 일(행 넣기 → 크기 채우기)을 흉내 낸다: 사용자 권한으로 행을 넣고(정책 판정), 크기는 서비스가 채운다.
const uploadRaw = (uid, path) => asUserRaw(uid, `insert into storage.objects (bucket_id, name, owner) values ('msgr', '${path}', '${uid}')`);
const upload = (uid, path, size = 1234) => { const r = uploadRaw(uid, path); assert.equal(r.status, 0, `업로드 거절: ${path} ${r.stderr}`); sql(`update storage.objects set metadata = jsonb_build_object('size', ${size}, 'mimetype', 'image/png') where name = '${path}'`); };
const canSee = (uid, path) => asUser(uid, `select count(*) from storage.objects where bucket_id = 'msgr' and name = '${path}'`) === '1';
const attachRaw = (uid, mid, path, org = 'null') => asUserRaw(uid, `insert into public.msgr_attachments (message_id, org_id, storage_path, name, mime, bytes) values (${mid}, ${org}, '${path}', 'a.png', 'image/png', 1234)`);
const ORG_POLICIES = `select string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), E'\\n' order by tablename, policyname)
  from pg_policies where (schemaname = 'storage' and tablename = 'objects' and policyname in ('msgr_files_select', 'msgr_files_insert', 'msgr_files_delete', 'msgr_dm_attachment_read', 'msgr_dm_output_insert'))
     or (schemaname = 'public' and tablename = 'msgr_attachments' and policyname in ('msgr_attachments_select', 'msgr_attachments_insert', 'msgr_dm_output_attachment'))`;

let ORG, PUB, AB, AC, G, CREW, CREW_ROOM, before_policies;
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
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz not null default now());
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
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  const all = [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort();
  for (const f of all.filter((f) => f !== MINE)) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  before_policies = sql(ORG_POLICIES); // 조직 경로 정책 — 이 마이그레이션 전
  psql(['-c', readFileSync(mig(MINE), 'utf8')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
  asUser(U.d, `select public.msgr_accept_invite('${code}')`);
  PUB = last(asUser(U.a, `select msgr_create_channel('${ORG}','public','ops','[]')`));
  befriend(U.a, U.b); befriend(U.a, U.c); befriend(U.b, U.c);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
  AC = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  G = last(asUser(U.a, `select public.msgr_dm_personal_group(array['${U.b}','${U.c}']::uuid[], 'abc')`));
  CREW = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${U.a}', 'ws-aaaa', 'a1', 'A1', 'local', 'active', 'owner') returning id`));
  CREW_ROOM = last(asUser(U.a, `select public.msgr_dm_personal_crew('${CREW}')`));
});

test('스키마: org_id는 개인 첨부만 NULL — 경로 모양과 어긋나면 CHECK가 막는다', { skip }, () => {
  assert.equal(sql(`select is_nullable from information_schema.columns where table_name = 'msgr_attachments' and column_name = 'org_id'`), 'YES');
  assert.equal(sql(`select convalidated from pg_constraint where conname = 'msgr_attachments_space_path'`), 't', '기존 행까지 검사한 제약');
  const m = post(U.a, AB);
  fails(psqlRaw(['-c', `insert into public.msgr_attachments (message_id, org_id, storage_path, name, bytes) values (${m}, null, '${ORG}/${PUB}/${m}/x', 'x', 1)`]), /msgr_attachments_space_path/, 'NULL인데 조직 경로');
  fails(psqlRaw(['-c', `insert into public.msgr_attachments (message_id, org_id, storage_path, name, bytes) values (${m}, '${ORG}', 'p/${AB}/${m}/x', 'x', 1)`]), /msgr_attachments_space_path/, '조직인데 개인 경로');
});

test('조직 경로 정책은 마이그레이션 전후 정의가 같고, 조직 업로드·읽기는 그대로', { skip }, () => {
  assert.equal(sql(ORG_POLICIES), before_policies);
  const m = post(U.a, PUB, 'org');
  const p = `${ORG}/${PUB}/${m}/0-org.png`;
  upload(U.a, p);
  assert.ok(canSee(U.d, p), '조직 멤버는 공개 채널 파일을 읽는다');
  assert.ok(!canSee(U.b, p), '조직 밖 사람은 못 읽는다');
  fails(uploadRaw(U.b, `${ORG}/${PUB}/${m}/1-x.png`), /row-level security/, '조직 밖 사람은 조직 경로에 못 올린다');
  assert.equal(attachRaw(U.a, m, p, `'${ORG}'`).status, 0, '조직 첨부 행');
  fails(uploadRaw(U.a, `p/${PUB}/${m}/0-x.png`), /row-level security/, '조직 채널을 개인 경로로 올리지 못한다');
});

test('1:1 — 구성원은 올리고 읽고 첨부 행을 넣는다, 비구성원은 못 한다', { skip }, () => {
  const m = post(U.a, AB, '사진');
  const p = `p/${AB}/${m}/abc-0-photo.png`;
  upload(U.a, p);
  assert.ok(canSee(U.a, p) && canSee(U.b, p), '두 사람 모두 읽는다');
  assert.ok(!canSee(U.c, p) && !canSee(U.d, p), '방 밖 사람은 못 읽는다');
  assert.equal(attachRaw(U.a, m, p).status, 0, '개인 첨부 행(org_id NULL)');
  assert.equal(asUser(U.b, `select count(*) from public.msgr_attachments where message_id = ${m}`), '1', '상대도 첨부 행을 본다');
  assert.equal(asUser(U.c, `select count(*) from public.msgr_attachments where message_id = ${m}`), '0');
  fails(uploadRaw(U.c, `p/${AB}/${m}/x-0-c.png`), /row-level security/, '비구성원 업로드');
  fails(attachRaw(U.c, m, p), /row-level security/, '비구성원 첨부 행');
  assert.equal(sql(`select count(*) from realtime.sent where event = 'attach' and topic = 'dm:${AB}' and (payload->>'message_id')::bigint = ${m}`), '1', '첨부 방송(늦게 붙은 첨부를 화면이 다시 읽는다)');
});

test('경로·글 검사 — 남의 글·다른 방 글·지운 글·이상한 경로는 거절', { skip }, () => {
  const mine = post(U.a, AB); const theirs = post(U.b, AB); const other = post(U.a, AC);
  fails(uploadRaw(U.a, `p/${AB}/${theirs}/x-0-a.png`), /row-level security/, '남의 글 폴더');
  fails(uploadRaw(U.a, `p/${AB}/${other}/x-0-a.png`), /row-level security/, '다른 방 글 번호');
  for (const bad of [`p/${AB}/${mine}/..`, `p/${AB}/${mine}/a/b.png`, `p/${AB}/${mine}/한글.png`, `p/${AB}/${mine}/`, `p/${AB}/abc/x.png`, `p/not-uuid/${mine}/x.png`, `q/${AB}/${mine}/x.png`])
    fails(uploadRaw(U.a, bad), /row-level security/, `경로: ${bad}`);
  sql(`update public.msgr_messages set deleted_at = now() where id = ${mine}`);
  fails(uploadRaw(U.a, `p/${AB}/${mine}/x-0-a.png`), /row-level security/, '지운 글');
});

test('첨부 행 — 객체가 없거나 25MB를 넘거나 글 번호가 경로와 다르면 거절', { skip }, () => {
  const m = post(U.a, AB); const m2 = post(U.a, AB);
  fails(attachRaw(U.a, m, `p/${AB}/${m}/none-0-x.png`), /row-level security/, '올리지 않은 객체');
  const big = `p/${AB}/${m}/big-0-x.bin`;
  upload(U.a, big, 26214401);
  fails(attachRaw(U.a, m, big), /row-level security/, '25MB 초과');
  const ok = `p/${AB}/${m}/ok-0-x.png`;
  upload(U.a, ok, 26214400);
  fails(attachRaw(U.a, m2, ok), /row-level security/, '글 번호가 경로와 다름');
  assert.equal(attachRaw(U.a, m, ok).status, 0, '25MB 정확히는 된다');
});

test('그룹 — 나간 사람은 지난 파일도 새 파일도 못 읽고 못 올린다, 남은 사람은 그대로', { skip }, () => {
  const m1 = post(U.c, G, 'c의 파일');
  const p1 = `p/${G}/${m1}/c-0-c.png`;
  upload(U.c, p1);
  assert.ok(canSee(U.a, p1) && canSee(U.b, p1));
  assert.equal(last(asUser(U.c, `select public.msgr_leave_dm('${G}')`)), 't');
  const m2 = post(U.a, G, '나간 뒤');
  const p2 = `p/${G}/${m2}/a-0-a.png`;
  upload(U.a, p2);
  assert.ok(!canSee(U.c, p1), '나간 사람은 지난 파일을 못 읽는다');
  assert.ok(!canSee(U.c, p2), '나간 사람은 새 파일을 못 읽는다');
  assert.ok(canSee(U.b, p1) && canSee(U.b, p2), '남은 사람은 둘 다 읽는다');
  fails(uploadRaw(U.c, `p/${G}/${m1}/c-1-c.png`), /row-level security/, '나간 사람은 자기 지난 글에도 못 붙인다');
  // 다시 들어오면(관리 경로로 구성원 행 복원) 다시 읽는다 — 권한은 지금 구성원 여부로만 정해진다
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${G}', 'user', '${U.c}')`);
  assert.ok(canSee(U.c, p2));
});

test('차단 — 1:1은 둘 다 새 파일 못 올리고 지난 파일은 읽는다, 그룹은 계속', { skip }, () => {
  const before1 = post(U.a, AC, '차단 전');
  const p0 = `p/${AC}/${before1}/a-0-a.png`;
  upload(U.a, p0);
  const g1 = post(U.c, G, '그룹');
  asUser(U.a, `select public.msgr_friend_remove('${U.c}', true)`); // a가 c를 차단
  assert.ok(canSee(U.a, p0) && canSee(U.c, p0), '지난 파일은 둘 다 읽는다(지난 글과 같다)');
  fails(uploadRaw(U.a, `p/${AC}/${before1}/a-1-a.png`), /row-level security/, '차단한 사람도 1:1에 새 파일 못 올림');
  const pg = `p/${G}/${g1}/c-0-c.png`;
  upload(U.c, pg); // 그룹은 막히지 않는다 — 화면이 차단한 사람 글(첨부 포함)을 가린다
  assert.ok(canSee(U.a, pg), '서버는 그룹 파일을 막지 않는다(가리기는 화면 몫)');
  sql(`update public.msgr_friends set status = 'accepted' where status = 'blocked'`);
});

test('에이전트 글 — 주인 기기(게이트웨이)만 붙이고, 친구는 읽기만', { skip }, () => {
  const cm = last(asUser(U.a, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${CREW_ROOM}', 'crew', '${CREW}', 'text', '보고서', gen_random_uuid()::text) returning id`));
  const p = `p/${CREW_ROOM}/${cm}/0-report.pdf`;
  upload(U.a, p);
  assert.equal(attachRaw(U.a, cm, p).status, 0, '주인이 자기 에이전트 글에 첨부');
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join('${AB}', '${CREW}')`)), 'joined');
  const cm2 = last(asUser(U.a, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${AB}', 'crew', '${CREW}', 'text', '친구 방에 보고', gen_random_uuid()::text) returning id`));
  const p2 = `p/${AB}/${cm2}/0-chart.png`;
  fails(uploadRaw(U.b, p2), /row-level security/, '친구는 남의 에이전트 글에 못 붙인다');
  upload(U.a, p2);
  assert.ok(canSee(U.b, p2), '친구는 읽는다');
  sql(`update public.msgr_crews set status = 'detached' where id = '${CREW}'`);
  fails(uploadRaw(U.a, `p/${AB}/${cm2}/1-chart.png`), /row-level security/, '떼어 낸(활성 아님) 에이전트 글에는 못 붙인다');
  sql(`update public.msgr_crews set status = 'active' where id = '${CREW}'`);
});

test('개인 방이 지워지면 그 방 경로 객체도 지운다(조직 객체는 그대로)', { skip }, () => {
  const solo = last(asUser(U.d, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${U.d}', 'ws-dddd', 'd1', 'D1', 'local', 'active', 'owner') returning id`));
  const room = last(asUser(U.d, `select public.msgr_dm_personal_crew('${solo}')`));
  const m = post(U.d, room);
  upload(U.d, `p/${room}/${m}/0-x.png`);
  const orgCount = sql(`select count(*) from storage.objects where name like '${ORG}/%'`);
  sql(`delete from public.msgr_channels where id = '${room}'`);
  assert.equal(sql(`select count(*) from storage.objects where name like 'p/${room}/%'`), '0');
  assert.equal(sql(`select count(*) from storage.objects where name like '${ORG}/%'`), orgCount);
});
