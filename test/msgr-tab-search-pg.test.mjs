// 폰 채팅·채널 탭 본문 검색(msgr_tab_search, 20261002150000 — 분리 검수 MEDIUM 2026-10-02: 입력마다 공간 전체 글을 ilike로 훑던 것).
// 범위 = 내가 든 방, 방마다 최근 500개 글, 결과 상한, 차단한 사람·숨긴 에이전트 글 제외. 실행: bash scripts/billing-pg-drill.sh test/msgr-tab-search-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-tab-search-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555' };
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };

let ORG, PUB, PRIV, DMAB, ARCH, PAIR, CREW;
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
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.b, U.c]) { const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`)); asUser(u, `select public.msgr_accept_invite('${code}')`); }
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Work')`));
  for (const u of [U.b, U.c]) asUser(u, `select public.msgr_join_channel('${PUB}')`);
  PRIV = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','private','Secret')`)); // b는 없다
  DMAB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','dm','dm:b','[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
  ARCH = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Old')`)); asUser(U.b, `select public.msgr_join_channel('${ARCH}')`);
  CREW = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.a}', 'ws-1111', 'helper', 'Helper', 'local', 'active', 'all') returning id`));
  befriend(U.d, U.e); PAIR = last(asUser(U.d, `select public.msgr_dm_personal('${U.e}')`)); // 개인 공간(조직 밖 두 사람)
});
const raw = (uid, ch, body, extra = '') => sql(`insert into public.msgr_messages (channel_id, org_id, author_kind, author_user_id, kind, body, client_msg_id${extra ? ', deleted_at' : ''}) select '${ch}', org_id, 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text${extra ? `, ${extra}` : ''} from public.msgr_channels where id = '${ch}'`);
const find = (uid, org, q) => asUser(uid, `select coalesce(string_agg(channel_id::text, ',' order by channel_id), '') from public.msgr_tab_search(${org ? `'${org}'` : 'null'}, '${q}')`).split('\n').pop();
const set = (...ids) => ids.sort().join(',');

test('내가 든 방에서만 찾는다 — 내가 없는 비공개 채널의 글은 맞아도 돌려주지 않는다, 다른 공간도 섞지 않는다', { skip }, () => {
  raw(U.a, PUB, '사과 이야기'); raw(U.a, PRIV, '사과 비밀'); raw(U.a, DMAB, '사과 dm'); raw(U.e, PAIR, '사과 개인');
  assert.equal(find(U.b, ORG, '사과'), set(PUB, DMAB), '조직 공간 — 공개·1:1만');
  assert.equal(find(U.a, ORG, '사과'), set(PUB, PRIV, DMAB), '방장 a는 비공개도');
  assert.equal(find(U.d, null, '사과'), PAIR, '개인 공간은 개인 방만');
  assert.equal(find(U.d, ORG, '사과'), '', '조직 밖 사람은 조직 글을 못 찾는다');
  assert.equal(find(U.c, null, '사과'), '', '남의 개인 방은 안 보인다');
});

test('지운 글·보관한 방·내 조직이 아닌 공간은 빠지고, 두 글자 미만·로그인 안 함은 빈 결과', { skip }, () => {
  raw(U.a, PUB, '배 지운글', 'now()');
  assert.equal(find(U.b, ORG, '지운글'), '');
  raw(U.a, ARCH, '포도 옛날'); assert.equal(find(U.b, ORG, '포도'), ARCH);
  sql(`update public.msgr_channels set archived_at = now() where id = '${ARCH}'`);
  assert.equal(find(U.b, ORG, '포도'), '', '보관한 방');
  assert.equal(find(U.b, ORG, '사'), '', '한 글자는 찾지 않는다');
  const anon = psqlRaw(['-A', '-t', '-c', `set role authenticated; select count(*) from public.msgr_tab_search('${ORG}', '사과')`]);
  assert.equal(anon.stdout.trim().split('\n').pop(), '0', '로그인 안 한 호출');
  const r = psqlRaw(['-A', '-t', '-c', `set role anon; select * from public.msgr_tab_search('${ORG}', '사과')`]);
  assert.notEqual(r.status, 0, 'anon 역할은 실행 권한 없음');
});

test('차단한 사람의 글·숨긴 에이전트의 글로는 찾지 않는다', { skip }, () => {
  raw(U.c, PUB, '귤밭 c가 씀');
  assert.equal(find(U.b, ORG, '귤밭'), PUB);
  sql(`insert into public.msgr_user_blocks (blocker, blocked) values ('${U.b}', '${U.c}')`);
  assert.equal(find(U.b, ORG, '귤밭'), '', '차단한 사람의 글');
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PUB}', 'crew', '${CREW}')`); // 채널에 초대된 에이전트만 글을 쓴다
  sql(`insert into public.msgr_messages (channel_id, org_id, author_kind, crew_id, kind, body, client_msg_id) values ('${PUB}', '${ORG}', 'crew', '${CREW}', 'text', '레몬 크루', gen_random_uuid()::text)`);
  assert.equal(find(U.b, ORG, '레몬'), PUB);
  sql(`insert into public.msgr_user_blocks (blocker, blocked_crew) values ('${U.b}', '${CREW}')`);
  assert.equal(find(U.b, ORG, '레몬'), '', '숨긴 에이전트의 글');
  assert.equal(find(U.a, ORG, '레몬'), PUB, '숨긴 사람만');
});

test('와일드카드는 글자 그대로 — %·_로 모든 글을 맞추지 못한다', { skip }, () => {
  assert.equal(find(U.b, ORG, '%%'), '');
  raw(U.a, PUB, '100% 확실'); assert.equal(find(U.b, ORG, '0%'), PUB);
  assert.equal(find(U.b, ORG, '__'), '');
});

test('범위 상한 — 방마다 최근 500개 글 안에서만 찾는다(오래된 글은 전체 검색으로)', { skip }, () => {
  raw(U.a, DMAB, '수박 오래된');
  assert.equal(find(U.b, ORG, '수박'), DMAB);
  sql(`insert into public.msgr_messages (channel_id, org_id, author_kind, author_user_id, kind, body, client_msg_id) select '${DMAB}', '${ORG}', 'user', '${U.a}', 'text', 'filler ' || g, gen_random_uuid()::text from generate_series(1, 500) g`);
  assert.equal(find(U.b, ORG, '수박'), '', '최근 500개 밖');
  assert.equal(find(U.b, ORG, 'filler 1'), DMAB, '최근 글은 찾는다');
});
