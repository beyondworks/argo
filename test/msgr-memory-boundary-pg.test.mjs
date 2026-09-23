// 메신저 채널·조직 기억 경계(docs/msgr-memory-boundary.md P1, 유건 결정 2026-09-24) — 실 Postgres.
// 채널·조직 기억(msgr_org_docs, 서버 일지 journal/ 포함)은 채널·조직에서 나간 사람이 다시 볼 수 없다.
// 예외: 조직장(owner·admin — 1:1 대화 제외)과 그 채널의 채널장(admin_user_ids). 조직에서 나가면 장의 권한도 끝난다.
// 하네스는 msgr-bot-idle-gate-pg.test.mjs와 같다. 실행: `bash scripts/billing-pg-drill.sh test/msgr-memory-boundary-pg.test.mjs`
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333',
  lead: '44444444-4444-4444-8444-444444444444', guest: '55555555-5555-4555-8555-555555555555' };

function psql(args) { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, PRIV, DM;
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
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member'], [U.lead, 'member']]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  PRIV = last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'private', 'hr')`));
  const gcode = last(sql(`set role authenticated; select set_config('argo.uid', '${U.member}', false); reset role; insert into public.msgr_invites (org_id, role, channel_id, created_by) values ('${ORG}', 'guest', '${PRIV}', '${U.member}') returning code`)); // 초대자 = 채널을 만든 멤버(초대 트리거가 채널 관리권 확인)
  asUser(U.guest, `select public.msgr_accept_invite('${gcode}')`); // 채널 한정 게스트
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PRIV}', 'user', '${U.lead}'), ('${PRIV}', 'user', '${U.guest}') on conflict do nothing`);
  sql(`update public.msgr_channels set admin_user_ids = array['${U.lead}']::uuid[] where id = '${PRIV}'`);
  DM = last(sql(`insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'dm', 'dm:x', '${U.member}') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${DM}', 'user', '${U.member}'), ('${DM}', 'user', '${U.lead}')`);
  sql(`update public.msgr_channels set admin_user_ids = array['${U.lead}']::uuid[] where id = '${DM}'`);
  for (const ch of [PRIV, DM]) sql(`insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values ('${ORG}', '${ch}', 'journal/2026-09-24.md', 'j', '- 기록', '${U.member}', '${U.member}')`);
});

// 테이블 권한(RLS)은 넓히지 않는다 — 구버전 앱의 미러(syncOrgDocs)가 사용자 권한으로 표를 읽어 PC에 내려받으므로(설계 검수 H2).
// 장의 열람은 msgr_chief_docs RPC로만 — 메신저 기억 화면이 부른다.
const reads = (uid, ch) => Number(last(asUser(uid, `select count(*) from public.msgr_org_docs where channel_id = '${ch}'`)));
const chief = (uid, ch) => Number(last(asUser(uid, `select count(*) from public.msgr_chief_docs('${ORG}', true, 100) d where d->>'channel_id' = '${ch}'`)));
const sees = (uid, ch) => reads(uid, ch) + chief(uid, ch);

test('표 권한은 그대로 — 조직장도 멤버가 아닌 비공개 채널 문서를 표에서 직접 읽지 못한다(구버전 미러 누출 방지)', { skip }, () => {
  assert.equal(reads(U.owner, PRIV), 0);
});

test('조직장(owner·admin)은 RPC로 비멤버 비공개 채널 기억을 보고, 채널 이름·종류가 같이 온다', { skip }, () => {
  assert.equal(chief(U.owner, PRIV), 1);
  assert.equal(chief(U.admin, PRIV), 1);
  const row = JSON.parse(last(asUser(U.owner, `select public.msgr_chief_docs('${ORG}', true, 100) limit 1`)));
  assert.equal(row.channel_name, 'hr'); assert.equal(row.channel_kind, 'private');
});

test('1:1 대화 기억은 조직장도 못 본다(참여자만)', { skip }, () => {
  assert.equal(sees(U.owner, DM), 0);
  assert.equal(sees(U.admin, DM), 0);
  assert.equal(sees(U.member, DM), 1);
});

test('나간 멤버·게스트는 다시 못 보고, 채널장은 멤버에서 빠져도 자기 채널을 본다', { skip }, () => {
  assert.equal(sees(U.guest, PRIV), 1, '멤버일 때는 본다');
  sql(`delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_id in ('${U.guest}', '${U.lead}')`);
  assert.equal(sees(U.guest, PRIV), 0, '나간 게스트');
  assert.equal(sees(U.lead, PRIV), 1, '채널장 예외');
  sql(`delete from public.msgr_channel_members where channel_id = '${DM}' and member_id = '${U.lead}'`);
  assert.equal(sees(U.lead, DM), 0, '1:1 대화는 채널장 표시가 있어도 참여자만');
});

test('게스트는 채널장으로 표시돼 있어도 장 예외를 받지 못한다(설계 검수 H1)', { skip }, () => {
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PRIV}', 'user', '${U.guest}'), ('${PRIV}', 'user', '${U.lead}')`); // 채널장은 채널 멤버여야 지정된다
  sql(`update public.msgr_channels set admin_user_ids = array['${U.lead}', '${U.guest}']::uuid[] where id = '${PRIV}'`);
  assert.equal(chief(U.guest, PRIV), 0);
});

test('조직에서 나가면 장의 권한도 끝나고, 다시 들어와도 채널장 표시가 되살아나지 않는다(설계 검수 M1)', { skip }, () => {
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id in ('${U.lead}', '${U.admin}')`);
  assert.equal(sees(U.lead, PRIV), 0);
  assert.equal(sees(U.admin, PRIV), 0);
  assert.equal(sql(`select '${U.lead}' = any(admin_user_ids) from public.msgr_channels where id = '${PRIV}'`), 'f', '오프보딩이 채널장 표시를 지운다');
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}' and user_id = '${U.lead}'`);
  assert.equal(sees(U.lead, PRIV), 0, '재가입만으로 옛 채널 기억이 열리지 않는다');
});

// P2 — 턴마다 서버 기억(msgr_crew_memory): 크루 주인만, 전사 문서 + 크루가 참여한 이 채널 문서·최근 일지만. 다른 채널 문서는 싣지 않는다(설계 검수 H3).
test('크루 기억은 전사 문서와 이 채널 문서만 — 다른 채널·남의 크루는 없다', { skip }, () => {
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}'`);
  const crew = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status) values ('${ORG}', '${U.member}', 'ws1', 'mem-crew', 'Mem', 'local', 'active') returning id`));
  const OTHER = last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'private', 'other')`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PRIV}', 'crew', '${crew}') on conflict do nothing`);
  sql(`insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values
    ('${ORG}', null, 'rules/tone.md', '말투', '존댓말', '${U.owner}', '${U.owner}'),
    ('${ORG}', '${PRIV}', 'rules/hr.md', '인사 규칙', '기밀', '${U.member}', '${U.member}'),
    ('${ORG}', '${OTHER}', 'rules/other.md', '다른 채널', '새면 안 됨', '${U.member}', '${U.member}')`);
  const mem = JSON.parse(last(asUser(U.member, `select public.msgr_crew_memory('${crew}', '${PRIV}')`)));
  const titles = mem.docs.map((d) => d.title).sort();
  assert.deepEqual(titles, ['말투', '인사 규칙']);
  assert.deepEqual(mem.docs.map((d) => d.scope).sort(), ['channel', 'org']);
  assert.match(mem.journal, /기록/, '이 채널 최근 일지');
  const other = JSON.parse(last(asUser(U.member, `select public.msgr_crew_memory('${crew}', '${OTHER}')`)));
  assert.deepEqual(other.docs.map((d) => d.title), ['말투'], '크루가 없는 채널 — 전사 문서만');
  assert.equal(other.journal, '');
  assert.equal(last(asUser(U.owner, `select public.msgr_crew_memory('${crew}', '${PRIV}')`)), '', '남의 크루는 빈 결과');
});

// 퇴장 회수 판정(msgr_channel_access) — PC 사본은 서버가 채널마다 "못 읽음"이라고 명시한 경우에만 지운다(설계 검수 M7: 목록 누락·조회 실패로 지우지 않는다).
test('채널 접근 판정: 읽을 수 있거나 장이면 true, 나갔거나 없는 채널은 false', { skip }, () => {
  const rows = (uid, ids) => Object.fromEntries(asUser(uid, `select id || ':' || ok from public.msgr_channel_access(array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[])`).split('\n').filter(Boolean).map((l) => l.split(':')).map(([k, v]) => [k, v === 'true']));
  const gone = '99999999-9999-4999-8999-999999999999';
  const m = rows(U.member, [PRIV, DM, gone]);
  assert.equal(m[PRIV], true); assert.equal(m[DM], true); assert.equal(m[gone], false, '없는 채널(삭제) = 못 읽음');
  assert.equal(rows(U.owner, [PRIV])[PRIV], true, '조직장');
  assert.equal(rows(U.owner, [DM])[DM], false, '1:1은 조직장도');
  sql(`delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_id = '${U.guest}'`); // 5번 테스트가 다시 넣었다
  assert.equal(rows(U.guest, [PRIV])[PRIV], false, '나간 게스트');
});

// P3 연결 — 사람·부서가 겹치는 다른 채널 기억을 잇고, 신호가 없으면 잇지 않으며, 링크는 양쪽을 읽을 수 있는 사람에게만 보인다.
test('자동 연결: [[제목]]·공유 참여자·같은 부서로 잇고, 유휴 재실행은 쓰기 0, 링크는 권한 있는 사람만', { skip }, () => {
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}'`);
  const mk = (name) => last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'private', '${name}')`));
  const DEV = mk('dev'), DESIGN = mk('design'), SALES = mk('sales');
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${DEV}', 'user', '${U.lead}'), ('${DESIGN}', 'user', '${U.lead}') on conflict do nothing`);
  sql(`delete from public.msgr_channel_members where channel_id = '${SALES}' and member_id = '${U.member}'`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${SALES}', 'user', '${U.admin}') on conflict do nothing`);
  const doc = (ch, path, title, body) => last(sql(`insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values ('${ORG}', '${ch}', '${path}', '${title}', '${body}', '${U.member}', '${U.member}') returning id`));
  const dDesign = doc(DESIGN, 'projects/ui.md', '시안', '화면 시안');
  const dSales = doc(SALES, 'projects/deal.md', '영업', '계약');
  const dDev = doc(DEV, 'projects/api.md', 'API 설계', '[[영업]] 요구 반영');
  sql(`select public.msgr_doc_links_refresh(1000)`);
  const links = (src) => sql(`select string_agg(dst_doc::text || ':' || reason, ',' order by reason) from public.msgr_doc_links where src_doc = '${src}'`);
  assert.match(links(dDev), new RegExp(`${dDesign}:people`), '공유 참여자(lead)');
  assert.match(links(dDev), new RegExp(`${dSales}:wikilink`), '[[제목]]');
  assert.doesNotMatch(links(dDesign), new RegExp(dSales), '겹치는 사람·부서 없음(sales엔 조직 관리자만) — 잇지 않는다');
  const xmin = sql(`select string_agg(xmin::text, ',') from public.msgr_doc_link_state`);
  assert.equal(sql(`select public.msgr_doc_links_refresh(1000)`), '0'); assert.equal(sql(`select string_agg(xmin::text, ',') from public.msgr_doc_link_state`), xmin, '유휴 재실행은 쓰기 0');
  // 부서: 관리자만 정한다 → 부서가 같으면 사람이 안 겹쳐도 잇는다
  assert.throws(() => asUser(U.member, `select public.msgr_set_member_profile('${ORG}', '${U.member}', '개발', '팀장')`), /msgr_member_profile_forbidden/);
  assert.throws(() => asUser(U.member, `update public.msgr_org_members set department = '개발' where org_id = '${ORG}' and user_id = '${U.member}'`), /msgr_member_profile_forbidden/, '본인 수정 불가');
  const GUEST_CH = mk('ops');
  sql(`delete from public.msgr_channel_members where channel_id = '${GUEST_CH}' and member_id = '${U.member}'`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${GUEST_CH}', 'user', '${U.guest}')`);
  asUser(U.owner, `select public.msgr_set_member_profile('${ORG}', '${U.guest}', '개발', null)`);
  asUser(U.owner, `select public.msgr_set_member_profile('${ORG}', '${U.lead}', '개발', '팀장')`);
  const dOps = doc(GUEST_CH, 'projects/ops.md', '운영', '배포');
  sql(`select public.msgr_doc_links_refresh(1000)`);
  assert.match(links(dOps), /:department/, '같은 부서(개발)');
  // 가시성: 링크는 양쪽 문서를 읽을 수 있는 사람에게만
  const seen = (uid) => Number(last(asUser(uid, `select count(*) from public.msgr_doc_links where src_doc = '${dDev}'`)));
  const total = Number(sql(`select count(*) from public.msgr_doc_links where src_doc = '${dDev}'`));
  assert.equal(seen(U.member), total - 1, 'dev→sales만 숨는다 — member는 sales를 못 읽는다(대상 dst 쪽 권한까지, 검수 #691 테스트 공백 2)');
  assert.equal(Number(last(asUser(U.member, `select count(*) from public.msgr_doc_links where src_doc = '${dDev}' and dst_doc = '${dSales}'`))), 0);
  assert.equal(Number(last(asUser(U.member, `select count(*) from public.msgr_doc_links_for('${ORG}') where src_doc = '${dDev}'`))), total - 1, '조직 한정 조회 RPC도 같은 권한(검수 #691 M5)');
  assert.equal(seen(U.guest), 0, 'dev 채널을 못 읽는 사람');
});

// 검수 #691 HIGH-1: 채널을 나간 채널장(장 예외)이 남아 있는 채널에서 다른 채널장을 조직에서 내보낼 수 있어야 한다.
test('채널을 나간 채널장이 남아 있어도 다른 채널장을 조직에서 내보낼 수 있다', { skip }, () => {
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}'`);
  const X = last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'private', 'heads-x')`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${X}', 'user', '${U.lead}') on conflict do nothing`);
  sql(`update public.msgr_channels set admin_user_ids = array['${U.lead}', '${U.member}']::uuid[] where id = '${X}'`);
  sql(`delete from public.msgr_channel_members where channel_id = '${X}' and member_id = '${U.lead}'`); // lead는 나갔지만 채널장(장 예외)
  asUser(U.owner, `update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.member}'`);
  assert.notEqual(sql(`select removed_at from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.member}'`), '', '내보내기 성공');
  assert.equal(sql(`select array_to_string(admin_user_ids, ',') from public.msgr_channels where id = '${X}'`), U.lead, '나간 사람만 채널장에서 빠진다');
  assert.throws(() => sql(`update public.msgr_channels set admin_user_ids = array['${U.lead}', '${U.guest}']::uuid[] where id = '${X}'`), /msgr_channel_admin_not_channel_member/, '새로 넣는 채널장은 여전히 채널 멤버여야 한다');
});

// 재검 #691: 오프보딩 예외를 GUC 표지로 열면 SQL을 직접 쓰는 채널장이 표지를 켜고 채널장을 마음대로 늘렸다 — 예외는 트리거 안에서 온 변경만.
test('채널장이 오프보딩 표지를 위조해도 만든 사람·관리자만 채널장을 바꾼다', { skip }, () => {
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}'`);
  const Z = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'private', 'heads-z')`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${Z}', 'user', '${U.member}'), ('${Z}', 'user', '${U.lead}') on conflict do nothing`);
  sql(`update public.msgr_channels set admin_user_ids = array['${U.member}']::uuid[] where id = '${Z}'`);
  assert.throws(() => asUser(U.member, `select set_config('argo.msgr_offboard', '1', false); update public.msgr_channels set admin_user_ids = array['${U.member}', '${U.lead}']::uuid[] where id = '${Z}'`), /msgr_channel_admins_owner_only/);
  assert.equal(sql(`select array_to_string(admin_user_ids, ',') from public.msgr_channels where id = '${Z}'`), U.member);
  // 임시 표 트리거로 depth를 올려도 마찬가지(재검 #691 실증 — pg_trigger_depth 예외는 위조됐다)
  assert.throws(() => asUser(U.member, `create temp table t(x int); create function pg_temp.f() returns trigger language plpgsql as $f$ begin update public.msgr_channels set admin_user_ids = array['${U.member}', '${U.lead}']::uuid[] where id = '${Z}'; return new; end $f$; create trigger tt after insert on pg_temp.t for each row execute function pg_temp.f(); insert into t values (1);`), /msgr_channel_admins_owner_only/);
  assert.throws(() => asUser(U.member, `update public.msgr_channels set admin_user_ids = '{}'::uuid[] where id = '${Z}'`), /msgr_channel_admins_owner_only/, '아직 멤버인 채널장을 빼는 것도 만든 사람·관리자만');
  assert.equal(sql(`select array_to_string(admin_user_ids, ',') from public.msgr_channels where id = '${Z}'`), U.member);
});

test('직접 만들지 않은 채널의 채널장도 계정 삭제(msgr_delete_me)로 떠날 수 있고, 채널장 표시가 지워진다', { skip }, () => {
  const Y = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'public', 'heads-y')`));
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}' and user_id = '${U.lead}'`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${Y}', 'user', '${U.lead}') on conflict do nothing`);
  sql(`update public.msgr_channels set admin_user_ids = array['${U.lead}']::uuid[] where id = '${Y}'`);
  asUser(U.lead, `select public.msgr_delete_me()`);
  assert.equal(sql(`select coalesce(array_to_string(admin_user_ids, ','), '') from public.msgr_channels where id = '${Y}'`), '');
});
