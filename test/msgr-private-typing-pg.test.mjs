// 휘발 방송(typing·progress) 방 토픽(20260918190000) — 공개 채널은 org:<조직>, 비공개 방(DM·비공개 채널)은 dm:<채널>.
// 조직 토픽은 조직 전원이 받아, 비공개 방의 typing이 channel_id·crew_id로 방의 존재와 크루 활동을 조직 전원에게 흘렸다.
// realtime.send는 realtime.sent 표에 기록하는 스텁 — 어느 토픽으로 무엇을 보냈는지 그대로 본다. 수신 정책은 realtime.messages 행 가시성으로.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  outsider: '66666666-6666-4666-8666-666666666666', svc: '77777777-7777-4777-8777-777777777777', extra: '88888888-8888-4888-8888-888888888888',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();                 // 슈퍼유저(RLS 우회) — 시드·관찰 전용. BEFORE 트리거는 슈퍼유저에도 돈다
const sqlRaw = (q) => psqlRaw(['-A', '-t', '-c', q]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';        // set_config 출력 뒤 마지막 결과 줄
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };

let ORG, OTHER_ORG, CREW, OTHER_CREW, PUB;
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
  const migrationDir=fileURLToPath(new URL('../supabase/migrations/',import.meta.url));
  for(const f of readdirSync(migrationDir).filter(f=>/^\d+_msgr.*\.sql$/.test(f)).sort()) {
    const source=readFileSync(mig(f),'utf8');
    psql(['-c',source.replace(/^create extension if not exists pg_net;$/m,'')]);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  OTHER_ORG = last(asUser(U.guest, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.guest}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const uid of [U.admin, U.member, U.extra]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  OTHER_CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean', 'theirs', 'Theirs') returning id`));
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}','public','Work')`));
  sql(`update public.msgr_crews set dm_delivery_protocol=1,work_protocol=1,last_seen_at=now(),allow='all',role_text=case when id='${CREW}' then '총괄 moderator' else 'Research' end where org_id='${ORG}'`);

});



const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]); // 봇 RPC는 토큰이 자격 — anon으로 호출
const typingTopics = () => sql(`select coalesce(string_agg(topic, ',' order by id), '') from realtime.sent where event = 'typing'`);
let PRIV, BC, TOKEN, BOT_CREW;
test('setup: 비공개 채널(owner·member)·B↔C DM, 봇을 만들어 공개·비공개 채널에 넣는다', { skip }, () => {
  PRIV = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'private', 'secret', '[{"kind":"user","id":"${U.member}"}]')`));
  BC = last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'dm', 'b-c', '[{"kind":"user","id":"${U.extra}"}]')`));
  const out = JSON.parse(last(asUser(U.owner, `select public.msgr_bot_create('${ORG}', 'hermes', '헤르메스', '외부 에이전트')`)));
  TOKEN = out.token; BOT_CREW = out.crew_id;
  for (const ch of [PUB, PRIV]) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'crew', '${BOT_CREW}') on conflict do nothing`);
  assert.ok(PRIV && BC && TOKEN && BOT_CREW);
});

test('msgr_room_topic: 공개 채널은 org:<조직>, 비공개 채널·DM은 dm:<채널>', { skip }, () => {
  assert.equal(sql(`select public.msgr_room_topic('${PUB}')`), `org:${ORG}`);
  assert.equal(sql(`select public.msgr_room_topic('${PRIV}')`), `dm:${PRIV}`);
  assert.equal(sql(`select public.msgr_room_topic('${BC}')`), `dm:${BC}`);
});

test('봇 typing: 공개 채널은 org:, 비공개 채널은 dm:<채널>로만 — 비공개 방 typing이 조직 토픽으로 나가지 않는다', { skip }, () => {
  sql('delete from realtime.sent');
  assert.equal(asAnonRaw(`select public.msgr_bot_typing('${TOKEN}', '${PUB}')`).status, 0);
  assert.equal(asAnonRaw(`select public.msgr_bot_typing('${TOKEN}', '${PRIV}')`).status, 0);
  assert.equal(typingTopics(), [`org:${ORG}`, `dm:${PRIV}`].join(','));
  assert.equal(sql(`select count(*) from realtime.sent where event = 'typing' and topic like 'org:%' and payload->>'channel_id' = '${PRIV}'`), '0', '비공개 방 typing이 조직 토픽으로 나가지 않는다');
});

test('봇 typing(위임 4인자 판)도 같은 방 토픽 규칙', { skip }, () => {
  sql('delete from realtime.sent');
  assert.equal(asAnonRaw(`select public.msgr_bot_typing('${TOKEN}', '${PRIV}', null::bigint, null::uuid)`).status, 0, '구성원 호출 — 4인자 판');
  assert.equal(typingTopics(), `dm:${PRIV}`);
});

test('수신 정책: dm:<비공개 채널>은 그 방을 읽을 수 있는 사람만 받는다(조직 멤버라도 방 밖이면 0)', { skip }, () => {
  sql(`delete from realtime.messages; insert into realtime.messages (topic, extension, payload) values ('dm:${PRIV}', 'broadcast', '{}')`);
  const recv = (who) => last(asUser(who, `select set_config('realtime.topic', 'dm:${PRIV}', false); select count(*) from realtime.messages`));
  assert.equal(recv(U.member), '1', '방 멤버');
  assert.equal(recv(U.owner), '1', '방 만든 사람(멤버)');
  assert.equal(recv(U.extra), '0', '같은 조직이지만 방 밖');
  assert.equal(recv(U.outsider), '0');
});
