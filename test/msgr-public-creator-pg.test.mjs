// 공개 채널도 만든 사람을 참여시킨다(D41, 20260919100000). 종전 msgr_create_channel은 비공개·DM만 만든 사람을 넣어,
// 공개 채널을 만든 사람은 만든 직후 0명이고 새로고침하면 목록에서 사라졌다. 백필(참여제 이후 생성분)도 여기서 핀.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-public-creator-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { psqlSpawn } from './helpers/pg.mjs';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-public-creator-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { host: '11111111-1111-4111-8111-111111111111', mate: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333', svc: '44444444-4444-4444-8444-444444444444', out: '55555555-5555-4555-8555-555555555555' };
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 160)}`); };
const why = (crew, author, ch) => sql(`select public.msgr_instruct_check('${crew}', '${author}', '${ch}')`);
const inCh = (ch, crew) => sql(`select public.msgr_crew_in_channel('${ch}', '${crew}')`);

let ORG, PRIV, PUB, DM, HOSTC, MATEC, OTHERC, COMP, MATEBOT;
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
  for (const u of [U.mate, U.other]) {
    const code = last(asUser(U.host, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.host}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.svc}', 'member')`);
  sql(`update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}'`);
  const crew = (owner, slug, hosting = 'local') => last(sql(`select set_config('msgr.bot_create', '${hosting === 'bot' ? '1' : ''}', false); insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status, allow, hosting) values ('${ORG}', '${owner}', 'lean', '${slug}', '${slug}', 'active', 'owner', '${hosting}') returning id`));
  HOSTC = crew(U.host, 'hostc'); MATEC = crew(U.mate, 'matec'); OTHERC = crew(U.other, 'otherc'); COMP = crew(U.svc, 'company', 'resident'); MATEBOT = crew(U.mate, 'matebot', 'bot');
  PRIV = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'private', 'Lean Crew', '[{"kind":"user","id":"${U.mate}"}]'::jsonb)`));
  PUB = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'public', 'General')`));
  DM = last(asUser(U.mate, `select public.msgr_create_channel('${ORG}', 'dm', 'mate-host', '[{"kind":"user","id":"${U.host}"}]'::jsonb)`));
});


const members = (ch) => sql(`select string_agg(member_kind || ':' || member_id, ',' order by member_kind, member_id) from public.msgr_channel_members where channel_id = '${ch}'`);
const has = (ch, uid) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${uid}'`);

test('공개 채널을 만든 사람은 참여 행이 생긴다 — 찾아보기 목록에는 안 뜨고 참여자 1', { skip }, () => {
  const ch = last(asUser(U.mate, `select public.msgr_create_channel('${ORG}', 'public', 'mate-public')`));
  assert.equal(has(ch, U.mate), '1', '만든 사람 참여(종전: 0)');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}'`), '1', '만든 사람만');
  const browse = asUser(U.mate, `select id from public.msgr_browse_channels('${ORG}')`);
  assert.ok(!browse.includes(ch), '이미 참여했으니 찾아보기에는 없다');
  assert.ok(asUser(U.other, `select id from public.msgr_browse_channels('${ORG}')`).includes(ch), '다른 멤버에게는 찾아보기에 뜬다');
});

test('공개 채널에 others를 넘겨도 무시 — 공개는 스스로 들어온다(종전과 같음)', { skip }, () => {
  const ch = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'public', 'with-others', '[{"kind":"user","id":"${U.mate}"}]'::jsonb)`));
  assert.equal(has(ch, U.host), '1');
  assert.equal(has(ch, U.mate), '0', 'others는 공개에서 무시');
});

test('비공개·DM은 종전대로 만든 사람 + others', { skip }, () => {
  const priv = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'private', 'priv-d41', '[{"kind":"user","id":"${U.mate}"}]'::jsonb)`));
  assert.equal(members(priv), `user:${[U.host, U.mate].sort().join(',user:')}`);
  const dm = last(asUser(U.other, `select public.msgr_create_channel('${ORG}', 'dm', 'dm-d41', '[{"kind":"user","id":"${U.host}"}]'::jsonb)`));
  assert.equal(members(dm), `user:${[U.host, U.other].sort().join(',user:')}`);
});

test('백필: 참여제 이후 만든 공개 채널에서 빠진 만든 사람만 되살린다(제외·조직 이탈·이전 채널·보관은 그대로)', { skip }, () => {
  const file = readFileSync(mig('20260919100000_msgr_public_creator_joins.sql'), 'utf8');
  const backfill = file.slice(file.indexOf('insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by)\nselect'));
  assert.match(backfill, /^insert into public\.msgr_channel_members[\s\S]*on conflict do nothing;\s*$/, '백필 문 추출');
  const mk = (nm, creator, extra = '') => last(sql(`insert into public.msgr_channels (org_id, kind, name, created_by, created_at${extra ? ', ' + extra.split('=')[0] : ''}) values ('${ORG}', 'public', '${nm}', '${creator}', ${nm === 'old' ? "timestamptz '2026-09-10 00:00:00+09'" : 'now()'}${extra ? ', ' + extra.split('=')[1] : ''}) returning id`));
  const lost = mk('lost', U.mate);                                   // 결함으로 빠진 만든 사람 → 되살림
  const old = mk('old', U.mate);                                     // 참여제 이전 → 그대로
  const excl = mk('excl', U.mate, `excluded_user_ids=array['${U.mate}']::uuid[]`); // 내보낸 사람 → 그대로
  const gone = mk('gone', U.out);                                    // 조직 멤버 아님 → 그대로
  const arch = mk('arch', U.mate, `archived_at=now()`);              // 보관 → 그대로
  sql(backfill);
  assert.equal(has(lost, U.mate), '1', '되살림');
  assert.equal(has(old, U.mate), '0', '이전 채널은 9/16 백필 규칙 그대로');
  assert.equal(has(excl, U.mate), '0', '제외된 사람은 넣지 않는다');
  assert.equal(has(gone, U.out), '0', '조직 밖 사람은 넣지 않는다');
  assert.equal(has(arch, U.mate), '0', '보관 채널은 건드리지 않는다');
  sql(backfill); assert.equal(has(lost, U.mate), '1', '두 번 돌려도 한 행(멱등)');
});
