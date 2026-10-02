// 링크 미리보기 저장(20261002110000) — 보낼 때 한 번만, 작성자만, meta.link_preview 칸만.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-link-preview-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: 'aaaaaaaa-1111-4111-8111-111111111111', b: 'bbbbbbbb-2222-4222-8222-222222222222', c: 'cccccccc-3333-4333-8333-333333333333' };

const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const q = (s) => s.replace(/'/g, "''");
const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${q(body)}', gen_random_uuid()::text) returning id`));
const P = (o = {}) => JSON.stringify({ v: 1, url: 'https://example.com/a', title: '제목', description: '설명', image: 'https://img.example/a.png', site: '예시', ...o });
const setRaw = (uid, mid, preview) => asUserRaw(uid, `select public.msgr_set_link_preview(${mid}, '${q(preview)}'::jsonb)`);
const set = (uid, mid, preview = P()) => { const r = setRaw(uid, mid, preview); assert.equal(r.status, 0, r.stderr); return last(r.stdout); };

let ORG, PUB, AB;
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
    create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  PUB = last(asUser(U.a, `select msgr_create_channel('${ORG}','public','ops','[]')`));
  asUser(U.a, `select public.msgr_friend_request('${U.b}')`); asUser(U.b, `select public.msgr_friend_decide('${U.a}', true)`);
  asUser(U.a, `select public.msgr_friend_request('${U.c}')`); asUser(U.c, `select public.msgr_friend_decide('${U.a}', true)`);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
});

test('작성자가 보낸 직후 한 번 저장 — 1:1(dm)에서도 link_preview 칸만 바뀌고 방송이 나간다', { skip }, () => {
  const m = post(U.a, AB, '이거 봐 https://example.com/a 재밌음');
  assert.equal(set(U.a, m), 't');
  assert.deepEqual(JSON.parse(sql(`select meta->'link_preview' from public.msgr_messages where id = ${m}`)),
    { v: 1, url: 'https://example.com/a', title: '제목', description: '설명', image: 'https://img.example/a.png', site: '예시' });
  assert.equal(sql(`select count(*) from realtime.sent where event = 'edit' and topic = 'dm:${AB}' and (payload->>'message_id')::bigint = ${m}`), '1');
  assert.equal(asUser(U.b, `select meta->'link_preview'->>'title' from public.msgr_messages where id = ${m}`), '제목', '상대도 같은 카드를 읽는다(다시 가져오지 않는다)');
  assert.equal(set(U.a, m, P({ title: '두 번째' })), 'f', '한 번만 — 이미 있으면 그대로');
  assert.equal(sql(`select meta->'link_preview'->>'title' from public.msgr_messages where id = ${m}`), '제목');
});

test('조직 공개 채널 — 조직 토픽으로 방송', { skip }, () => {
  const m = post(U.a, PUB, 'https://example.com/a');
  assert.equal(set(U.a, m), 't');
  assert.equal(sql(`select count(*) from realtime.sent where event = 'edit' and topic = 'org:${ORG}' and (payload->>'message_id')::bigint = ${m}`), '1');
});

test('남의 글·지운 글·10분 지난 글·나간 방은 저장하지 않는다', { skip }, () => {
  const m = post(U.a, AB, 'https://example.com/a');
  fails(setRaw(U.b, m, P()), /msgr_forbidden/, '상대가 남의 글에');
  fails(setRaw(U.c, m, P()), /msgr_forbidden/, '방 밖 사람(친구여도)');
  const old = post(U.a, AB, 'https://example.com/a');
  sql(`update public.msgr_messages set created_at = now() - interval '11 minutes' where id = ${old}`);
  assert.equal(set(U.a, old), 'f', '10분 지난 글');
  const del = post(U.a, AB, 'https://example.com/a');
  sql(`update public.msgr_messages set deleted_at = now() where id = ${del}`);
  assert.equal(set(U.a, del), 'f', '지운 글');
  const g = last(asUser(U.a, `select public.msgr_dm_personal_group(array['${U.b}','${U.c}']::uuid[], 'abc-group')`));
  const gm = post(U.a, g, 'https://example.com/a');
  asUser(U.a, `select public.msgr_leave_dm('${g}')`);
  assert.equal(set(U.a, gm), 'f', '나간 방');
});

test('모양 검사 — 본문에 없는 주소·모르는 키·긴 제목·http 이미지·빈 카드는 거절', { skip }, () => {
  const m = post(U.a, AB, '링크 https://example.com/a 끝');
  for (const [bad, label] of [
    [P({ url: 'https://evil.example/' }), '본문에 없는 주소'], [P({ url: 'javascript:alert(1)' }), 'http(s) 아님'],
    [JSON.stringify({ url: 'https://example.com/a', title: 't', html: '<b>' }), '모르는 키'], [P({ title: 'x'.repeat(201) }), '긴 제목'],
    [P({ description: 'x'.repeat(301) }), '긴 설명'], [P({ site: 'x'.repeat(81) }), '긴 사이트 이름'], [P({ image: 'http://img.example/a.png' }), 'http 이미지'],
    [P({ title: '', description: '' }), '빈 카드'], [P({ title: 7 }), '문자열 아님'], ['[1,2]', '객체 아님'],
  ]) fails(setRaw(U.a, m, bad), /msgr_bad_preview/, label);
  assert.equal(set(U.a, m, P({ image: '' })), 't', '이미지 없는 카드는 된다');
});

test('link_preview 칸은 RPC로만 — 일반 수정으로 넣거나 바꾸지 못한다(다른 수정은 그대로)', { skip }, () => {
  const m = post(U.a, PUB, 'https://example.com/a');
  fails(asUserRaw(U.a, `update public.msgr_messages set meta = '{"link_preview":{"title":"가짜"}}'::jsonb where id = ${m}`), /msgr_link_preview_rpc_only/, '직접 넣기');
  assert.equal(set(U.a, m), 't');
  fails(asUserRaw(U.a, `update public.msgr_messages set meta = meta - 'link_preview' where id = ${m}`), /msgr_link_preview_rpc_only/, '직접 지우기');
  asUser(U.a, `update public.msgr_messages set body = 'https://example.com/a 고침', edited_at = now() where id = ${m}`);
  assert.equal(sql(`select body from public.msgr_messages where id = ${m}`), 'https://example.com/a 고침', '본문 고치기는 그대로');
  const dm = post(U.a, AB, 'x');
  fails(asUserRaw(U.a, `update public.msgr_messages set meta = '{"relay":1}'::jsonb where id = ${dm}`), /msgr_dm_routing_immutable/, '1:1 meta 직접 변경은 종전대로 막힌다');
});

test('에이전트 글은 insert 때 meta에 싣는다(가드 대상 밖)', { skip }, () => {
  const crew = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.a}', 'ws-aaaa', 'c1', 'C1', 'local', 'active', 'owner') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PUB}', 'crew', '${crew}') on conflict do nothing`);
  const r = asUserRaw(U.a, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, meta, client_msg_id) values ('${PUB}', 'crew', '${crew}', 'text', 'https://example.com/a', '{"link_preview":${q(P())}}'::jsonb, gen_random_uuid()::text) returning id`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sql(`select meta->'link_preview'->>'site' from public.msgr_messages where id = ${last(r.stdout)}`), '예시');
});
