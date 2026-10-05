// 해고한 에이전트 분리(CX-14)·메신저 직무(CX-08)의 서버 쪽 — 미러(src/gateway/msgr.mjs mirrorInventory)가 주인의 기기 세션으로 쓰는 갱신이
// 실제 RLS·트리거를 통과하는지 본다: 주인은 자기 크루를 detached로 돌리고 되살릴 수 있고, 그때 채널 참여·글은 남으며(기억 데이터 보존),
// 분리된 동안 서버 게이트(msgr_instruct_check)가 지시를 막는다. 다른 멤버는 남의 크루 상태를 못 바꾼다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-fired-detach-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-fired-detach-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { host: '11111111-1111-4111-8111-111111111111', mate: '22222222-2222-4222-8222-222222222222' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
let ORG, MINE, CH, MSG;
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
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.host, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.host}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.host, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.host}') returning code`));
  assert.equal(last(asUser(U.mate, `select public.msgr_accept_invite('${code}')`)), ORG);
  // 미러가 넣는 것과 같은 모양(주인 세션으로 insert)
  MINE = last(asUser(U.host, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow) values ('${ORG}', '${U.host}', 'lean', 'luna', '루나', '마케터', 'local', 'active', 'all') returning id`));
  CH = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','public','general')`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${CH}', 'crew', '${MINE}') on conflict do nothing`);
  MSG = last(sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${CH}', 'crew', '${MINE}', 'text', '루나의 지난 답', 'fired-1') returning id`));
});

const status = () => sql(`select status from public.msgr_crews where id = '${MINE}'`);
const kept = () => [sql(`select count(*) from public.msgr_channel_members where channel_id = '${CH}' and member_kind = 'crew' and member_id = '${MINE}'`), sql(`select count(*) from public.msgr_messages where id = ${MSG} and crew_id = '${MINE}'`)];

test('해고(카드가 사라짐) — 주인 세션의 update status=detached가 통과하고, 채널 참여·글은 남으며, 지시는 서버가 막는다', { skip }, () => {
  assert.equal(last(asUser(U.host, `update public.msgr_crews set status = 'detached' where id = '${MINE}' returning id`)), MINE, '주인 RLS·트리거 통과');
  assert.equal(status(), 'detached');
  assert.deepEqual(kept(), ['1', '1'], '채널 참여·글 보존(파견 해제 available과 달리 참여 행을 지우지 않는다)');
  assert.equal(last(asUser(U.mate, `select public.msgr_instruct_check('${MINE}', '${U.mate}', '${CH}')`)), 'inactive', '분리된 크루에는 지시가 들어가지 않는다');
  assert.equal(last(asUser(U.mate, `select count(*) from public.msgr_crews where id = '${MINE}' and status = 'active'`)), '0', '메신저 목록(active)에서 빠진다');
});

test('복구·다시 영입 — 직무를 새 카드 값으로, status=active로 되돌리면 같은 채널에서 다시 일한다', { skip }, () => {
  assert.equal(last(asUser(U.host, `update public.msgr_crews set role_text = '브랜드 매니저', status = 'active' where id = '${MINE}' returning id`)), MINE);
  assert.equal(status(), 'active');
  assert.deepEqual(kept(), ['1', '1']);
  assert.equal(last(asUser(U.mate, `select public.msgr_instruct_check('${MINE}', '${U.mate}', '${CH}')`)), 'ok');
});

test('다른 멤버는 남의 크루 상태를 바꾸지 못한다(멤버 세션) — 미러는 주인 세션으로만 쓴다', { skip }, () => {
  const r = asUserRaw(U.mate, `update public.msgr_crews set status = 'detached' where id = '${MINE}' returning id`);
  assert.equal(r.status, 0, r.stderr); assert.equal(last(r.stdout ?? ''), '', '오류 없이 0행(RLS)');
  assert.equal(status(), 'active');
});
