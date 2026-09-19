// 사람 답글의 thread_root는 부모의 뿌리를 따라간다(D38, 20260919090000). 검수 재현: 멘션 → 크루 답 → 사람이 [답글] → 크루가 받는다.
// 종전 트리거는 thread_root를 바로 위 부모(크루 글)로 채워 msgr_delivery_allowed의 "뿌리가 사람 글" 조건에 막혔다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-reply-thread-root-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { psqlSpawn } from './helpers/pg.mjs';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-reply-thread-root-pg.test.mjs';
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


const say = (uid, ch, body, extra = {}) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, reply_to, thread_root, client_msg_id)
  values ('${ch}', 'user', '${uid}', 'text', '${body}', '${JSON.stringify(extra.mentions ?? [])}'::jsonb, ${extra.reply_to ?? 'null'}, ${extra.thread_root ?? 'null'}, gen_random_uuid()::text) returning id`));
const crewSay = (crew, ch, body, reply_to, thread_root) => last(sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, reply_to, thread_root, client_msg_id)
  values ('${ch}', 'crew', '${crew}', 'text', '${body}', ${reply_to ?? 'null'}, ${thread_root ?? 'null'}, gen_random_uuid()::text) returning id`));
const rootOf = (id) => sql(`select coalesce(thread_root::text, 'null') from public.msgr_messages where id = ${id}`);

test('검수 재현: 멘션 → 크루 답 → 사람 [답글](멘션 없음) → 뿌리는 처음 사람 글이고 크루에게 배달된다', { skip }, () => {
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${PUB}', '${HOSTC}')`)), 'joined');
  const m1 = say(U.mate, PUB, '@hostc 지난달 매출 요약', { mentions: [{ kind: 'crew', id: HOSTC }] });
  const a1 = crewSay(HOSTC, PUB, '요약입니다', m1, m1); // 브리지가 넣는 모양(reply_to=지시, thread_root=뿌리)
  const r1 = say(U.mate, PUB, '조금 더 자세히', { reply_to: a1 });
  assert.equal(rootOf(r1), String(m1), '사람 답글의 뿌리 = 처음 사람 글(종전: 크루 글 a1)');
  assert.equal(sql(`select public.msgr_delivery_target('${HOSTC}', ${r1})`), 't', '답한 대상 크루가 배달 대상');
  assert.equal(sql(`select public.msgr_delivery_allowed('${HOSTC}', ${r1})`), 't', '뿌리가 사람 글이라 배달 허용');
  // 답글의 답글도 같은 뿌리
  const a2 = crewSay(HOSTC, PUB, '자세한 요약', r1, m1);
  const r2 = say(U.mate, PUB, '고마워요, 표로도', { reply_to: a2 });
  assert.equal(rootOf(r2), String(m1), '두 번째 답글도 같은 뿌리');
  assert.equal(sql(`select public.msgr_delivery_allowed('${HOSTC}', ${r2})`), 't');
  const r3 = say(U.host, PUB, '저도 궁금', { reply_to: r2 });
  assert.equal(rootOf(r3), String(m1), '사람 답글에 단 사람 답글도 같은 뿌리');
});

test('종전 모양 유지: 새 글은 뿌리 없음, 사람 글에 단 답글의 뿌리는 그 글, 명시한 뿌리는 그대로', { skip }, () => {
  const top = say(U.host, PUB, '새 주제');
  assert.equal(rootOf(top), 'null', '새 글은 뿌리가 비어 있다');
  const rep = say(U.mate, PUB, '답', { reply_to: top });
  assert.equal(rootOf(rep), String(top), '뿌리가 없는 부모에 단 답글 = 부모');
  const other = say(U.host, PUB, '다른 주제');
  const explicit = say(U.mate, PUB, '명시', { reply_to: rep, thread_root: other });
  assert.equal(rootOf(explicit), String(other), '명시한 thread_root는 트리거가 덮어쓰지 않는다');
});

test('정책 유지: 크루가 먼저 올린 글에 단 사람 답글은 뿌리가 크루 글이라 배달되지 않는다', { skip }, () => {
  const post = crewSay(HOSTC, PUB, '크루가 먼저 올린 공지', null, null);
  const r = say(U.mate, PUB, '공지에 답', { reply_to: post });
  assert.equal(rootOf(r), String(post), '뿌리 = 크루 글');
  assert.equal(sql(`select public.msgr_delivery_allowed('${HOSTC}', ${r})`), 'f', '"봇이 먼저 올린 글" 허용은 이번 범위 밖');
});

test('다른 채널 글에 답글은 종전처럼 거절', { skip }, () => {
  const inPriv = say(U.host, PRIV, '비공개 글');
  fails(asUserRaw(U.mate, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, reply_to, client_msg_id) values ('${PUB}', 'user', '${U.mate}', 'text', 'x', ${inPriv}, gen_random_uuid()::text)`), /msgr_reply_cross_channel/, '채널 넘는 답글');
});

test('외부 봇(getUpdates): 봇 답에 사람이 [답글]만 달아도(멘션 없음) 봇의 다음 업데이트에 온다', { skip }, () => {
  const asAnon = (q) => sql(`set role anon; ${q}`);
  const out = JSON.parse(last(asUser(U.host, `select public.msgr_bot_create('${ORG}', 'hermes', '헤르메스', '외부 에이전트')`)));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PUB}', 'crew', '${out.crew_id}') on conflict do nothing`);
  const updates = (after) => asAnon(`select public.msgr_bot_updates_with_delivery('${out.token}', ${after})`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const q = say(U.mate, PUB, '@헤르메스 질문', { mentions: [{ kind: 'crew', id: out.crew_id }] });
  assert.ok(updates(0).some((u) => String(u.update_id) === String(q)), '멘션은 온다');
  const a = crewSay(out.crew_id, PUB, '봇 답', q, q);
  const r = say(U.mate, PUB, '조금 더', { reply_to: a });
  assert.deepEqual(updates(q).map((u) => String(u.update_id)), [String(r)], '멘션 없는 답글이 봇에게 배달된다(종전: 뿌리가 봇 글이라 거절)');
});
