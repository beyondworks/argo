// 아르고 오피스 배치(20260926210000_office_layouts.sql) — 개인 보기는 본인만, 조직 구조는 멤버 읽기·관리자 쓰기,
// 같은 값을 다시 저장하면 행을 쓰지 않는다(DB 위생 규칙: 유휴·동일 값 쓰기 0 — xmin 불변으로 잠근다).
// 하네스는 msgr-crew-face-pg.test.mjs와 같다(auth.uid() 스텁 + set role). 실행: bash scripts/billing-pg-drill.sh test/office-layouts-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/office-layouts-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', member: '22222222-2222-4222-8222-222222222222', admin: '33333333-3333-4333-8333-333333333333', outsider: '44444444-4444-4444-8444-444444444444', gone: '55555555-5555-4555-8555-555555555555' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG;
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
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select null::void $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql',
    '20260903120000_msgr.sql', '20260926210000_office_layouts.sql']) psql(['-f', mig(f)]); // 배포될 그 파일을 그대로 적용
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'office-org', '${U.owner}') returning id`));
  sql(`insert into public.msgr_org_entitlements (org_id, plan, seats) values ('${ORG}', 'team', 10) on conflict (org_id) do update set plan = 'team', seats = 10`); // 무료 좌석(3) 밖 멤버를 넣기 위해
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.member}', 'member'), ('${ORG}', '${U.admin}', 'admin'), ('${ORG}', '${U.gone}', 'member')`);
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.gone}'`);
});

const saveMine = (uid, prefs, space = 'me', surface = 'home') => asUser(uid, `select public.office_layout_save('${space}', '${surface}', '${JSON.stringify(prefs)}'::jsonb)`);

// 이유: 사이드바 순서·패널 폭·내 홈 배치는 그 사람만의 것이다.
test('개인 배치: 본인만 읽고 쓴다', { skip }, () => {
  saveMine(U.member, { items: [{ id: 'mail', size: 'm' }] });
  assert.match(asUser(U.member, `select prefs::text from public.office_user_layouts where surface = 'home'`), /mail/);
  assert.equal(asUser(U.outsider, `select count(*) from public.office_user_layouts`), '0', '남의 배치는 보이지 않는다');
  assert.equal(last(asUserRaw(U.outsider, `update public.office_user_layouts set prefs = '{}' where user_id = '${U.member}' returning 1`).stdout), '', '남의 배치는 못 고친다');
  assert.notEqual(asUserRaw(U.outsider, `insert into public.office_user_layouts (user_id, space_key, surface, prefs) values ('${U.member}', 'me', 'x', '{}')`).status, 0, '남의 이름으로 못 넣는다');
});

// 이유: DB 위생 — 드래그가 끝날 때마다 같은 값이 다시 쓰이면 죽은 행이 쌓인다(9/23 사고). 같은 값은 행을 건드리지 않는다.
test('같은 값 저장은 쓰기 0(xmin 불변), 다른 값이면 version +1', { skip }, () => {
  const prefs = { items: [{ id: 'approvals', size: 'l' }] };
  saveMine(U.owner, prefs);
  const x1 = asUser(U.owner, `select xmin::text || ':' || version from public.office_user_layouts where surface = 'home'`);
  saveMine(U.owner, prefs);
  assert.equal(asUser(U.owner, `select xmin::text || ':' || version from public.office_user_layouts where surface = 'home'`), x1);
  saveMine(U.owner, { items: [{ id: 'approvals', size: 'm' }] });
  assert.equal(asUser(U.owner, `select version from public.office_user_layouts where surface = 'home'`), String(Number(x1.split(':')[1]) + 1));
});

// 이유: 공간 키·화면 이름·크기에 제한이 없으면 아무 값이나 쌓인다.
test('형식 밖 키·너무 큰 값은 거절', { skip }, () => {
  assert.notEqual(asUserRaw(U.owner, `select public.office_layout_save('nope', 'home', '{}'::jsonb)`).status, 0);
  assert.notEqual(asUserRaw(U.owner, `select public.office_layout_save('me', 'Home Screen!', '{}'::jsonb)`).status, 0);
  assert.notEqual(asUserRaw(U.owner, `select public.office_layout_save('me', 'home', jsonb_build_object('x', repeat('a', 40000)))`).status, 0);
});

// 이유: 조직 공간의 구조(홈 모듈 구성·위키 최상위)는 모두에게 같게 보이고, 관리자만 바꾼다(유건 확정 "구조는 공유, 보기는 개인").
test('조직 배치: 멤버는 읽기만, 관리자·소유자는 쓰기, 바깥 사람·퇴사자는 못 본다', { skip }, () => {
  asUser(U.admin, `select public.office_space_layout_save('${ORG}', 'home', '{"items":[{"id":"work","size":"full"}]}'::jsonb)`);
  assert.match(asUser(U.member, `select layout::text from public.office_space_layouts where org_id = '${ORG}'`), /work/);
  assert.notEqual(asUserRaw(U.member, `select public.office_space_layout_save('${ORG}', 'home', '{}'::jsonb)`).status, 0, '멤버는 못 바꾼다');
  assert.equal(last(asUserRaw(U.member, `update public.office_space_layouts set layout = '{}' where org_id = '${ORG}' returning 1`).stdout), '', '멤버는 직접 UPDATE도 못 한다');
  asUser(U.owner, `select public.office_space_layout_save('${ORG}', 'home', '{"items":[{"id":"work","size":"m"}]}'::jsonb)`);
  assert.equal(asUser(U.outsider, `select count(*) from public.office_space_layouts`), '0');
  assert.equal(asUser(U.gone, `select count(*) from public.office_space_layouts`), '0', '퇴사 처리된 사람은 즉시 못 본다');
});

test('조직 배치도 같은 값이면 쓰기 0', { skip }, () => {
  const v = `'{"items":[{"id":"approvals","size":"s"}]}'::jsonb`;
  asUser(U.admin, `select public.office_space_layout_save('${ORG}', 'wiki', ${v})`);
  const x1 = asUser(U.admin, `select xmin::text from public.office_space_layouts where surface = 'wiki'`);
  asUser(U.admin, `select public.office_space_layout_save('${ORG}', 'wiki', ${v})`);
  assert.equal(asUser(U.admin, `select xmin::text from public.office_space_layouts where surface = 'wiki'`), x1);
});
