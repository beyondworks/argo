// 아르고 오피스 페이지·공유(20260927170000_office_pages.sql) — 유건 확정 규칙(2026-09-26)을 DB에서 잠근다.
// 권한: 조직 소유자·관리자 전체 / 멤버 기본 편집(일반 접근에 따라) / 게스트는 공유분만 / 내 공간은 만든 사람만 / 공유는 부모에서 상속·가장 높은 역할.
// 비공개(관리자 지정)는 관리자와 지정한 사람만, 퇴사 즉시 차단. 복제는 공유·비공개를 따라가지 않는다. 버전 90일·휴지통 30일.
// 하네스는 msgr-crew-face-pg.test.mjs와 같다. 실행: bash scripts/billing-pg-drill.sh test/office-pages-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/office-pages-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333',
  guest: '44444444-4444-4444-8444-444444444444', outsider: '55555555-5555-4555-8555-555555555555', gone: '66666666-6666-4666-8666-666666666666',
  friend: '77777777-7777-4777-8777-777777777777',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asAnon = (q) => sql(`set role anon; select set_config('argo.uid', '', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (r, re) => { assert.notEqual(r.status, 0, '허용되면 안 된다'); if (re) assert.match(r.stderr, re); };

let n = 0;
const pid = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const doc = (text) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
/** 페이지 만들기(클라이언트가 id를 정한다) — org 없으면 내 공간 */
const create = (uid, { id = pid(), org = null, parent = null, title = '제목', content = doc('본문') } = {}) => {
  asUser(uid, `select public.office_page_create('${id}', ${org ? `'${org}'` : 'null'}, ${parent ? `'${parent}'` : 'null'}, 'a0', '${title}', '${content}'::jsonb)`);
  return id;
};
const access = (uid, page) => last(asUser(uid, `select public.office_page_access('${page}')`));
const visible = (uid, page) => last(asUser(uid, `select count(*) from public.office_pages where id = '${page}'`)) === '1';

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
    '20260903120000_msgr.sql', '20260909002000_msgr_profiles_friends.sql', '20260927170000_office_pages.sql', '20260926210000_office_layouts.sql', '20260928000915_office_module_placement.sql']) psql(['-f', mig(f)]);
  // 이유(9/27 실측): 라이브 Supabase는 pgcrypto가 extensions 스키마에 있어 search_path=public 함수에서 gen_random_bytes가 안 보인다 — 게시가 전부 실패했다. 드릴도 같게.
  psql(['-c', 'create schema if not exists extensions; alter extension pgcrypto set schema extensions;']);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'pages-org', '${U.owner}') returning id`));
  sql(`insert into public.msgr_org_entitlements (org_id, plan, seats) values ('${ORG}', 'team', 20) on conflict (org_id) do update set plan = 'team', seats = 20`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.admin}', 'admin'), ('${ORG}', '${U.member}', 'member'), ('${ORG}', '${U.guest}', 'guest'), ('${ORG}', '${U.gone}', 'member')`);
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.gone}'`);
});

test('home layout CAS preserves distinct instances and rejects stale writers', {skip},()=>{
 const one=JSON.stringify({items:[{id:pid(),moduleId:'biz-orders',size:'m',hidden:false},{id:pid(),moduleId:'chart-kpi',size:'s',hidden:false,cfg:{metric:'sales'}}]});
 assert.equal(last(asUser(U.owner,`select office_layout_save_v2('me','home','${one}',0)`)),'1');
 assert.equal(last(asUser(U.owner,`select office_layout_save_v2('me','home','${one}',0)`)),'1');
 assert.equal(last(asUser(U.owner,`select office_layout_save_v2('me','home','{"items":[]}',1)`)),'2');
 fails(asUserRaw(U.owner,`select office_layout_save_v2('me','home','${one}',1)`),/layout_version_conflict/);
 assert.equal(last(asUser(U.outsider,`select count(*) from office_user_layouts where user_id='${U.owner}'`)),'0');
 fails(asUserRaw(U.owner,`select office_layout_save_v2('me','page:${pid()}','{}',0)`),/layout_input/);
});

test('org layout CAS is admin-only and matches role revocation', {skip},()=>{
 assert.equal(last(asUser(U.owner,`select office_space_layout_save_v2('${ORG}','home','{"items":[]}',0)`)),'1');
 assert.equal(last(asUser(U.admin,`select office_space_layout_save_v2('${ORG}','home','{"items":[{"id":"x"}]}',1)`)),'2');
 fails(asUserRaw(U.owner,`select office_space_layout_save_v2('${ORG}','home','{"items":[]}',1)`),/layout_version_conflict/);
 for(const who of [U.member,U.guest,U.gone,U.outsider]) {
  fails(asUserRaw(who,`select office_space_layout_save_v2('${ORG}','home','{}',2)`),/org admin only/);
  fails(asUserRaw(who,`select office_space_layout_save('${ORG}','home','{}')`),/org admin only/);
 }
});

test('module grid stays in editable page versions but is stripped from public links', {skip},()=>{
 const content=JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Visible text'}]},{type:'moduleGrid',attrs:{items:[{id:pid(),moduleId:'biz-orders',size:'full',hidden:false,cfg:{customer:'private-reference'}}]}}]});
 const p=create(U.owner,{content});
 const own=JSON.parse(last(asUser(U.owner,`select to_jsonb(p) from office_page_list_access() p where id='${p}'`)));
 assert.equal(own.owner_user_id,U.owner);assert.equal(own.access,'full');
 asUser(U.owner,`select office_share_set('${p}','${U.friend}','edit')`);
 assert.equal(last(asUser(U.friend,`select access from office_page_list_access() where id='${p}'`)),'edit');
 assert.equal(last(asUser(U.friend,`select office_page_save('${p}','Edited','${content}',1)`)),'2');
 const token=last(asUser(U.owner,`select office_page_publish('${p}',true)`));
 const published=JSON.parse(last(asAnon(`select office_public_page('${token}')`)));
 assert.match(JSON.stringify(published),/Visible text/);assert.doesNotMatch(JSON.stringify(published),/moduleGrid|private-reference|biz-orders/);
 asUser(U.owner,`select office_share_set('${p}','${U.friend}','view')`);
 fails(asUserRaw(U.friend,`select office_page_save('${p}','Denied','${content}',2)`),/access required/);
 assert.equal(last(asUser(U.outsider,`select count(*) from office_page_list_access() where id='${p}'`)),'0');
});
