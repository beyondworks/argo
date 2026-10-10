// 게이트웨이 깨우기 방송(20261010232100_msgr_gateway_crew_wake, #943) — 실제 Postgres에서 본다.
// ① 에이전트가 active가 되는 일(새 파견·재개 paused → active·다시 파견 available → active)과 주인의 조직 가입·재가입은 주인 u:<uid>로 'crew_sync' 한 건
// ② 심박(last_seen_at)·이름·active → 다른 상태·조직 탈퇴는 방송 0 — 쉬는 동안 쓰기·방송을 늘리지 않는다
// ③ 게이트웨이가 쉬는 주기를 써도 되는지 묻는 표지 msgr_gateway_wake_protocol() = 1(로그인 사용자만)
// 실행: bash scripts/billing-pg-drill.sh test/msgr-gateway-wake-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-gateway-wake-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', member: '33333333-3333-4333-8333-333333333333', outsider: '55555555-5555-4555-8555-555555555555' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰(시각 되돌리기)만
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, C1;
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
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select null::void $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  // 배포될 메신저 마이그레이션 전부(이 PR의 20261010120000 포함) — 날짜 순서 그대로
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  // 방송을 기록하는 realtime.send — 시험 환경의 빈 함수를 바꿔 끼운다(마이그레이션은 이 함수를 다시 만들지 않는다)
  psql(['-c', `create table if not exists public._sent (id bigserial primary key, topic text, event text, payload jsonb);
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql security definer as $$ insert into public._sent (topic, event, payload) values (topic, event, payload) $$;`]);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
});

const wakes = () => sql(`select coalesce(string_agg(topic || ':' || coalesce(payload->>'crew_id', payload->>'org_id'), ',' order by id), '') from public._sent where event = 'crew_sync'`);
const reset = () => sql('truncate public._sent');

test('새 파견(active insert)은 주인 u:로 crew_sync 한 건 — 페이로드는 id만', { skip }, () => {
  reset();
  C1 = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'mine') returning id`));
  assert.equal(wakes(), `u:${U.owner}:${C1}`);
  assert.deepEqual(Object.keys(JSON.parse(sql(`select payload::text from public._sent order by id desc limit 1`))).sort(), ['crew_id', 'org_id']);
});

test('심박·이름 바꾸기·active → 다른 상태는 방송 0, 다시 active가 되면(다시 파견·되살림·#941 재개) 한 건씩', { skip }, () => {
  reset();
  sql(`update public.msgr_crews set last_seen_at = now(), work_protocol = 1 where id = '${C1}'`); // 심박이 쓰는 열(msgr_device_beat의 옛 읽기 호환·업무 기능 표시) — 함수 모양은 #945가 맡아 여기서는 열 쓰기로 본다
  sql(`update public.msgr_crews set display_name = 'mine2' where id = '${C1}'`);
  sql(`update public.msgr_crews set status = 'available' where id = '${C1}'`);
  assert.equal(wakes(), '', '심박·이름·파견 해제는 방송 없음');
  sql(`update public.msgr_crews set status = 'active' where id = '${C1}'`);
  assert.equal(wakes(), `u:${U.owner}:${C1}`, '다시 파견');
  reset();
  sql(`update public.msgr_crews set status = 'paused' where id = '${C1}'`);
  assert.equal(wakes(), '', '중지는 방송 없음');
  sql(`select public._msgr_crew_plan_resume('${C1}', 0)`);
  assert.equal(sql(`select status from public.msgr_crews where id = '${C1}'`), 'active');
  assert.equal(wakes(), `u:${U.owner}:${C1}`, '#941 재개(paused → active)');
  reset();
  sql(`update public.msgr_crews set status = 'active' where id = '${C1}'`);
  assert.equal(wakes(), '', '같은 값 다시 쓰기는 방송 없음');
});

test('조직 가입(초대 수락)·재가입은 그 사람 u:로 crew_sync, 탈퇴는 방송 0', { skip }, () => {
  reset();
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
  assert.equal(last(asUser(U.member, `select public.msgr_accept_invite('${code}')`)), ORG);
  assert.equal(wakes(), `u:${U.member}:${ORG}`, '가입');
  reset();
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.member}'`);
  assert.equal(wakes(), '', '탈퇴는 방송 없음');
  sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}' and user_id = '${U.member}'`);
  assert.equal(wakes(), `u:${U.member}:${ORG}`, '재가입');
});

test('표지 msgr_gateway_wake_protocol() = 1 — 로그인 사용자만', { skip }, () => {
  assert.equal(last(asUser(U.owner, 'select public.msgr_gateway_wake_protocol()')), '1');
  const r = psqlRaw(['-A', '-t', '-c', 'set role anon; select public.msgr_gateway_wake_protocol()']);
  assert.notEqual(r.status, 0, 'anon은 부를 수 없다');
});
