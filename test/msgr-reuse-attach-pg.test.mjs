// 같은 방·같은 내용 첨부 재사용(게이트웨이 deliverReplyFiles, 2026-10-02 분리 검수 M-5) — 재사용 첨부 행은 원본 글의 저장 경로를 가리킨다.
// 2차 검수 N-1: 외부 봇 msgr_bot_file이 경로 3번째 칸 = 그 글 id만 받아 재사용 행에 msgr_bot_no_file을 냈다.
// 고친 판정(20261002231000): 3번째 칸이 "같은 방의, 그 저장 경로를 가진 원본 첨부 행의 글"이면 내준다. 방 경계(1·2번째 칸 = 그 글의 조직·방)는 그대로.
// 하네스는 msgr-bot-attach-pg와 같다(모든 msgr 마이그레이션 적용, auth.uid() 스텁). 실행: scripts/billing-pg-drill.sh <이 파일>
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asAnon = (q) => sql(`set role anon; ${q}`);
const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const j = (s) => JSON.parse(last(s));

let ORG, PUB, OTHER, A, ARGO_CREW;
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
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated;
    grant usage on schema realtime to authenticated;
  `]);
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  for (const f of readdirSync(fileURLToPath(new URL('../supabase/migrations/', import.meta.url))).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort())
    psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.admin}', 'admin'), ('${ORG}', '${U.member}', 'member')`);
  A = JSON.parse(last(asUser(U.owner, `select msgr_bot_create('${ORG}','hermes','pepper','moderator')`)));
  ARGO_CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  sql(`update msgr_crews set allow='all', last_seen_at=now(), dm_delivery_protocol=1 where org_id='${ORG}'`);
  PUB = last(asUser(U.owner, `select msgr_create_channel('${ORG}','public','ops','[]')`));
  OTHER = last(asUser(U.owner, `select msgr_create_channel('${ORG}','public','design','[]')`));
  // 봇·Argo 크루 모두 두 방의 구성원 — 아래 거부가 구성원 판정이 아니라 경로 판정 때문임을 보이려고
  for (const ch of [PUB, OTHER]) for (const id of [A.crew_id, ARGO_CREW]) sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${ch}','crew','${id}') on conflict do nothing`);
});

const crewPost = (ch, body) => last(asUser(U.owner, `insert into msgr_messages(channel_id, author_kind, crew_id, body) values ('${ch}','crew','${ARGO_CREW}','${body}') returning id`));
const attach = (msg, path, name = 'draft.png') => last(asUser(U.owner, `insert into msgr_attachments(message_id, org_id, storage_path, name, mime, bytes) values (${msg}, '${ORG}', '${path}', '${name}', 'image/png', 7) returning id`));
const putObject = (path) => sql(`insert into storage.objects(bucket_id, name, metadata) values ('msgr', '${path}', '{"size": 7, "mimetype": "image/png"}')`);

test('N-1: 같은 방 재사용 첨부 행(원본 글 경로)도 외부 봇이 받는다 — 원본·재사용 모두 같은 저장 경로', { skip }, () => {
  const m1 = crewPost(PUB, '시안');
  const path = `${ORG}/${PUB}/${m1}/0-draft.png`;
  putObject(path);
  const a1 = attach(m1, path);
  const m2 = crewPost(PUB, '다시 보냅니다');
  const a2 = attach(m2, path, '시안-사본.png'); // 게이트웨이 재사용: 새 글에 첨부 행만, 저장 경로는 원본 그대로
  assert.equal(j(asAnon(`select public.msgr_bot_file('${A.token}', '${a1}')`)).storage_path, path, '원본');
  const got = j(asAnon(`select public.msgr_bot_file('${A.token}', '${a2}')`));
  assert.equal(got.storage_path, path, '재사용 행도 내준다');
  assert.equal(got.file_name, '시안-사본.png');
  // 원본 글이 지워져도(삭제 표시) 객체는 남으므로 재사용 행은 그대로 받는다
  sql(`update msgr_messages set deleted_at = now() where id = ${m1}`);
  assert.equal(j(asAnon(`select public.msgr_bot_file('${A.token}', '${a2}')`)).storage_path, path);
});

test('N-1 방 경계: 다른 방 글의 경로를 가리키는 행·원본 첨부 행이 없는 경로는 거부한다', { skip }, () => {
  // 다른 방(OTHER)에 진짜 원본이 있어도, PUB 글에 붙은 행으로는 받을 수 없다(첨부 행 정책은 경로를 묻지 않아 이런 행은 만들어질 수 있다)
  const o1 = crewPost(OTHER, '디자인 방 원본');
  const otherPath = `${ORG}/${OTHER}/${o1}/0-secret.png`;
  putObject(otherPath);
  attach(o1, otherPath, 'secret.png');
  const m3 = crewPost(PUB, '다른 방 경로');
  const cross = attach(m3, otherPath, 'secret.png');
  fails(asAnonRaw(`select public.msgr_bot_file('${A.token}', '${cross}')`), /msgr_bot_no_file/, '다른 방 경로');
  // 방 칸만 PUB으로 바꾼 경로(3번째 칸 = 다른 방 글 id) — 같은 방에 그 경로를 가진 원본 행이 없다
  const forged = `${ORG}/${PUB}/${o1}/0-secret.png`;
  putObject(forged);
  const m4 = crewPost(PUB, '꾸민 경로');
  fails(asAnonRaw(`select public.msgr_bot_file('${A.token}', '${attach(m4, forged, 'f.png')}')`), /msgr_bot_no_file/, '3번째 칸이 다른 방 글');
  // 같은 방 글 id지만 그 글에 그 경로의 원본 첨부 행이 없다
  const m5 = crewPost(PUB, '첨부 없는 글');
  const orphan = `${ORG}/${PUB}/${m5}/0-orphan.png`;
  putObject(orphan);
  const m6 = crewPost(PUB, '원본 없는 재사용');
  fails(asAnonRaw(`select public.msgr_bot_file('${A.token}', '${attach(m6, orphan, 'o.png')}')`), /msgr_bot_no_file/, '원본 첨부 행 없음');
});
