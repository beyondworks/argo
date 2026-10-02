// 개인 방 넣기 요청 — 허락을 결정할 친구가 대기 중인 에이전트의 이름을 읽는다(2026-10-01 유건 제보: 이름 대신 crew id 앞 8자리).
// 20261001160000: msgr_personal_room_crews()가 "내가 든 개인 방에 대기 요청이 걸린 크루"도 표시용 열로 돌려준다. 방 밖 사람·결정 뒤에는 빠진다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-personal-room-crews-pending-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-personal-room-crews-pending-pg.test.mjs';
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
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
const join = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_join('${ch}', '${crew}')`));


let B1, AB;
const roomCrew = (uid, id) => { const r = last(asUser(uid, `select coalesce((select to_jsonb(x) from public.msgr_personal_room_crews() x where x.id = '${id}'), 'null'::jsonb)`)); return JSON.parse(r); };
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
  B1 = last(asUser(U.b, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow, commands) values (null, '${U.b}', 'ws-2222', 'hyoil', '효일', 'local', 'active', 'owner', '[{"name":"x"}]'::jsonb) returning id`));
  befriend(U.a, U.b); befriend(U.a, U.c); befriend(U.b, U.c);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`)); // a가 연 1:1 — 결재자는 a
});

test('요청 전: 친구 a는 b의 개인 크루를 못 읽는다', { skip }, () => {
  assert.equal(roomCrew(U.a, B1), null);
});

test('대기 요청이 걸리면 그 방의 친구(결재자)는 이름·얼굴 등 표시용 열을 읽는다 — 주인 전용 열은 가린다', { skip }, () => {
  assert.equal(join(U.b, AB, B1), 'requested', 'b는 방을 연 사람이 아니라 요청');
  const r = roomCrew(U.a, B1);
  assert.ok(r, 'a의 목록에 대기 크루가 있다');
  assert.equal(r.display_name, '효일');
  assert.equal(r.owner_user_id, U.b);
  assert.equal(r.commands, null, '남의 크루 명령 목록은 싣지 않는다');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_crews where id='${B1}'`), '0', '표(select)로는 여전히 안 보인다');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_channel_members where channel_id='${AB}' and member_kind='crew'`), '0', '방 구성원이 된 것은 아니다');
});

test('방 밖 사람은 못 읽는다 — 친구지만 그 방에 없는 c, 아무 관계 없는 e', { skip }, () => {
  assert.equal(roomCrew(U.c, B1), null, 'c(친구, 방 밖)');
  assert.equal(roomCrew(U.e, B1), null, 'e(무관)');
});

test('거절되면 목록에서 빠지고, 다시 요청해 허락되면 방 구성원으로 계속 보인다', { skip }, () => {
  const req = last(asUser(U.a, `select id from public.msgr_channel_crew_requests where channel_id='${AB}' and crew_id='${B1}' and status='pending'`));
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join_decide('${req}', false)`)), 'rejected');
  assert.equal(roomCrew(U.a, B1), null, '거절 뒤에는 안 보인다');
  sql(`update public.msgr_channel_crew_requests set decided_at = now() - interval '2 hours' where id='${req}'`); // 거절 직후 한 시간 재요청 제한을 지난 것으로
  assert.equal(join(U.b, AB, B1), 'requested');
  const req2 = last(asUser(U.a, `select id from public.msgr_channel_crew_requests where channel_id='${AB}' and crew_id='${B1}' and status='pending'`));
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join_decide('${req2}', true)`)), 'approved');
  assert.equal(roomCrew(U.a, B1)?.display_name, '효일', '허락 뒤에는 방 구성원 조건으로 보인다');
  assert.equal(roomCrew(U.c, B1), null, '여전히 방 밖 c는 못 본다');
});
