// 외부 봇 개인 방 파일 주고받기(20261002140000) — 유건 2026-10-02.
// 고정: 쌍둥이가 든 개인 방 쌍둥이 글에는 p/ 경로로 붙는다 / 쌍둥이가 없는 방·남의 글·다른 봇·멈춘 쌍둥이는 거절 / 경로 바꿔치기 거절 /
// 조직 방은 기존대로(조직 경로·org_id) / 받기는 주인 글·주인 크루 글만(친구 글 파일 거절) / 개인 배달에 주인 글 첨부가 실린다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-bot-personal-attach-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };

const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asAnon = (q) => sql(`set role anon; ${q}`);
const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 240)}`); };
const q = (s) => s.replace(/'/g, "''");
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
const twinOf = (bot) => sql(`select crew_id from public.msgr_bot_personal where bot_id = '${bot}'`);
const mkBot = (uid, org, name) => JSON.parse(last(asUser(uid, `select public.msgr_bot_create('${org}', 'hermes', '${name}', null, null)`)));
const say = (token, ch, body = '보고서입니다') => { const r = asAnonRaw(`select public.msgr_bot_send('${token}', '${ch}', '${q(body)}')`); assert.equal(r.status, 0, `봇 글 거절(${body}): ${r.stderr}`); return last(r.stdout); };
const prepareRaw = (token, mid, name = '보고서 최종.pdf', bytes = 1234) => asAnonRaw(`select public.msgr_bot_attach_prepare('${token}', ${mid}, '${q(name)}', ${bytes})`);
const prepare = (token, mid, name, bytes) => { const r = prepareRaw(token, mid, name, bytes); assert.equal(r.status, 0, r.stderr); return JSON.parse(last(r.stdout)).storage_path; };
const putObject = (path, size = 1234) => sql(`insert into storage.objects (bucket_id, name, metadata) values ('msgr', '${path}', jsonb_build_object('size', ${size}, 'mimetype', 'application/pdf'))`);
const commitRaw = (token, mid, path, name = '보고서 최종.pdf') => asAnonRaw(`select public.msgr_bot_attach_commit('${token}', ${mid}, '${q(path)}', '${q(name)}', null)`);
const fileRaw = (token, att) => asAnonRaw(`select public.msgr_bot_file('${token}', '${att}')`);
const ups = (token, after = 0) => asAnon(`select public.msgr_bot_updates('${token}', ${after}, 20)`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
// 사람이 개인 방에 파일을 올리는 경로(20261002100000 정책) — 사용자 권한으로 객체·첨부 행
function userFile(uid, ch, body, mentions = '[]') {
  const mid = last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${q(body)}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
  const path = `p/${ch}/${mid}/u-0-photo.png`;
  asUser(uid, `insert into storage.objects (bucket_id, name, owner) values ('msgr', '${path}', '${uid}')`);
  sql(`update storage.objects set metadata = jsonb_build_object('size', 10, 'mimetype', 'image/png') where name = '${path}'`);
  const att = last(asUser(uid, `insert into public.msgr_attachments (message_id, org_id, storage_path, name, mime, bytes) values (${mid}, null, '${path}', 'photo.png', 'image/png', 10) returning id`));
  return { mid, att, path };
}

let ORG, PUB, BOT, TOKEN, BC, TW, BOT2, TOKEN2, CR, AB;
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
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz not null default now());
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
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'public', 'pub')`));
  for (const u of [U.a, U.b]) asUser(u, `select public.msgr_set_ai_consent(true)`);
  befriend(U.a, U.b);
  const out = mkBot(U.a, ORG, 'Hermes'); BOT = out.bot_id; TOKEN = out.token; BC = out.crew_id; TW = twinOf(BOT);
  const out2 = mkBot(U.a, ORG, 'Claw'); BOT2 = out2.bot_id; TOKEN2 = out2.token;
  asUser(U.a, `select public.msgr_crew_join('${PUB}', '${BC}')`);
  CR = last(asUser(U.a, `select public.msgr_dm_personal_crew('${TW}')`)); // 쌍둥이 1:1
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));     // 친구 방(처음엔 쌍둥이 없음)
});

test('쌍둥이가 든 개인 방 — 쌍둥이 글에 p/<방>/<글>/bot- 경로로 붙고 첨부 행 org_id NULL, 주인이 읽는다', { skip }, () => {
  const mid = say(TOKEN, CR);
  const path = prepare(TOKEN, mid);
  assert.match(path, new RegExp(`^p/${CR}/${mid}/bot-[0-9a-f]{8}-.+\\.pdf$`));
  putObject(path);
  const r = commitRaw(TOKEN, mid, path); assert.equal(r.status, 0, r.stderr);
  const att = last(r.stdout);
  assert.equal(sql(`select coalesce(org_id::text,'NULL')||'|'||storage_path from public.msgr_attachments where id = '${att}'`), `NULL|${path}`);
  assert.equal(last(commitRaw(TOKEN, mid, path).stdout), att, '같은 경로를 다시 등록하면 같은 id(재시도 안전)');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_attachments where message_id = ${mid}`), '1', '주인은 첨부 행을 본다');
  assert.equal(asUser(U.a, `select count(*) from storage.objects where name = '${path}'`), '1', '주인은 파일을 읽는다(기존 채널 열람 정책)');
});

test('거절 — 쌍둥이가 없는 방, 남의 글, 다른 봇, 경로 바꿔치기, 1시간 지난 글, 멈춘 쌍둥이', { skip }, () => {
  fails(asAnonRaw(`select public.msgr_bot_send('${TOKEN}', '${AB}', 'x')`), /msgr_bot_not_member/, '쌍둥이가 없는 방에는 글도 못 쓴다(기존)');
  const stray = last(psql(['-A', '-t', '-c', `set session_replication_role = replica; insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${AB}', 'crew', '${TW}', 'text', 'x', gen_random_uuid()::text) returning id`]));
  fails(prepareRaw(TOKEN, stray), /msgr_bot_not_member/, '쌍둥이가 구성원이 아닌 방의 글');
  const mine = say(TOKEN, CR, '내 글');
  fails(prepareRaw(TOKEN2, mine), /msgr_bot_bad_attach_target|msgr_not_allowed/, '같은 주인의 다른 봇도 남의 쌍둥이 글에는 못 붙인다');
  const human = last(asUser(U.a, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${CR}', 'user', '${U.a}', 'text', '사람 글', gen_random_uuid()::text) returning id`));
  fails(prepareRaw(TOKEN, human), /msgr_bot_bad_attach_target/, '사람 글에는 못 붙인다');
  const p = prepare(TOKEN, mine); putObject(p);
  fails(commitRaw(TOKEN, mine, p.replace(`p/${CR}/`, `p/${AB}/`)), /msgr_bot_bad_attach_path/, '다른 방 경로로 바꿔치기');
  fails(commitRaw(TOKEN, mine, p.replace('p/', `${ORG}/`)), /msgr_bot_bad_attach_path/, '조직 경로로 바꿔치기');
  const old = say(TOKEN, CR, '옛 글');
  sql(`update public.msgr_messages set created_at = now() - interval '2 hours' where id = ${old}`);
  fails(prepareRaw(TOKEN, old), /msgr_bot_attach_expired/, '1시간 지난 글');
  sql(`update public.msgr_bot_personal set pin_hash = 'x' where bot_id = '${BOT}'`);
  fails(prepareRaw(TOKEN, mine), /msgr_not_allowed/, '다시 연결이 필요한(멈춘) 쌍둥이');
  sql(`update public.msgr_bot_personal p set pin_hash = b.token_hash from public.msgr_bots b where b.id = p.bot_id and p.bot_id = '${BOT}'`);
});

test('친구 방에 쌍둥이를 넣으면 거기서도 붙는다, 빼면 다시 거절', { skip }, () => {
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join('${AB}', '${TW}')`)), 'joined');
  const mid = say(TOKEN, AB, '친구 방 보고');
  const path = prepare(TOKEN, mid);
  assert.match(path, new RegExp(`^p/${AB}/${mid}/bot-`));
  putObject(path);
  assert.equal(commitRaw(TOKEN, mid, path).status, 0);
  assert.equal(asUser(U.b, `select count(*) from storage.objects where name = '${path}'`), '1', '친구도 읽는다');
  const mid2 = say(TOKEN, AB, '두 번째');
  sql(`delete from public.msgr_channel_members where channel_id = '${AB}' and member_kind = 'crew' and member_id = '${TW}'`);
  fails(prepareRaw(TOKEN, mid2), /msgr_bot_not_member/, '방에서 빠지면 거절');
});

test('조직 방은 기존대로 — 조직 경로·org_id, 쌍둥이 글 규칙과 섞이지 않는다', { skip }, () => {
  const mid = say(TOKEN, PUB, '조직 보고');
  const path = prepare(TOKEN, mid, 'report.pdf');
  assert.match(path, new RegExp(`^${ORG}/${PUB}/${mid}/bot-[0-9a-f]{8}-report\\.pdf$`));
  putObject(path);
  const att = last(commitRaw(TOKEN, mid, path).stdout);
  assert.equal(sql(`select org_id from public.msgr_attachments where id = '${att}'`), ORG);
  fails(commitRaw(TOKEN, mid, path.replace(`${ORG}/`, 'p/')), /msgr_bot_bad_attach_path/, '조직 글에 개인 경로');
  const f = JSON.parse(last(fileRaw(TOKEN, att).stdout));
  assert.equal(f.storage_path, path, '조직 받기(getFile)도 그대로');
});

test('받기 — 주인 글 파일은 내주고 배달에도 실린다, 친구 글 파일·쌍둥이 없는 방은 거절', { skip }, () => {
  const own = userFile(U.a, CR, '이 사진 봐');
  const f = JSON.parse(last(fileRaw(TOKEN, own.att).stdout));
  assert.equal(f.storage_path, own.path);
  assert.equal(f.file_name, 'photo.png');
  const item = ups(TOKEN).find((u) => u.message?.message_id === Number(own.mid));
  assert.ok(item, '주인 글이 개인 배달에 온다');
  assert.deepEqual(item.message.attachments.map((x) => x.file_id), [own.att], '배달에 첨부 id가 실린다(종전에는 항상 [])');
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join('${AB}', '${TW}')`)), 'joined');
  const friend = userFile(U.b, AB, '친구 사진');
  fails(fileRaw(TOKEN, friend.att), /msgr_bot_no_file/, '친구 글의 파일은 id를 알아도 내주지 않는다');
  sql(`delete from public.msgr_channel_members where channel_id = '${AB}' and member_kind = 'crew' and member_id = '${TW}'`);
  const later = userFile(U.a, AB, '쌍둥이가 나간 뒤');
  fails(fileRaw(TOKEN, later.att), /msgr_bot_not_member/, '쌍둥이가 없는 방의 파일');
  fails(fileRaw(TOKEN2, own.att), /msgr_bot_not_member|msgr_not_allowed/, '다른 봇(다른 쌍둥이)은 그 방 파일을 못 받는다');
});
