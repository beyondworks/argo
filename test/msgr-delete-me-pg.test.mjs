// 앱 내 계정 삭제(msgr_delete_me) — 일회용 PostgreSQL에서 배포될 마이그레이션 그대로 적용해 검증.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-delete-me-pg.test.mjs  (또는 ARGO_PG_TEST_URL 지정)
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-delete-me-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', solo: '55555555-5555-4555-8555-555555555555', svc: '77777777-7777-4777-8777-777777777777' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, SOLO_ORG, CREW, PUB;
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
    alter table storage.objects enable row level security;
    create or replace function storage.protect_delete() returns trigger language plpgsql as $$ begin if coalesce(current_setting('storage.allow_delete_query', true), 'false') <> 'true' then raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.' using errcode = '42501'; end if; return null; end $$; -- 실제 storage-api 가드 복제(로컬 스택 E2E에서 적발)
    drop trigger if exists protect_objects_delete on storage.objects; create trigger protect_objects_delete before delete on storage.objects for each statement execute function storage.protect_delete();
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
  `]);
  sql(`create schema net; create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  SOLO_ORG = last(asUser(U.solo, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Solo', 'solo', '${U.solo}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id in ('${ORG}', '${SOLO_ORG}')`);
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'admin', '${U.owner}') returning code`));
  assert.equal(last(asUser(U.admin, `select public.msgr_accept_invite('${code}')`)), ORG);
  CREW = last(asUser(U.admin, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.admin}', 'lean', 'mine', 'Mine') returning id`));
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Work')`));
  sql(`update public.msgr_crews set status='active', last_seen_at=now() where id='${CREW}'`);
});

test('익명은 거부, 다른 멤버가 있는 조직의 소유자는 이전이 먼저(조직명을 알려 준다)', { skip }, () => {
  const anon = psqlRaw(['-A', '-t', '-c', `set role authenticated; select public.msgr_delete_me()`]);
  assert.notEqual(anon.status, 0); assert.match(anon.stderr, /msgr_unauthenticated/);
  const r = asUserRaw(U.owner, `select public.msgr_delete_me()`);
  assert.notEqual(r.status, 0, '소유자 삭제가 허용됨'); assert.match(r.stderr, /msgr_owner_transfer_required: Lean/);
  assert.equal(sql(`select count(*) from auth.users where id='${U.owner}'`), '1', '거부 시 아무것도 지우지 않는다');
  assert.equal(sql(`select deleted_at is null from public.msgr_orgs where id='${ORG}'`), 't');
});

test('멤버(관리자) 삭제 — 흔적 정리·크루 분리·멤버십 종료·auth 사용자 삭제, 메시지 본문은 남는다', { skip }, () => {
  const mid = last(asUser(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${PUB}', 'user', '${U.admin}', 'text', '남는 글', 'keep-1') returning id`));
  asUser(U.admin, `insert into public.msgr_reads (channel_id, user_id, last_read_id) values ('${PUB}', '${U.admin}', ${mid})`);
  asUser(U.admin, `insert into public.msgr_reactions (message_id, user_id, emoji) values (${mid}, '${U.admin}', '👍')`);
  sql(`insert into public.msgr_push_tokens (token, user_id, platform, device) values ('tok-admin', '${U.admin}', 'ios', 'phone')`); // 푸시 토큰은 RPC로만 쓰는 표 — 시드는 슈퍼유저
  asUser(U.admin, `insert into public.msgr_profiles (user_id, handle, display_name) values ('${U.admin}', 'adminh', 'Admin')`);
  sql(`insert into public.msgr_friends (a, b, status, requested_by) values (least('${U.admin}'::uuid,'${U.owner}'::uuid), greatest('${U.admin}'::uuid,'${U.owner}'::uuid), 'accepted', '${U.admin}')`); // 친구 표도 RPC 전용 — 시드는 슈퍼유저
  const mine = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}','public','AdminMade')`));
  const out = last(asUser(U.admin, `select public.msgr_delete_me()`));
  assert.deepEqual(JSON.parse(out), { deleted_orgs: 0 });
  assert.equal(sql(`select count(*) from auth.users where id='${U.admin}'`), '0', 'auth 사용자 삭제');
  assert.equal(sql(`select count(*) from public.msgr_org_members where org_id='${ORG}' and user_id='${U.admin}'`), '0', '멤버십은 auth.users cascade로 사라진다(removed_at 표시는 그 전 단계)');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind='user' and member_id='${U.admin}'`), '0');
  for (const t of ['msgr_push_tokens', 'msgr_reads', 'msgr_reactions', 'msgr_profiles']) assert.equal(sql(`select count(*) from public.${t} where user_id='${U.admin}'`), '0', t);
  assert.equal(sql(`select count(*) from public.msgr_friends where a='${U.admin}' or b='${U.admin}'`), '0', '친구 관계');
  assert.equal(sql(`select created_by from public.msgr_channels where id='${mine}'`), U.owner, '내가 만든 채널은 조직 소유자에게 넘어간다');
  assert.equal(sql(`select count(*) from public.msgr_crews where id='${CREW}'`), '0', '내 크루(개인 에이전트)는 계정과 함께 삭제');
  assert.equal(sql(`select body||'|'||coalesce(author_user_id::text,'(null)') from public.msgr_messages where id=${mid}`), '남는 글|(null)', '공유 공간의 글은 남고 작성자 참조만 비워진다(FK set null)');
});

test('혼자인 소유 조직은 하드 삭제(자식 cascade)와 함께 계정 삭제', { skip }, () => {
  const ch = last(asUser(U.solo, `select public.msgr_create_channel('${SOLO_ORG}','public','Mine')`));
  assert.deepEqual(JSON.parse(last(asUser(U.solo, `select public.msgr_delete_me()`))), { deleted_orgs: 1 });
  assert.equal(sql(`select count(*) from public.msgr_orgs where id='${SOLO_ORG}'`), '0');
  assert.equal(sql(`select count(*) from public.msgr_channels where id='${ch}'`), '0', '조직 자식(채널)도 사라진다');
  assert.equal(sql(`select count(*) from auth.users where id='${U.solo}'`), '0');
});

test('서비스 계정만 남은 조직도 "혼자"로 본다 — 소유자 삭제 허용', { skip }, () => {
  const other = '66666666-6666-4666-8666-666666666666';
  sql(`insert into auth.users (id, email) values ('${other}', 'svcowner@example.test'), ('${U.svc}', 'svc@example.test') on conflict do nothing`);
  const org = last(asUser(other, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('SvcOnly', 'svconly', '${other}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${U.svc}', 'member', 'svc') on conflict do nothing; update public.msgr_orgs set service_user_id='${U.svc}' where id='${org}'`);
  assert.deepEqual(JSON.parse(last(asUser(other, `select public.msgr_delete_me()`))), { deleted_orgs: 1 });
});

const NEW = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
const mkUser = (id, tag) => sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${tag}@example.test') on conflict do nothing`);

test('2R C-1: 조직 문서를 만들거나 고친 사용자도 삭제된다(작성자·수정자는 조직 소유자에게, 버전·수정 시각 불변)', { skip }, () => {
  const ed = NEW('a'); mkUser(ed, 'editor');
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
  assert.equal(last(asUser(ed, `select public.msgr_accept_invite('${code}')`)), ORG);
  const doc = last(sql(`insert into public.msgr_org_docs (org_id, path, title, body, created_by, updated_by) values ('${ORG}', 'rules/x.md', 'X', 'v1', '${ed}', '${ed}') returning id`));
  const before = sql(`select version||'|'||updated_at from public.msgr_org_docs where id='${doc}'`);
  assert.deepEqual(JSON.parse(last(asUser(ed, `select public.msgr_delete_me()`))), { deleted_orgs: 0 });
  assert.equal(sql(`select count(*) from auth.users where id='${ed}'`), '0');
  assert.equal(sql(`select created_by||'|'||updated_by||'|'||version||'|'||updated_at from public.msgr_org_docs where id='${doc}'`), `${U.owner}|${U.owner}|${before}`, '이관되고 버전·시각은 그대로');
});

test('2R C-2: 회사 노드 서비스 계정도 자기 계정을 지울 수 있다(service_user_id 해제)', { skip }, () => {
  const own = NEW('b'), svc = NEW('c'); mkUser(own, 'svcowner'); mkUser(svc, 'svcacct');
  const org = last(asUser(own, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('SvcOrg', 'svcorg', '${own}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name) values ('${org}', '${svc}', 'member', 'svc') on conflict do nothing; update public.msgr_orgs set service_user_id='${svc}' where id='${org}'`);
  assert.deepEqual(JSON.parse(last(asUser(svc, `select public.msgr_delete_me()`))), { deleted_orgs: 0 });
  assert.equal(sql(`select coalesce(service_user_id::text,'(null)') from public.msgr_orgs where id='${org}'`), '(null)');
  assert.equal(sql(`select count(*) from auth.users where id='${svc}'`), '0');
});

test('2R C-3: 조직의 지정 후계자(관리자)도 삭제된다(successor 해제)', { skip }, () => {
  const own = NEW('d'), heir = NEW('e'); mkUser(own, 'heirowner'); mkUser(heir, 'heir');
  const org = last(asUser(own, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('HeirOrg', 'heirorg', '${own}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${org}'`);
  const code = last(asUser(own, `insert into public.msgr_invites (org_id, role, created_by) values ('${org}', 'admin', '${own}') returning code`));
  assert.equal(last(asUser(heir, `select public.msgr_accept_invite('${code}')`)), org);
  asUser(own, `update public.msgr_orgs set successor_user_id='${heir}' where id='${org}'`);
  assert.equal(sql(`select successor_user_id from public.msgr_orgs where id='${org}'`), heir);
  assert.deepEqual(JSON.parse(last(asUser(heir, `select public.msgr_delete_me()`))), { deleted_orgs: 0 });
  assert.equal(sql(`select coalesce(successor_user_id::text,'(null)') from public.msgr_orgs where id='${org}'`), '(null)');
});

test('2R H-1: 보관(소프트 삭제) 조직에 다른 멤버가 있으면 차단, 혼자면 첨부 파일과 함께 하드 삭제', { skip }, () => {
  const own = NEW('f'), mem = NEW('9'); mkUser(own, 'archowner'); mkUser(mem, 'archmember');
  const org = last(asUser(own, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('ArchOrg', 'archorg', '${own}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${org}'`);
  const code = last(asUser(own, `insert into public.msgr_invites (org_id, role, created_by) values ('${org}', 'member', '${own}') returning code`));
  assert.equal(last(asUser(mem, `select public.msgr_accept_invite('${code}')`)), org);
  asUser(own, `update public.msgr_orgs set deleted_at = now() where id='${org}'`);
  const r = asUserRaw(own, `select public.msgr_delete_me()`);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /msgr_owner_transfer_required: ArchOrg/, '보관 조직도 남의 기록 — 이전이 먼저');
  assert.equal(sql(`select count(*) from public.msgr_orgs where id='${org}'`), '1', '아무것도 지우지 않는다');
  // 혼자인 보관 조직 + 첨부 파일
  const solo = NEW('0'); mkUser(solo, 'archsolo');
  const org2 = last(asUser(solo, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('ArchSolo', 'archsolo', '${solo}') returning id`));
  asUser(solo, `update public.msgr_orgs set deleted_at = now() where id='${org2}'`);
  sql(`insert into storage.objects (bucket_id, name) values ('msgr', '${org2}/some-channel/1/file.txt'), ('msgr-avatars', 'avatars/${solo}/me.png'), ('msgr-avatars', 'avatars/${own}/other.png')`);
  assert.deepEqual(JSON.parse(last(asUser(solo, `select public.msgr_delete_me()`))), { deleted_orgs: 1 });
  assert.equal(sql(`select count(*) from public.msgr_orgs where id='${org2}'`), '0');
  assert.equal(sql(`select count(*) from storage.objects where bucket_id='msgr' and name like '${org2}/%'`), '0', '조직 첨부 파일 정리');
  assert.equal(sql(`select count(*) from storage.objects where name='avatars/${solo}/me.png'`), '0', '내 아바타 정리');
  assert.equal(sql(`select count(*) from storage.objects where name='avatars/${own}/other.png'`), '1', '남의 아바타는 그대로');
});

test('2R M-1: 만료된 게스트만 남은 조직의 소유자는 삭제된다(만료 게스트는 활성 멤버가 아니다)', { skip }, () => {
  const own = NEW('6'), guest = NEW('3'); mkUser(own, 'gowner'); mkUser(guest, 'guest');
  const org = last(asUser(own, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('GuestOrg', 'guestorg', '${own}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role, display_name, expires_at) values ('${org}', '${guest}', 'guest', 'g', now() - interval '1 day') on conflict do nothing`);
  assert.deepEqual(JSON.parse(last(asUser(own, `select public.msgr_delete_me()`))), { deleted_orgs: 1 });
});

test('2R H-2: 가드 통과 플래그는 함수 끝과 예외 경로 모두에서 되돌린다(자기 역할 상승 방어선 유지)', { skip }, () => {
  const src = sql(`select prosrc from pg_proc where proname='msgr_delete_me'`);
  assert.equal((src.match(/set_config\('argo\.msgr_account_delete', '', true\)/g) ?? []).length, 2, '정상·예외 두 경로');
  assert.equal((src.match(/set_config\('storage\.allow_delete_query', '', true\)/g) ?? []).length, 2, 'storage GUC도 두 경로에서 복원(3R L2R-1)');
  assert.match(src, /exception when others then/);
  // 플래그 없이 본인 역할 상승은 여전히 막힌다
  const own = NEW('4'), mem = NEW('8'); mkUser(own, 'rowner'); mkUser(mem, 'rmember');
  const org = last(asUser(own, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('RoleOrg', 'roleorg', '${own}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${org}'`);
  const code = last(asUser(own, `insert into public.msgr_invites (org_id, role, created_by) values ('${org}', 'member', '${own}') returning code`));
  assert.equal(last(asUser(mem, `select public.msgr_accept_invite('${code}')`)), org);
  const r = asUserRaw(mem, `update public.msgr_org_members set role='owner' where org_id='${org}' and user_id='${mem}'`);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /msgr_member_self_only_name/);
});

test('3R H2R-1: 세션에 플래그를 켜도 관리자는 소유권·서비스 계정을 못 가져가고 남의 조직을 못 보관하며, 멤버는 역할을 못 올린다(트리거는 FK 캐스케이드만 통과)', { skip }, () => {
  const own = NEW('a').replace(/a/g, 'c').replace(/4c/, '4c'), adm = '21212121-2121-4212-8212-212121212121', mem = '31313131-3131-4313-8313-313131313131';
  const owner = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'; mkUser(owner, 'atkowner'); mkUser(adm, 'atkadmin'); mkUser(mem, 'atkmember');
  const org = last(asUser(owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('AtkOrg', 'atkorg', '${owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${org}'`);
  for (const [u, role] of [[adm, 'admin'], [mem, 'member']]) { const code = last(asUser(owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${org}', '${role}', '${owner}') returning code`)); assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), org); }
  const flagged = (u, q) => asUserRaw(u, `select set_config('argo.msgr_account_delete', '1', false); ${q}`);
  let r = flagged(adm, `update public.msgr_orgs set owner_user_id = '${adm}' where id = '${org}'`); assert.notEqual(r.status, 0, 'E-2 소유권 탈취'); assert.match(r.stderr, /msgr_owner_only/);
  r = flagged(adm, `update public.msgr_orgs set service_user_id = '${adm}' where id = '${org}'`); assert.notEqual(r.status, 0, 'E-3 서비스 계정 자기 지정(H-6)');
  r = flagged(adm, `update public.msgr_orgs set deleted_at = now() where id = '${org}'`); assert.notEqual(r.status, 0, 'E-4 남의 조직 보관'); assert.match(r.stderr, /msgr_owner_only/);
  r = flagged(mem, `update public.msgr_org_members set role = 'owner' where org_id = '${org}' and user_id = '${mem}'`); assert.notEqual(r.status, 0, 'E-1 역할 상승'); assert.match(r.stderr, /msgr_member_self_only_name/);
  assert.equal(sql(`select owner_user_id||'|'||coalesce(service_user_id::text,'-')||'|'||coalesce(deleted_at::text,'-') from public.msgr_orgs where id='${org}'`), `${owner}|-|-`, '아무것도 바뀌지 않았다');
  // 캐스케이드 경로는 여전히 통한다: 서비스 계정·후계자 삭제 → null + 감사 기록
  sql(`update public.msgr_orgs set service_user_id = '${adm}' where id = '${org}'`);
  const before = sql(`select count(*) from public.msgr_audit_log where org_id = '${org}' and action = 'org.service_account'`);
  assert.deepEqual(JSON.parse(last(asUser(adm, `select public.msgr_delete_me()`))), { deleted_orgs: 0 });
  assert.equal(sql(`select coalesce(service_user_id::text,'(null)') from public.msgr_orgs where id='${org}'`), '(null)');
  assert.ok(Number(sql(`select count(*) from public.msgr_audit_log where org_id = '${org}' and action = 'org.service_account'`)) > Number(before), '해제가 감사에 남는다(3R M2R-5)');
});

test('3R M2R-3: 30일 유예가 끝난 보관 조직에 멤버가 남아 있어도 소유자는 삭제된다(그 조직은 하드 삭제 — purge 대상과 같다)', { skip }, () => {
  const own = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1', mem = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2'; mkUser(own, 'staleowner'); mkUser(mem, 'stalemember');
  const org = last(asUser(own, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Stale', 'stale', '${own}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${org}'`);
  const code = last(asUser(own, `insert into public.msgr_invites (org_id, role, created_by) values ('${org}', 'member', '${own}') returning code`));
  assert.equal(last(asUser(mem, `select public.msgr_accept_invite('${code}')`)), org);
  sql(`update public.msgr_orgs set deleted_at = now() - interval '31 days' where id = '${org}'`);
  assert.deepEqual(JSON.parse(last(asUser(own, `select public.msgr_delete_me()`))), { deleted_orgs: 1 });
  assert.equal(sql(`select count(*) from public.msgr_orgs where id='${org}'`), '0');
});

test('3R M2R-2: 30일 지난 보관 조직 purge가 첨부 파일 행과 함께 성공한다(storage 직접 삭제 가드 통과)', { skip }, () => {
  const own = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'; mkUser(own, 'purgeowner');
  const org = last(asUser(own, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('PurgeMe', 'purgeme', '${own}') returning id`));
  sql(`update public.msgr_orgs set deleted_at = now() - interval '31 days' where id = '${org}'`);
  sql(`insert into storage.objects (bucket_id, name) values ('msgr', '${org}/chan/1/doc.pdf')`);
  assert.equal(sql(`select public.msgr_purge_orgs()`), '1', '서비스 문맥(auth.uid() null)에서 1건');
  assert.equal(sql(`select count(*) from public.msgr_orgs where id='${org}'`), '0');
  assert.equal(sql(`select count(*) from storage.objects where name like '${org}/%'`), '0', '첨부 행 정리 — 가드가 있으면 이전 정의는 42501로 실패했다');
});
