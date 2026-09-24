// 남의 에이전트는 소유자가 채널에 초대했을 때만 쓴다(유건 2026-09-24: "VPS 에이전트들이 다른 사람 계정에도 뜨고 다른 사람이 내 에이전트를 마구 사용").
// 실사고: 조직 멤버가 자기 DM에서 남의 VPS 봇을 멘션 → DM 전달(msgr_dm_relay)이 msgr_dm_for_crew로 허용 범위 확인 없이 1:1 방을 만들고,
// 방 안의 크루는 방 멤버 누구나 지시 가능(msgr_instruct_check)이라 봇이 답했다. 봇은 만들 때 allow='all' 고정·회사 등급이라 남의 레일에도 보였다.
// 새 마이그레이션(NEW)은 사고 상태를 심은 뒤에 적용해 데이터 정리까지 확인한다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const NEW = '20260924180000_msgr_crew_private_bots.sql';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', member: '33333333-3333-4333-8333-333333333333', friend: '55555555-5555-4555-8555-555555555555', locker: '66666666-6666-4666-8666-666666666666' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const applyNew = () => psql(['-c', readFileSync(mig(NEW), 'utf8')]);

let ORG, LOCKED_ORG, BOT, LEGACY_BOT, LOCKED_BOT, LOCAL, MEMBER_DM, LEAK_DM;
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
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated;
    grant usage on schema realtime to authenticated;
  `]);
  // Supabase's outbound HTTP extension is stubbed; all Messenger SQL, RLS and triggers run unchanged.
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  for (const f of readdirSync(fileURLToPath(new URL('../supabase/migrations/', import.meta.url))).filter((f) => /^\d+_msgr.*\.sql$/.test(f) && f !== NEW).sort())
    psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.member}', 'member'), ('${ORG}', '${U.friend}', 'member')`);
  // 사고 상태: 옛 msgr_bot_create로 만든 봇(allow='all'), 멤버가 자기 DM에서 그 봇을 멘션해 전달로 생긴 방
  LEGACY_BOT = JSON.parse(last(asUser(U.owner, `select msgr_bot_create('${ORG}','hermes','aesop','Specialist')`))).crew_id;
  assert.equal(sql(`select allow from msgr_crews where id='${LEGACY_BOT}'`), 'all', '옛 정의 재현: 봇은 allow=all로 만들어진다');
  sql(`update msgr_crews set last_seen_at=now(), dm_delivery_protocol=1 where id='${LEGACY_BOT}'`);
  MEMBER_DM = last(asUser(U.member, `select msgr_create_channel('${ORG}','dm','dm:friend','[{"kind":"user","id":"${U.friend}"}]')`));
  const src = last(asUser(U.member, `insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${MEMBER_DM}','user','${U.member}','hi','[{"kind":"crew","id":"${LEGACY_BOT}","role":"to"}]') returning id`));
  LEAK_DM = sql(`select channel_id from msgr_messages where client_msg_id='relay:${src}:${LEGACY_BOT}'`);
  assert.ok(LEAK_DM, '옛 정의 재현: 남의 봇으로 전달 방이 생긴다');
  // 잠긴 정책 조직(allow_default=list 잠금)의 봇 — 정리가 잠금 트리거에 걸리지 않고 정책값을 따라야 한다
  LOCKED_ORG = last(asUser(U.locker, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lock', 'lock', '${U.locker}') returning id`));
  LOCKED_BOT = JSON.parse(last(asUser(U.locker, `select msgr_bot_create('${LOCKED_ORG}','hermes','locked','x')`))).crew_id;
  sql(`update msgr_org_policies set allow_default='list', allow_locked=true where org_id='${LOCKED_ORG}'`);
  sql(`update msgr_crews set allow='list' where id='${LOCKED_BOT}'`); // 잠금 시 정책 트리거가 이미 맞춰 두는 값
  applyNew();
  LOCAL = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, allow, last_seen_at) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine', 'owner', now()) returning id`));
});

const mention = (id) => JSON.stringify([{ kind: 'crew', id, role: 'to' }]);
const postAs = (uid, ch, body, m) => last(asUser(uid, `insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${ch}','user','${uid}','${body}','${m}') returning id`));
const relayOf = (source, crew) => sql(`select channel_id from msgr_messages where client_msg_id='relay:${source}:${crew}'`);
const dmCount = () => Number(sql(`select count(*) from msgr_channels where org_id='${ORG}' and kind='dm'`));

test('정리: 전달로 생긴 남의 방에서 봇은 빠지고(대화 기록·방은 그대로), 모든 봇은 소유자만(잠긴 정책이면 그 정책값)', { skip }, () => {
  assert.equal(sql(`select count(*) from msgr_channel_members where channel_id='${LEAK_DM}' and member_kind='crew'`), '0', '봇이 빠진다');
  assert.equal(sql(`select count(*) from msgr_messages where channel_id='${LEAK_DM}'`) !== '0', true, '대화 기록은 지우지 않는다');
  assert.equal(sql(`select allow from msgr_crews where id='${LEGACY_BOT}'`), 'owner');
  assert.equal(sql(`select allow from msgr_crews where id='${LOCKED_BOT}'`), 'list', '잠긴 정책 조직은 정책값 유지(잠금 트리거와 충돌 없음)');
});

test('허용 범위 밖의 남의 에이전트는 멘션해도 보내지지 않고 방도 생기지 않는다 — 로컬 에이전트·봇 모두(DM 글 검사가 먼저 거절)', { skip }, () => {
  for (const crew of [LOCAL, LEGACY_BOT]) {
    const before = dmCount();
    const r = psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${U.member}', false); insert into msgr_messages(channel_id,author_kind,author_user_id,body,mentions) values('${MEMBER_DM}','user','${U.member}','use it','${mention(crew)}')`]);
    assert.notEqual(r.status, 0, '거절'); assert.match(r.stderr, /msgr_not_allowed/);
    assert.equal(dmCount(), before, '새 방 없음');
  }
});

test('이중 방어: 전달 방 만들기(msgr_dm_for_crew)도 허용 범위 밖이면 거절 — 글 검사가 바뀌어도 방이 새지 않게', { skip }, () => {
  const before = dmCount();
  const r = psqlRaw(['-A', '-t', '-c', `select msgr_dm_for_crew('${ORG}','${U.member}','${LEGACY_BOT}')`]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /msgr_crew_not_allowed/);
  assert.equal(dmCount(), before);
  assert.ok(sql(`select msgr_dm_for_crew('${ORG}','${U.owner}','${LEGACY_BOT}')`), '소유자 본인은 된다');
});

test('허용 목록에 든 사람·소유자 본인은 그대로 전달된다(기존 동작 유지)', { skip }, () => {
  asUser(U.owner, `update msgr_crews set allow='list', allow_users=array['${U.member}']::uuid[] where id='${LOCAL}'`);
  const ok = postAs(U.member, MEMBER_DM, 'listed', mention(LOCAL));
  assert.ok(relayOf(ok, LOCAL), '목록에 든 멤버는 전달');
  const OWN_DM = last(asUser(U.owner, `select msgr_create_channel('${ORG}','dm','dm:m','[{"kind":"user","id":"${U.member}"}]')`));
  const mine = postAs(U.owner, OWN_DM, 'mine', mention(LEGACY_BOT));
  assert.ok(relayOf(mine, LEGACY_BOT), '소유자는 자기 봇에게 전달');
  asUser(U.owner, `update msgr_crews set allow='owner', allow_users='{}' where id='${LOCAL}'`);
});

test('새 봇은 조직 정책 기본값을 따르고(없으면 소유자만) 등급은 개인 — 로컬 에이전트와 같은 규칙', { skip }, () => {
  const b1 = JSON.parse(last(asUser(U.owner, `select msgr_bot_create('${ORG}','hermes','n1','x')`))).crew_id;
  assert.equal(sql(`select allow from msgr_crews where id='${b1}'`), 'owner');
  assert.equal(sql(`select msgr_crew_tier('${b1}')`), 'personal');
  sql(`update msgr_org_policies set allow_default='all' where org_id='${ORG}'`);
  const b2 = JSON.parse(last(asUser(U.owner, `select msgr_bot_create('${ORG}','hermes','n2','x')`))).crew_id;
  assert.equal(sql(`select allow from msgr_crews where id='${b2}'`), 'all', '조직이 전원 허용을 기본으로 정했으면 그 값');
  sql(`update msgr_org_policies set allow_default='owner' where org_id='${ORG}'`);
});
