// 아르고 오피스 페이지·공유(20260927300000_office_pages.sql) — 유건 확정 규칙(2026-09-26)을 DB에서 잠근다.
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
    '20260903120000_msgr.sql', '20260909002000_msgr_profiles_friends.sql', '20260927300000_office_pages.sql']) psql(['-f', mig(f)]);
  // 이유(9/27 실측): 라이브 Supabase는 pgcrypto가 extensions 스키마에 있어 search_path=public 함수에서 gen_random_bytes가 안 보인다 — 게시가 전부 실패했다. 드릴도 같게.
  psql(['-c', 'create schema if not exists extensions; alter extension pgcrypto set schema extensions;']);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'pages-org', '${U.owner}') returning id`));
  sql(`insert into public.msgr_org_entitlements (org_id, plan, seats) values ('${ORG}', 'team', 20) on conflict (org_id) do update set plan = 'team', seats = 20`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.admin}', 'admin'), ('${ORG}', '${U.member}', 'member'), ('${ORG}', '${U.guest}', 'guest'), ('${ORG}', '${U.gone}', 'member')`);
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.gone}'`);
});

// ── 권한 ──
test('내 공간: 만든 사람만 전체 권한, 남은 못 본다. 공유받으면 그 역할로 보고 하위 페이지도 상속', { skip }, () => {
  const p = create(U.member); const child = create(U.member, { parent: p });
  assert.equal(access(U.member, p), 'full');
  assert.equal(access(U.outsider, p), 'none'); assert.equal(visible(U.outsider, p), false);
  asUser(U.member, `select public.office_share_set('${p}', '${U.friend}', 'view')`);
  assert.equal(access(U.friend, p), 'view'); assert.equal(access(U.friend, child), 'view', '부모 공유 상속');
  assert.equal(visible(U.friend, child), true);
  fails(asUserRaw(U.friend, `select public.office_page_save('${p}', '바꿈', '${doc('x')}'::jsonb, 1)`));
  asUser(U.member, `select public.office_share_set('${p}', '${U.friend}', null)`); // 공유 해제
  assert.equal(access(U.friend, child), 'none');
});

test('조직: 소유자·관리자 전체, 멤버 기본 편집, 게스트·바깥 사람·퇴사자는 없음', { skip }, () => {
  const top = create(U.admin, { org: ORG });
  assert.equal(access(U.owner, top), 'full'); assert.equal(access(U.admin, top), 'full');
  assert.equal(access(U.member, top), 'edit');
  for (const u of ['guest', 'outsider', 'gone']) assert.equal(access(U[u], top), 'none', u);
});

test('일반 접근: 조직 보기면 멤버는 보기, 초대된 사람만이면 멤버도 못 본다', { skip }, () => {
  const p = create(U.admin, { org: ORG });
  asUser(U.admin, `select public.office_page_set_general('${p}', 'org_view')`);
  assert.equal(access(U.member, p), 'view');
  asUser(U.admin, `select public.office_page_set_general('${p}', 'invited')`);
  assert.equal(access(U.member, p), 'none');
  asUser(U.admin, `select public.office_share_set('${p}', '${U.member}', 'edit')`);
  assert.equal(access(U.member, p), 'edit');
});

test('게스트는 공유받은 조직 페이지만, 조직 밖 사람에게 한 공유는 효력이 없다', { skip }, () => {
  const p = create(U.admin, { org: ORG });
  asUser(U.admin, `select public.office_share_set('${p}', '${U.guest}', 'view')`);
  assert.equal(access(U.guest, p), 'view');
  asUser(U.admin, `select public.office_share_set('${p}', '${U.outsider}', 'view')`);
  assert.equal(access(U.outsider, p), 'none', '조직 페이지는 조직 구성원(게스트 포함)에게만');
});

test('비공개: 관리자와 지정한 사람만, 하위 페이지도 숨는다. 멤버는 비공개를 켜고 끌 수 없다', { skip }, () => {
  const p = create(U.admin, { org: ORG }); const child = create(U.admin, { org: ORG, parent: p });
  fails(asUserRaw(U.member, `select public.office_page_set_restricted('${p}', true)`));
  asUser(U.admin, `select public.office_page_set_restricted('${p}', true)`);
  assert.equal(access(U.member, p), 'none'); assert.equal(access(U.member, child), 'none');
  assert.equal(visible(U.member, child), false, '목록에서도 안 보인다');
  assert.equal(access(U.owner, child), 'full');
  asUser(U.admin, `select public.office_share_set('${p}', '${U.member}', 'view')`);
  assert.equal(access(U.member, child), 'view', '지정한 사람은 하위까지 본다');
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.member}'`);
  assert.equal(access(U.member, child), 'none', '퇴사 즉시 차단');
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}' and user_id = '${U.member}'`);
});

// ── 만들기·저장 ──
test('만들기: 조직 최상위는 관리자만, 멤버는 편집 가능한 페이지 아래에만, 게스트는 못 만든다, 남의 내 공간엔 못 만든다', { skip }, () => {
  fails(asUserRaw(U.member, `select public.office_page_create('${pid()}', '${ORG}', null, 'a0', 't', '{}'::jsonb)`));
  const top = create(U.admin, { org: ORG });
  create(U.member, { org: ORG, parent: top });
  fails(asUserRaw(U.guest, `select public.office_page_create('${pid()}', '${ORG}', '${top}', 'a0', 't', '{}'::jsonb)`));
  const mine = create(U.owner);
  fails(asUserRaw(U.outsider, `select public.office_page_create('${pid()}', null, '${mine}', 'a0', 't', '{}'::jsonb)`));
  const id = pid();
  create(U.member, { id }); create(U.member, { id }); // 재시도(같은 id)는 한 번만 만들어진다
  assert.equal(last(sql(`select count(*) from public.office_pages where id = '${id}'`)), '1');
});

test('저장: 버전이 다르면 충돌로 거절, 같은 내용이면 쓰기 0, 다르면 version +1', { skip }, () => {
  const p = create(U.member);
  asUser(U.member, `select public.office_page_save('${p}', '제목', '${doc('본문')}'::jsonb, 1)`);
  const x1 = last(sql(`select xmin::text || ':' || version from public.office_pages where id = '${p}'`));
  assert.equal(x1.split(':')[1], '1', '같은 내용이면 버전도 그대로');
  assert.equal(last(asUser(U.member, `select public.office_page_save('${p}', '제목', '${doc('새 본문')}'::jsonb, 1)`)), '2');
  fails(asUserRaw(U.member, `select public.office_page_save('${p}', '제목', '${doc('옛 기기')}'::jsonb, 1)`), /version_conflict/);
});

test('버전 기록: 10분 넘게 쉰 뒤 고치면 이전 모습이 남고, 되돌려도 되돌리기 전 모습이 남는다', { skip }, () => {
  const p = create(U.member, { content: doc('월요일') });
  sql(`update public.office_pages set updated_at = now() - interval '11 minutes' where id = '${p}'`);
  asUser(U.member, `select public.office_page_save('${p}', '제목', '${doc('수요일')}'::jsonb, 1)`);
  assert.equal(last(asUser(U.member, `select count(*) from public.office_page_versions where page_id = '${p}'`)), '1');
  assert.match(asUser(U.member, `select content::text from public.office_page_versions where page_id = '${p}'`), /월요일/);
  asUser(U.member, `select public.office_page_save('${p}', '제목', '${doc('수요일 오후')}'::jsonb, 2)`); // 쉬지 않고 이어서 고치면 새 버전 없음
  assert.equal(last(asUser(U.member, `select count(*) from public.office_page_versions where page_id = '${p}'`)), '1');
  const v = last(asUser(U.member, `select version from public.office_page_versions where page_id = '${p}'`));
  asUser(U.member, `select public.office_page_restore('${p}', ${v})`);
  assert.match(last(asUser(U.member, `select content::text from public.office_pages where id = '${p}'`)), /월요일/);
  assert.match(asUser(U.member, `select string_agg(content::text, '|') from public.office_page_versions where page_id = '${p}'`), /수요일 오후/, '되돌리기 전 모습이 남는다');
  assert.equal(last(asUser(U.outsider, `select count(*) from public.office_page_versions where page_id = '${p}'`)), '0');
});

// ── 휴지통·복제 ──
test('휴지통: 하위째 옮기고, 편집자는 더 못 보고, 지운 사람·관리자가 복원한다', { skip }, () => {
  const top = create(U.admin, { org: ORG }); const child = create(U.member, { org: ORG, parent: top });
  asUser(U.member, `select public.office_page_archive('${child}')`);
  assert.equal(visible(U.member, child), true, '지운 사람은 휴지통에서 본다');
  assert.equal(access(U.admin, child), 'full');
  const other = create(U.admin, { org: ORG }); asUser(U.admin, `select public.office_page_archive('${other}')`);
  assert.equal(visible(U.member, other), false, '남이 지운 건 멤버에게 안 보인다');
  asUser(U.member, `select public.office_page_restore_archived('${child}')`);
  assert.equal(last(sql(`select archived_at is null from public.office_pages where id = '${child}'`)), 't');
  asUser(U.admin, `select public.office_page_archive('${top}')`);
  assert.equal(last(sql(`select count(*) from public.office_pages where id in ('${top}', '${child}') and archived_at is not null`)), '2', '하위째');
});

test('복제: 하위까지 복사하고, 공유·비공개·비공개 블록은 따라가지 않는다', { skip }, () => {
  const p = create(U.admin, { org: ORG, title: '원본' }); create(U.admin, { org: ORG, parent: p, title: '하위' });
  asUser(U.admin, `select public.office_share_set('${p}', '${U.guest}', 'view')`);
  asUser(U.admin, `select public.office_page_set_restricted('${p}', true)`);
  asUser(U.admin, `insert into public.office_private_blocks (page_id, block_id, content) values ('${p}', 'b1', '{"type":"paragraph"}')`);
  const copy = last(asUser(U.admin, `select public.office_page_duplicate('${p}')`));
  assert.equal(last(sql(`select restricted from public.office_pages where id = '${copy}'`)), 'f');
  assert.equal(last(sql(`select count(*) from public.office_shares where page_id = '${copy}'`)), '0');
  assert.equal(last(sql(`select count(*) from public.office_private_blocks where page_id = '${copy}'`)), '0');
  assert.equal(last(sql(`select count(*) from public.office_pages where parent_id = '${copy}'`)), '1');
});

// ── 비공개 블록·공개 게시 ──
test('비공개 블록: 페이지 전체 권한자와 지정한 사람만 받는다', { skip }, () => {
  const p = create(U.admin, { org: ORG });
  asUser(U.admin, `insert into public.office_private_blocks (page_id, block_id, content, allowed) values ('${p}', 'rates', '{"type":"table"}', array['${U.member}']::uuid[])`);
  asUser(U.admin, `insert into public.office_private_blocks (page_id, block_id, content) values ('${p}', 'secret', '{"type":"paragraph"}')`);
  assert.equal(last(asUser(U.member, `select string_agg(block_id, ',') from public.office_private_blocks where page_id = '${p}'`)), 'rates');
  assert.equal(last(asUser(U.admin, `select count(*) from public.office_private_blocks where page_id = '${p}'`)), '2');
  fails(asUserRaw(U.member, `insert into public.office_private_blocks (page_id, block_id, content) values ('${p}', 'x', '{}')`));
});

test('공개 게시: 게시된 링크만 로그인 없이 읽고, 기록 카드·메일 참조는 빠진다', { skip }, () => {
  const content = JSON.stringify({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '공개 문단' }] },
    { type: 'recordCard', attrs: { ref: 'ap1' } },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'mailRef', attrs: { ref: 'm1' } }, { type: 'paragraph', content: [{ type: 'text', text: '목록' }] }] }] },
  ] });
  const p = create(U.admin, { org: ORG, title: '채용 공고', content });
  const token = last(asUser(U.admin, `select public.office_page_publish('${p}', true)`));
  assert.match(token, /^[A-Za-z0-9_-]{16,}$/);
  const out = asAnon(`select public.office_public_page('${token}')::text`);
  assert.match(out, /공개 문단/); assert.match(out, /목록/); assert.match(out, /Lean/, '조직 이름(로고 자리)');
  assert.doesNotMatch(out, /recordCard|mailRef/);
  assert.equal(asAnon(`select public.office_public_page('없는토큰없는토큰없는토큰') is null`), 't');
  asUser(U.admin, `select public.office_page_publish('${p}', false)`);
  assert.equal(asAnon(`select public.office_public_page('${token}') is null`), 't', '게시를 끄면 링크도 죽는다');
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select count(*) from public.office_pages`]));
});

// 이유: 공유 창은 누가 어떤 역할인지 보여 줘야 하지만, 메신저 규칙대로 남의 이메일은 내주지 않는다(msgr_find_user와 같은 원칙).
test('공유 목록: 전체 권한자만 이름·역할을 받고 이메일은 싣지 않는다', { skip }, () => {
  const p = create(U.admin, { org: ORG, title: '공유목록' });
  asUser(U.admin, `select public.office_share_set('${p}', '${U.member}', 'edit')`);
  sql(`insert into public.msgr_profiles (user_id, display_name) values ('${U.member}', '멤버님') on conflict (user_id) do update set display_name = excluded.display_name`);
  const out = last(asUser(U.admin, `select string_agg(name || ':' || role, ',') from public.office_page_people('${p}')`));
  assert.equal(out, '멤버님:edit');
  assert.doesNotMatch(asUser(U.admin, `select row_to_json(x)::text from public.office_page_people('${p}') x`), /@/);
  fails(asUserRaw(U.member, `select * from public.office_page_people('${p}')`), /office/);
});

// 이유: 게시는 검색 노출을 기본으로 끈다(유건 확정). 켜는 것은 전체 권한자만, 같은 값이면 행을 건드리지 않는다(DB 위생).
test('검색 노출: 전체 권한자만 켜고, 공개 응답에 실리며, 같은 값이면 쓰기 0', { skip }, () => {
  const p = create(U.admin, { org: ORG, title: '검색노출' });
  const token = last(asUser(U.admin, `select public.office_page_publish('${p}', true)`));
  assert.equal(asAnon(`select public.office_public_page('${token}') ->> 'index'`), 'false');
  fails(asUserRaw(U.member, `select public.office_page_set_index('${p}', true)`), /office/);
  asUser(U.admin, `select public.office_page_set_index('${p}', true)`);
  assert.equal(asAnon(`select public.office_public_page('${token}') ->> 'index'`), 'true');
  const x1 = sql(`select xmin from public.office_shares where page_id = '${p}' and principal_kind = 'link'`);
  asUser(U.admin, `select public.office_page_set_index('${p}', true)`);
  assert.equal(sql(`select xmin from public.office_shares where page_id = '${p}' and principal_kind = 'link'`), x1, '같은 값은 쓰지 않는다');
});

// 이유(유건 9/27): 템플릿은 "사본을 템플릿으로", 조직 템플릿은 관리자·소유자만 만들고 고친다, 멤버는 골라 쓰기만.
test('템플릿: 조직 것은 관리자만 만들고 멤버는 보기만, 최상위에만, 내 것은 나만 본다', { skip }, () => {
  const tpl = (uid, { org = null, parent = null } = {}) => { const id = pid(); return [id, asUserRaw(uid, `select public.office_page_create('${id}', ${org ? `'${org}'` : 'null'}, ${parent ? `'${parent}'` : 'null'}, 'a0', '양식', '${doc('양식 본문')}'::jsonb, true)`)]; };
  const [ot, ok] = tpl(U.admin, { org: ORG });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(sql(`select is_template from public.office_pages where id = '${ot}'`), 't');
  assert.equal(access(U.member, ot), 'view', '멤버는 조직 템플릿을 보기만');
  fails(tpl(U.member, { org: ORG })[1], /office/);
  const host = create(U.admin, { org: ORG, title: '부모' });
  fails(tpl(U.admin, { org: ORG, parent: host })[1], /office/);
  const [mt, mk] = tpl(U.member);
  assert.equal(mk.status, 0, mk.stderr);
  assert.equal(access(U.member, mt), 'full');
  assert.equal(visible(U.admin, mt), false, '내 템플릿은 남에게 안 보인다');
  assert.equal(sql(`select is_template from public.office_pages where id = '${create(U.member)}'`), 'f', '보통 만들기는 템플릿이 아니다');
});

// ── 정리 ──
test('정리: 휴지통 30일·버전 90일 지난 것만 지운다', { skip }, () => {
  const old = create(U.member); const fresh = create(U.member);
  sql(`update public.office_pages set archived_at = now() - interval '31 days', archived_by = '${U.member}' where id = '${old}'`);
  sql(`update public.office_pages set archived_at = now() - interval '29 days', archived_by = '${U.member}' where id = '${fresh}'`);
  sql(`insert into public.office_page_versions (page_id, version, title, content, created_at) values ('${fresh}', 90, 't', '{}', now() - interval '91 days'), ('${fresh}', 91, 't', '{}', now() - interval '89 days')`);
  sql(`select public.office_purge()`);
  assert.equal(last(sql(`select count(*) from public.office_pages where id = '${old}'`)), '0');
  assert.equal(last(sql(`select count(*) from public.office_pages where id = '${fresh}'`)), '1');
  assert.equal(last(sql(`select string_agg(version::text, ',') from public.office_page_versions where page_id = '${fresh}'`)), '91');
});
