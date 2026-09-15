// 아이콘 배지 셈법(DM 안읽음 + 나를 멘션한 글)과 재동기화 RPC(msgr_push_badge_resync → net.http_post badge_user). 실행: bash scripts/billing-pg-drill.sh test/msgr-push-badge-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-push-badge-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
let ORG, PUB, DM;
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
  `]);
  // pg_net 가짜 — 호출을 표에 기록한다(재동기화가 실제로 큐에 넣는지 본다)
  sql(`create schema net; create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb); create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ insert into net.calls (url, headers, body) values (url, headers, body) returning id $$; grant usage on schema net to authenticated;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
  assert.equal(last(asUser(U.b, `select public.msgr_accept_invite('${code}')`)), ORG);
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','Work')`));
  DM = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','dm','dm:b','[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
  sql(`insert into public.msgr_settings (key, value) values ('push_url', 'https://edge.test/msgr-push') on conflict (key) do update set value = excluded.value`);
});
const post = (uid, ch, body, mentions = '[]', replyTo = null) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id, mentions, reply_to) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text, '${mentions}'::jsonb, ${replyTo ?? 'null'}) returning id`));
const total = (uid) => Number(sql(`select public.msgr_push_unread_total('${uid}')`));

test('배지 셈법 — 공개 채널 잡담은 세지 않고, DM 안읽음과 나를 멘션한 글만 센다; 읽음 커서가 지나면 0', { skip }, () => {
  assert.equal(total(U.b), 0);
  post(U.a, PUB, '잡담 1'); post(U.a, PUB, '잡담 2');
  assert.equal(total(U.b), 0, '공개 채널 잡담은 배지가 아니다(알림함과 같은 뜻)');
  const m = post(U.a, PUB, '@b 봐줘', `[{"kind":"user","id":"${U.b}"}]`);
  assert.equal(total(U.b), 1, '나를 멘션한 글은 센다');
  const d1 = post(U.a, DM, 'dm 1'); post(U.a, DM, 'dm 2');
  assert.equal(total(U.b), 3, 'DM 안읽음 2 + 멘션 1');
  assert.equal(total(U.a), 0, '내가 쓴 글은 내 배지가 아니다');
  asUser(U.b, `insert into public.msgr_reads (channel_id, user_id, last_read_id) values ('${DM}', '${U.b}', ${d1}) on conflict (channel_id, user_id) do update set last_read_id = excluded.last_read_id`);
  assert.equal(total(U.b), 2, 'DM 첫 글까지 읽음 → dm 1개 + 멘션 1');
  asUser(U.b, `insert into public.msgr_reads (channel_id, user_id, last_read_id) values ('${PUB}', '${U.b}', ${m}), ('${DM}', '${U.b}', ${d1} + 1) on conflict (channel_id, user_id) do update set last_read_id = excluded.last_read_id`);
  assert.equal(total(U.b), 0, '다 읽으면 0');
  // 내 글에 달린 답글은 센다(푸시 수신자 규칙과 같음 — 검수 #540 M-5), 남의 글에 달린 답글은 안 센다
  const mine = post(U.b, PUB, '내 글');
  post(U.a, PUB, '답글', '[]', mine);
  assert.equal(total(U.b), 1, '내 글에 달린 답글');
  const theirs = post(U.a, PUB, '남 글'); post(U.a, PUB, '남 글에 답글', '[]', theirs);
  assert.equal(total(U.b), 1, '남의 글에 달린 답글은 배지가 아니다');
  // 읽음 커서는 뒤로 가지 않는다(클라이언트 "모두 읽음"이 오래된 id를 보내도)
  asUser(U.b, `update public.msgr_reads set last_read_id = 1 where channel_id = '${DM}' and user_id = '${U.b}'`);
  assert.equal(sql(`select last_read_id from public.msgr_reads where channel_id = '${DM}' and user_id = '${U.b}'`), String(Number(d1) + 1), '커서 후퇴 무시');
});

test('msgr_push_badge_resync — 익명·iOS 토큰 없음은 no-op, iOS 토큰이 있으면 badge_user 호출을 큐에 넣는다(트리거와 같은 헤더)', { skip }, () => {
  const r0 = psqlRaw(['-A', '-t', '-c', `set role authenticated; select public.msgr_push_badge_resync()`]);
  assert.equal(r0.status, 0, '익명은 던지지 않는다'); assert.equal(sql(`select count(*) from net.calls where body->>'badge_user' is not null`), '0');
  asUser(U.b, `select public.msgr_push_badge_resync()`);
  assert.equal(sql(`select count(*) from net.calls where body->>'badge_user' = '${U.b}'`), '0', 'iOS 토큰이 없으면 보내지 않는다');
  asUser(U.b, `select public.msgr_push_register('ios', 'tok-b-0123456789abcdef', 'phone')`);
  asUser(U.b, `select public.msgr_push_badge_resync()`);
  assert.equal(sql(`select count(*) from net.calls where body->>'badge_user' = '${U.b}'`), '1', '재동기화 1건 큐잉');
  assert.equal(sql(`select url from net.calls where body->>'badge_user' = '${U.b}' order by id desc limit 1`), 'https://edge.test/msgr-push');
  assert.equal(sql(`select headers = public.msgr_push_headers() from net.calls where body->>'badge_user' = '${U.b}' order by id desc limit 1`), 't', '트리거와 같은 헤더(공유 비밀 포함)');
  asUser(U.b, `select public.msgr_push_badge_resync()`); asUser(U.b, `select public.msgr_push_badge_resync()`);
  assert.equal(sql(`select count(*) from net.calls where body->>'badge_user' = '${U.b}'`), '1', '5초 안 재호출은 서버가 막는다(검수 M-7)');
  sql(`update public.msgr_push_tokens set badge_sync_at = now() - interval '6 seconds' where user_id = '${U.b}'`);
  asUser(U.b, `select public.msgr_push_badge_resync()`);
  assert.equal(sql(`select count(*) from net.calls where body->>'badge_user' = '${U.b}'`), '2', '5초 지나면 다시 보낸다');
  const r1 = psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_push_badge_resync()`]);
  assert.notEqual(r1.status, 0, 'anon 역할은 실행 권한 없음');
});
