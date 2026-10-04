// 에이전트 기억 회수 판정(20261003200000 msgr_crew_presence, 유건 결정 2026-10-03). 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-presence-pg.test.mjs
// 본체는 이 답이 false인 채널만 PC 기억을 지운다 — true여야 할 곳에서 false가 나면 기억을 잃는다(HIGH), 남의 채널 존재가 새도 안 된다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-presence-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555' };
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const post = (uid, ch, body, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
const personalCrew = (uid, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${uid}', 'ws-${uid.slice(0, 4)}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
const join = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_join('${ch}', '${crew}')`));

const presence = (uid, ws, slug, ids) => Object.fromEntries(asUser(uid, `select id || '=' || present from public.msgr_crew_presence('${ws}', array[${ids.map(() => `'${slug}'`).join(',')}]::text[], array[${ids.map((i) => `'${i}'`).join(',')}]::uuid[])`).split('\n').filter(Boolean).map((l) => l.split('=')).map(([k, v]) => [k, v === 'true']));
const crewRow = (uid, org, ws, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (${org ? `'${org}'` : 'null'}, '${uid}', '${ws}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const NOPE = '99999999-9999-4999-8999-999999999999';
let ORG, PUB, PUB2, PRIV, A_ORG, A_PER, AB;
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
  const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`)); asUser(U.d, `select public.msgr_accept_invite('${code}')`);
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Work')`));
  PUB2 = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Sales')`));
  A_ORG = crewRow(U.a, ORG, 'ws-a', 'pepper'); // 같은 에이전트(ws-a/pepper)의 조직 행과 개인 행
  A_PER = crewRow(U.a, null, 'ws-a', 'pepper');
  befriend(U.a, U.b);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
  for (const [ch, crew] of [[PUB, A_ORG], [PUB2, A_ORG], [AB, A_PER]]) assert.equal(join(U.a, ch, crew), 'joined');
});

test('같은 에이전트의 조직·개인 행 어느 쪽이든 들어 있는 채널은 true, 없는 채널(없는 id 포함)은 false', { skip }, () => {
  assert.deepEqual(presence(U.a, 'ws-a', 'pepper', [PUB, PUB2, AB, NOPE]), { [PUB]: true, [PUB2]: true, [AB]: true, [NOPE]: false });
});

test('남이 물으면 판정 없음(남의 에이전트·채널 존재가 새지 않는다), 로그인 없으면 답 없음', { skip }, () => {
  assert.equal(asUser(U.b, `select string_agg(coalesce(present::text, 'null'), ',') from public.msgr_crew_presence('ws-a', array['pepper', 'pepper'], array['${PUB}', '${AB}']::uuid[])`), 'null,null', '남(b)이 물으면 판정 없음 — 소속 여부가 새지 않고, 본체는 지우지 않는다');
  assert.equal(sql(`select count(*) from public.msgr_crew_presence('ws-a', array['pepper'], array['${PUB}']::uuid[])`), '0');
});

test('보관한 채널은 true(소속 유지), 주인이 빼면 false', { skip }, () => {
  asUser(U.a, `update public.msgr_channels set archived_at = now() where id = '${PUB2}'`);
  assert.equal(presence(U.a, 'ws-a', 'pepper', [PUB2])[PUB2], true, '보관은 이탈이 아니다');
  asUser(U.a, `update public.msgr_channels set archived_at = null where id = '${PUB2}'`);
  assert.equal(last(asUser(U.a, `select public.msgr_crew_leave_channel('${PUB2}', '${A_ORG}')`)), 'removed');
  assert.deepEqual(presence(U.a, 'ws-a', 'pepper', [PUB, PUB2]), { [PUB]: true, [PUB2]: false });
});

test('공개 채널 제외 목록에 들면 false', { skip }, () => {
  asUser(U.a, `update public.msgr_channels set excluded_crew_ids = array['${A_ORG}']::uuid[] where id = '${PUB}'`);
  assert.equal(presence(U.a, 'ws-a', 'pepper', [PUB])[PUB], false);
  asUser(U.a, `update public.msgr_channels set excluded_crew_ids = '{}' where id = '${PUB}'`);
  assert.equal(presence(U.a, 'ws-a', 'pepper', [PUB])[PUB], true);
});

test('파견 해제(available)는 그 행의 채널을 모두 false로, 개인 행의 방은 그대로 true', { skip }, () => {
  asUser(U.a, `update public.msgr_crews set status = 'available' where id = '${A_ORG}'`);
  assert.deepEqual(presence(U.a, 'ws-a', 'pepper', [PUB, AB]), { [PUB]: false, [AB]: true });
});

test('조직 오프보딩(주인이 나감)이면 그 조직 채널 false — 멤버 d의 에이전트로 확인, 채널 삭제도 false', { skip }, () => {
  const D = crewRow(U.d, ORG, 'ws-d', 'kim');
  asUser(U.d, `select public.msgr_join_channel('${PUB}')`);
  if (join(U.d, PUB, D) === 'requested') for (const id of sql(`select id from public.msgr_channel_crew_requests where channel_id = '${PUB}' and status = 'pending'`).split('\n').filter(Boolean)) asUser(U.a, `select public.msgr_crew_join_decide('${id}', true)`); // 남의 채널은 방장 허락
  assert.equal(presence(U.d, 'ws-d', 'kim', [PUB])[PUB], true);
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.d}'`);
  assert.equal(presence(U.d, 'ws-d', 'kim', [PUB])[PUB], false);
  const X = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Temp')`));
  asUser(U.a, `update public.msgr_crews set status = 'active' where id = '${A_ORG}'`);
  assert.equal(join(U.a, X, A_ORG), 'joined');
  assert.equal(presence(U.a, 'ws-a', 'pepper', [X])[X], true);
  sql(`delete from public.msgr_channels where id = '${X}'`);
  assert.equal(presence(U.a, 'ws-a', 'pepper', [X])[X], false);
});

test('조직 소프트 삭제(30일 복구 가능)는 true로 둔다', { skip }, () => {
  asUser(U.a, `update public.msgr_crews set status = 'active' where id = '${A_ORG}'`);
  assert.equal(join(U.a, PUB, A_ORG), 'joined');
  sql(`update public.msgr_orgs set deleted_at = now() where id = '${ORG}'`);
  assert.equal(presence(U.a, 'ws-a', 'pepper', [PUB])[PUB], true);
  sql(`update public.msgr_orgs set deleted_at = null where id = '${ORG}'`);
});

test('여러 에이전트를 한 번에 — 쌍마다 그 에이전트 기준으로 답한다(다른 slug는 남의 소속을 빌리지 않는다)', { skip }, () => {
  const out = asUser(U.a, `select slug || ':' || id || '=' || present from public.msgr_crew_presence('ws-a', array['pepper', 'ghost'], array['${PUB}', '${PUB}']::uuid[])`).split('\n').filter(Boolean).sort();
  assert.deepEqual(out, [`ghost:${PUB}=false`, `pepper:${PUB}=true`].sort());
});

test('이 회사(ws)에 내 에이전트 행이 하나도 없으면 판정 없음(null) — 다른 계정 소유 회사의 PC 기록을 지우지 않는다', { skip }, () => {
  assert.equal(asUser(U.b, `select coalesce(present::text, 'null') from public.msgr_crew_presence('ws-a', array['pepper'], array['${PUB}']::uuid[])`), 'null');
  assert.equal(asUser(U.a, `select coalesce(present::text, 'null') from public.msgr_crew_presence('ws-a', array['deleted-agent'], array['${PUB}']::uuid[])`), 'false', '회사 행은 있는데 그 에이전트만 없음 = 빠짐');
});
