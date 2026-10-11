// Pro 첨부 상한(20261012120000) — 유건 2026-10-12 "프로도 용량 제한, 20GB · 파일 상한 500MB".
// 고정하는 것: Pro 총량 키(pro_storage_limit_bytes)가 없으면 Pro는 무제한(무료 키와 독립) / 켜면 Pro도 쓴 양 + 이번 크기로 막힌다 /
// 파일 하나 상한은 무료 25MB · Pro·체험 500MB를 플랜으로 나눈다(is_pro_for) / 유료 조직 손님(좌석 없음)은 무료와 같다 /
// 파일 초과는 PT413(msgr_file_too_large), 총량 초과는 PT402(msgr_storage_limit)로 구분된다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-pro-storage-limit-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const id = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
// f = 무료(30일 전 가입 — 체험 끝), x = 친구(무료), p = Pro 결제, t = 체험 중(3일 전 가입), s = 유료 조직 멤버(Pro), q = 유료 조직 손님(무료)
const U = { f: id(1), x: id(2), p: id(3), t: id(4), s: id(5), q: id(6) };

const psql = (args) => { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; };
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlSpawn(DB, ['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };

const setKey = (key, v) => v == null ? sql(`delete from public.msgr_settings where key = '${key}'`)
  : sql(`insert into public.msgr_settings (key, value) values ('${key}', '${v}') on conflict (key) do update set value = excluded.value`);
const setFree = (v) => setKey('free_storage_limit_bytes', v);
const setPro = (v) => setKey('pro_storage_limit_bytes', v);
const post = (uid, ch) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', 'x', gen_random_uuid()::text) returning id`));
const befriend = (a, b) => { asUser(a, `select public.msgr_friend_request('${b}')`); asUser(b, `select public.msgr_friend_decide('${a}', true)`); };
const uploadRaw = (uid, path, declared) => asUserRaw(uid, `insert into storage.objects (bucket_id, name, owner, metadata) values ('msgr', '${path}', '${uid}', '${JSON.stringify({ contentLength: declared })}')`);
const fill = (path, size) => sql(`update storage.objects set metadata = jsonb_build_object('size', ${size}, 'mimetype', 'application/octet-stream') where bucket_id = 'msgr' and name = '${path}'`);
const attachRaw = (uid, mid, path, bytes = 1) => asUserRaw(uid, `insert into public.msgr_attachments (message_id, org_id, storage_path, name, mime, bytes) values (${mid}, null, '${path}', 'a.bin', 'application/octet-stream', ${bytes})`);
let seq = 0;
function send(uid, ch, size, { declared = size } = {}) { // 앱 한 파일 전송 = 업로드(정책·신고 크기) → 크기 채움 → 첨부 행(트리거·실제 크기)
  const m = post(uid, ch);
  const path = `p/${ch}/${m}/${++seq}-f.bin`;
  const up = uploadRaw(uid, path, declared);
  if (up.status !== 0) return { m, path, up };
  fill(path, size);
  return { m, path, up, att: attachRaw(uid, m, path) };
}
const sendOk = (uid, ch, size) => { const r = send(uid, ch, size); assert.equal(r.up.status, 0, `업로드 거절: ${r.up.stderr}`); assert.equal(r.att.status, 0, `첨부 행 거절: ${r.att.stderr}`); return r; };

let PAID_CH; const DM = {};
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
    alter table storage.objects add column if not exists owner_id text, add column if not exists archived_at timestamptz,
      add column if not exists is_delete_marker boolean not null default false, add column if not exists is_versioned boolean not null default false;
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
  for (const [k, uid] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${uid}', now() - interval '${k === 't' ? 3 : 30} days', '${k}@example.test') on conflict do nothing`);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  sql(`insert into public.entitlements (user_id, plan) values ('${U.p}', 'pro') on conflict (user_id) do update set plan = 'pro'`);
  // 유료 조직(좌석 결제) — s는 멤버(Pro), q는 손님(무료)
  const paid = last(asUser(U.s, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Paid', 'paid-org', '${U.s}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10, paid_until = now() + interval '30 days' where org_id = '${paid}'`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${paid}', '${U.q}', 'guest') on conflict do nothing`);
  PAID_CH = last(asUser(U.s, `select msgr_create_channel('${paid}','public','paid-ops','[]')`));
  for (const k of Object.keys(U)) if (k !== 'x') { befriend(U[k], U.x); DM[k] = last(asUser(U[k], `select public.msgr_dm_personal('${U.x}')`)); }
});

test('Pro 총량 키가 없으면 Pro는 무제한, 무료만 free 키로 막힌다 — 두 스위치는 독립', { skip }, () => {
  setFree(10000); setPro(null);
  try {
    sendOk(U.p, DM.p, 50000000); // Pro는 50MB도 받는다(총량 꺼짐)
    sendOk(U.f, DM.f, 4000);
    fails(send(U.f, DM.f, 7000).up, /msgr_storage_limit/, '무료는 10000에서 막힌다');
  } finally { setFree(null); }
});

test('Pro 총량 키를 켜면 Pro도 쓴 양 + 이번 크기로 막힌다 — 무료 한도와 따로', { skip }, () => {
  setFree(null);
  const u0 = Number(sql(`select public._msgr_storage_used('${U.p}')`)); // 앞 시험에서 p가 올린 양이 남아 있다(같은 DB)
  setPro(u0 + 20000000);
  try {
    sendOk(U.p, DM.p, 19000000);
    fails(send(U.p, DM.p, 2000000).up, /msgr_storage_limit/, 'Pro 한도(시험 값) 초과');
    sendOk(U.p, DM.p, 1000000); // 한도까지는 받는다
    sendOk(U.f, DM.f, 20000000); sendOk(U.f, DM.f, 20000000); // 무료 키는 꺼짐 — 무료는 총량 무제한(파일 하나 상한 25MB 안에서)
  } finally { setPro(null); }
});

test('파일 하나 상한은 플랜별 — 무료 25MB+1은 PT413으로 거절, Pro·체험은 500MB까지 받는다', { skip }, () => {
  setFree(null); setPro(null); // 총량은 둘 다 꺼짐 — 파일 상한만 본다
  const big = send(U.f, DM.f, 26214401);
  fails(big.up, /msgr_file_too_large/, '무료 25MB+1 — 업로드 단계에서 거절');
  const st = asUserRaw(U.f, `do $$ begin perform public.msgr_upload_check('{"metadata": {"contentLength": 26214401}}'::jsonb); exception when others then raise exception 'state=%', sqlstate; end $$`);
  assert.match(st.stderr, /state=PT413/, '파일 초과는 PT413 — 총량(PT402)과 구분된다');
  assert.equal(sql(`select count(*) from storage.objects where name = '${big.path}'`), '0', '거절된 업로드는 객체를 남기지 않는다');
  sendOk(U.f, DM.f, 26214400); // 무료도 25MB까지는 된다
  sendOk(U.p, DM.p, 524288000); // Pro는 500MB
  fails(send(U.p, DM.p, 524288001).up, /msgr_file_too_large/, 'Pro도 500MB+1은 거절');
  sendOk(U.t, DM.t, 100000000); // 체험 중은 Pro와 같다
});

test('첨부 행 트리거는 두 키를 모두 본다 — 무료 꺼짐 + Pro 켜짐에서 과소 신고한 Pro는 실제 크기로 막힌다(분리 검수 M1)', { skip }, () => {
  setFree(null);
  const u0 = Number(sql(`select public._msgr_storage_used('${U.p}')`));
  setPro(u0 + 10000000);
  try {
    const r = send(U.p, DM.p, 12000000, { declared: 1000 }); // 1KB라고 신고 — 업로드 정책은 통과(실제 12MB > 한도 여유 10MB)
    assert.equal(r.up.status, 0, `신고 크기로는 올라간다: ${r.up.stderr}`);
    fails(r.att, /msgr_storage_limit/, '첨부 행은 실제 크기로 Pro 총량에 막는다');
  } finally { setPro(null); }
});

test('파일 하나 상한은 총량 키와 무관하게 실제 크기로 항상 본다 — 무료가 25MB로 속여 26MB를 올려도 첨부 행에서 PT413', { skip }, () => {
  setFree(null); setPro(null); // 총량은 둘 다 꺼짐
  const r = send(U.f, DM.f, 26214401, { declared: 1000000 });
  assert.equal(r.up.status, 0, `신고 크기로는 올라간다: ${r.up.stderr}`);
  fails(r.att, /msgr_file_too_large/, '실제 크기 26MB는 무료 파일 상한 초과 — 트리거가 막는다');
});

test('유료 조직 손님(좌석 없음)은 무료와 같은 파일 상한 — L7 현재 동작 고정', { skip }, () => {
  setFree(null); setPro(null);
  assert.equal(sql(`select public.is_pro_for('${U.q}')`), 'f', '손님은 Pro가 아니다');
  assert.equal(sql(`select public._msgr_file_max('${U.q}')`), '26214400');
  assert.equal(sql(`select public._msgr_file_max('${U.s}')`), '524288000', '유료 조직 멤버(좌석)는 Pro 상한');
});
