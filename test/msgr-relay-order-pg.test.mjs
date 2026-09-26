// 메신저 단체 대화 동시 답변(20260926100000_msgr_relay_only_order.sql) 행동 핀 — 실 Postgres. 서버 봇(Hermes·OpenClaw 등) 경로.
// 2026-09-26 유건 결정: 여러 크루 멘션은 서로 기다리지 않는다. `@A > @B` 릴레이일 때만 앞 크루를 최대 2분 기다린다.
// 하네스는 msgr-bot-idle-gate-pg.test.mjs와 같다. ARGO_PG_TEST_URL 미설정이면 skip.
// 실행: `bash scripts/billing-pg-drill.sh test/msgr-relay-order-pg.test.mjs` · 변이: ARGO_MUTATE_ORDER=1
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asAnon = (q) => sql(`set role anon; ${q}`);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, PUB; const BOTS = {};
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
  if (process.env.ARGO_MUTATE_ORDER) { // 변이 red 실증: 동시 답변 이전 정의(20260924140000)로 되돌린다 → 동시 답변 핀이 빨개져야 한다
    const src = readFileSync(mig('20260924140000_msgr_bot_scan_bounded.sql'), 'utf8');
    psql(['-c', src.slice(src.indexOf('create or replace function public.msgr_bot_updates_before_work'), src.indexOf("notify pgrst"))]);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'admin', '${U.owner}') returning code`));
  assert.equal(last(asUser(U.admin, `select public.msgr_accept_invite('${code}')`)), ORG);
  PUB = last(asUser(U.owner, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'public', 'general', '${U.owner}') returning id`));
  for (const [key, name] of [['a', '에이'], ['b', '비']]) {
    const out = JSON.parse(last(asUser(U.admin, `select public.msgr_bot_create('${ORG}', 'hermes', '${name}', '외부 에이전트')`)));
    BOTS[key] = { crew: out.crew_id, token: out.token };
    sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PUB}', 'crew', '${out.crew_id}')`);
  }
});

const both = () => JSON.stringify([{ kind: 'crew', id: BOTS.a.crew }, { kind: 'crew', id: BOTS.b.crew }]);
const post = (body) => last(asUser(U.owner, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${PUB}', 'user', '${U.owner}', '${body}', '${both()}'::jsonb) returning id`));
const q = (x) => x.replace(/'/g, "''");
const got = (key, after = 0) => asAnon(`select public.msgr_bot_updates_with_delivery('${BOTS[key].token}', ${after})`).split('\n').filter(Boolean).map((l) => String(JSON.parse(l).update_id));

test('여러 크루 멘션(릴레이 아님) — 뒤 크루도 앞 크루의 답을 기다리지 않고 바로 받는다', { skip }, () => {
  const m = post('@에이 @비 의견 주세요');
  assert.ok(got('b').includes(m), '비(뒤 멘션)가 바로 받는다 — 옛 정의면 에이 답을 10분 기다려 red');
  assert.ok(got('a').includes(m));
});

test('릴레이(@A > @B) — 뒤 크루는 앞 크루를 기다리고, 2분이 지나면 받는다', { skip }, () => {
  const m = post('@에이 > @비 이어서 다듬어');
  assert.ok(!got('b').includes(m), '앞 크루(에이) 답 전에는 비에게 오지 않는다');
  sql(`update public.msgr_messages set created_at = now() - interval '90 seconds' where id = ${m}`);
  sql(`update public.msgr_bots set scan_at = now() - interval '31 seconds'`);
  assert.ok(!got('b').includes(m), '90초는 아직 대기');
  sql(`update public.msgr_messages set created_at = now() - interval '3 minutes' where id = ${m}`);
  sql(`update public.msgr_bots set scan_at = now() - interval '31 seconds'`);
  assert.ok(got('b').includes(m), '2분 상한이 지나면 받는다 — 옛 정의(10분)면 red');
});

test('동시 답변 중 앞 봇의 @넘김 — 뒤 봇의 뿌리 턴이 진행 중이어도 넘김이 배달된다(분리 검수 H-1)', { skip }, () => {
  const ups = (key) => { sql(`update public.msgr_bots set scan_at = now() - interval '31 seconds'`); return asAnon(`select public.msgr_bot_updates_with_delivery('${BOTS[key].token}', 0)`).split('\n').filter(Boolean).map((l) => JSON.parse(l)); };
  const root = post('@에이 @비 둘 다 의견');
  const a = ups('a').find((u) => String(u.update_id) === root)?.message; assert.ok(a, '에이가 뿌리를 받았다');
  assert.ok(ups('b').some((u) => String(u.update_id) === root), '비도 동시에 뿌리를 받았다(턴 진행 중)');
  const h = last(asAnon(`select public.msgr_bot_finish('${BOTS.a.token}','${PUB}','${q('X. @비 Y는 네가 맡아줘')}',${a.message_id},'${a.execution_attempt}','handoff','${q(JSON.stringify([{ kind: 'crew', id: BOTS.b.crew }]))}'::jsonb)`));
  assert.ok(ups('b').some((u) => String(u.update_id) === String(h)), '넘김이 비에게 배달된다 — 접으면(옛 규칙) red');
});
