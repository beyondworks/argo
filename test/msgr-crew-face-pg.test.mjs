// 에이전트 얼굴 모양·색(20260924170000_msgr_crew_face.sql) — 소유자만 바꾼다(기존 msgr_crews_update_owner 재사용),
// 관리자도 못 바꾼다(admin 정책 with check에 face), 범위 밖 값은 거절. 하네스는 msgr-server-link-pg.test.mjs와 같다
// (auth.uid() 스텁 + set role). 실행: `npm run test:pg` 또는 `bash scripts/billing-pg-drill.sh test/msgr-crew-face-pg.test.mjs`
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', other: '22222222-2222-4222-8222-222222222222', admin: '33333333-3333-4333-8333-333333333333' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const denied = (uid, q, re = /row-level security policy|permission denied for/i) => { const r = asUserRaw(uid, q); assert.notEqual(r.status, 0, `허용됨: ${q.slice(0, 80)}`); assert.match(r.stderr, re); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, CREW;
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
    '20260903120000_msgr.sql', '20260916210000_msgr_crews_lock_when.sql', '20260924170000_msgr_crew_face.sql']) psql(['-f', mig(f)]); // 배포될 그 파일을 그대로 적용
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'face-org', '${U.owner}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.other}', 'member'), ('${ORG}', '${U.admin}', 'admin')`);
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean-ax-face', 'mine', '내 크루') returning id`));
});

test('소유자만 얼굴을 바꾼다 — 다른 멤버는 0행(RLS의 using이 UPDATE 대상에서 걸러 오류 없이 조용히 막는다), 소유자는 됨', { skip }, () => {
  assert.equal(last(asUserRaw(U.other, `update public.msgr_crews set face = '{"shape":1,"color":2,"eyes":0}'::jsonb where id = '${CREW}' returning id`).stdout), '', '다른 멤버는 0행');
  asUser(U.owner, `update public.msgr_crews set face = '{"shape":1,"color":2,"eyes":0}'::jsonb where id = '${CREW}'`);
  assert.equal(sql(`select face = '{"shape":1,"color":2,"eyes":0}'::jsonb from public.msgr_crews where id = '${CREW}'`), 't'); // jsonb는 키 저장 순서를 보장하지 않는다 — 값으로 비교
});

test('범위 밖 값은 거절 — shape·color·eyes 각각, 잉여 키도', { skip }, () => {
  const bad = (payload, label) => { const r = asUserRaw(U.owner, `update public.msgr_crews set face = '${payload}'::jsonb where id = '${CREW}'`); assert.notEqual(r.status, 0, `허용됨: ${label}`); assert.match(r.stderr, /msgr_crews_face_shape|violates check constraint/i, label); };
  bad('{"shape":6,"color":0,"eyes":0}', 'shape 상한 초과');
  bad('{"shape":-1,"color":0,"eyes":0}', 'shape 음수');
  bad('{"shape":0,"color":10,"eyes":0}', 'color 상한 초과');
  bad('{"shape":0,"color":0,"eyes":3}', 'eyes 상한 초과');
  bad('{"shape":0,"color":0}', 'eyes 누락');
  bad('{"shape":0,"color":0,"eyes":0,"extra":1}', '잉여 키');
  bad('{"shape":"0","color":0,"eyes":0}', '문자열(숫자 아님)');
  asUser(U.owner, `update public.msgr_crews set face = null where id = '${CREW}'`); // null은 항상 허용 — 무작위 고정값으로 되돌리기
  assert.equal(sql(`select face is null from public.msgr_crews where id = '${CREW}'`), 't');
});

test('관리자도 남의 크루 얼굴은 못 바꾼다 — "소유자만"(검수 #704 M-1). 관리자의 detach(status)는 face가 null이어도 그대로 된다', { skip }, () => {
  asUser(U.owner, `update public.msgr_crews set face = null where id = '${CREW}'`);
  denied(U.admin, `update public.msgr_crews set face = '{"shape":5,"color":5,"eyes":2}'::jsonb where id = '${CREW}'`);
  asUser(U.owner, `update public.msgr_crews set face = '{"shape":1,"color":1,"eyes":1}'::jsonb where id = '${CREW}'`);
  denied(U.admin, `update public.msgr_crews set face = null where id = '${CREW}'`); // 소유자가 고른 얼굴을 지우는 것도 막는다
  asUser(U.owner, `update public.msgr_crews set face = null where id = '${CREW}'`);
  assert.equal(last(asUser(U.admin, `update public.msgr_crews set status = 'detached' where id = '${CREW}' returning status`)), 'detached', 'face null 크루의 detach'); // = 비교였다면 null = null이 NULL이 되어 여기서 막힌다
  asUser(U.owner, `update public.msgr_crews set status = 'active' where id = '${CREW}'`);
});
