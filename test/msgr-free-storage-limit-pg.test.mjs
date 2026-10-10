// 무료 계정 메신저 첨부 저장 한도(20261011150000) — 유건 2026-10-11 "무료: 저장 용량 1GB, 파일 하나 25MB".
// 고정하는 것: 스위치(msgr_settings free_storage_limit_bytes)가 없으면 아무것도 막지 않는다 / 켜면 올린 사람 기준 합계가 한도 미만일 때만
// 새 파일을 받는다(앱 업로드 = Storage 정책, 첨부 행 = 트리거, 봇 = 준비·등록 — 모두 _msgr_upload_gate 하나) / Pro·운영자 부여·체험·유료 조직 좌석은
// 한도 밖(is_pro_for) / 이미 넘은 사람의 파일은 지우지 않는다 / 같은 객체를 다시 가리키는 행은 새 저장이 아니다 / 다른 버킷은 무관 /
// 판정은 쓰기 0 / 남의 사용량을 묻는 통로가 없다.
// Storage 흉내: 실제 storage-api(v1.41.8 uploader.canUpload)는 크기 없이 사용자 권한으로 행 넣기를 시험하고(정책 판정), 올린 뒤 슈퍼유저로
// 크기를 채운다 — 아래 uploadRaw(정책 판정, metadata 없음) + fill(서비스가 크기 채움)이 그 두 단계다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-free-storage-limit-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh로 실행';
const MINE = '20261011150000_msgr_free_storage_limit.sql';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const id = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
// f·g·h = 무료(30일 전 가입 — 체험 끝), x = 친구(무료), p = Pro 결제, r = 운영자 부여, t = 체험 중(3일 전 가입), s = 유료 조직 멤버, q = 유료 조직 손님
const U = { f: id(1), g: id(2), h: id(3), x: id(4), p: id(5), r: id(6), t: id(7), s: id(8), q: id(9) };

const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const LIMIT = /msgr_storage_limit/;

const setLimit = (v) => v == null ? sql(`delete from public.msgr_settings where key = 'free_storage_limit_bytes'`)
  : sql(`insert into public.msgr_settings (key, value) values ('free_storage_limit_bytes', '${v}') on conflict (key) do update set value = excluded.value`);
const post = (uid, ch, body = 'x') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', gen_random_uuid()::text) returning id`));
const befriend = (a, b) => { asUser(a, `select public.msgr_friend_request('${b}')`); asUser(b, `select public.msgr_friend_decide('${a}', true)`); };
const uploadRaw = (uid, path, bucket = 'msgr') => asUserRaw(uid, `insert into storage.objects (bucket_id, name, owner) values ('${bucket}', '${path}', '${uid}')`);
const fill = (path, size) => sql(`update storage.objects set metadata = jsonb_build_object('size', ${size}, 'mimetype', 'application/octet-stream') where bucket_id = 'msgr' and name = '${path}'`);
const attachRaw = (uid, mid, path, org = null, bytes = 1) => asUserRaw(uid, `insert into public.msgr_attachments (message_id, org_id, storage_path, name, mime, bytes) values (${mid}, ${org ? `'${org}'` : 'null'}, '${path}', 'a.bin', 'application/octet-stream', ${bytes})`);
let seq = 0;
// 앱 한 파일 전송 = 업로드(정책) → 크기 채움(서비스) → 첨부 행(정책 + 트리거). 단계별 결과를 돌려준다
function send(uid, ch, size, { org = null, mid = null } = {}) {
  const m = mid ?? post(uid, ch);
  const path = `${org ?? 'p'}/${ch}/${m}/${++seq}-f.bin`;
  const up = uploadRaw(uid, path);
  if (up.status !== 0) return { m, path, up };
  fill(path, size);
  return { m, path, up, att: attachRaw(uid, m, path, org) };
}
const sendOk = (uid, ch, size, opts) => { const r = send(uid, ch, size, opts); assert.equal(r.up.status, 0, `업로드 거절: ${r.up.stderr}`); assert.equal(r.att.status, 0, `첨부 행 거절: ${r.att.stderr}`); return r; };
const used = (uid) => Number(sql(`select public._msgr_storage_used('${uid}')`));

let ORG, PUB, PAID, PAID_CH; const DM = {};
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
  // 사용자는 마이그레이션 전에 만든다 — plan_no_trial이 적용 순간을 기준 시각으로 굳히므로 그 전에 가입한 사람만 체험(가입 + 14일)을 받는다
  for (const [k, uid] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${uid}', now() - interval '${k === 't' ? 3 : 30} days', '${k}@example.test') on conflict do nothing`);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  sql(`insert into public.entitlements (user_id, plan) values ('${U.p}', 'pro') on conflict (user_id) do update set plan = 'pro'`);
  sql(`insert into public.entitlements (user_id, plan, granted) values ('${U.r}', 'free', true) on conflict (user_id) do update set granted = true`);
  // 무료 조직(좌석 결제 없음 — 멤버도 무료) — f가 주인, g가 멤버
  ORG = last(asUser(U.f, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Free', 'free-org', '${U.f}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.g}', 'member') on conflict do nothing`);
  PUB = last(asUser(U.f, `select msgr_create_channel('${ORG}','public','ops','[]')`));
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${PUB}','user','${U.g}') on conflict do nothing`);
  // 유료 조직(좌석 결제 paid_until 미래) — s는 멤버(Pro), q는 손님(무료)
  PAID = last(asUser(U.s, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Paid', 'paid-org', '${U.s}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10, paid_until = now() + interval '30 days' where org_id = '${PAID}'`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${PAID}', '${U.q}', 'guest') on conflict do nothing`);
  PAID_CH = last(asUser(U.s, `select msgr_create_channel('${PAID}','public','paid-ops','[]')`));
  // 개인 1:1 — 각자 x와 친구
  for (const k of ['f', 'g', 'h', 'p', 'r', 't', 's', 'q']) { befriend(U[k], U.x); DM[k] = last(asUser(U[k], `select public.msgr_dm_personal('${U.x}')`)); }
});

test('기본(스위치 없음)은 한도 없음 — 무료 계정도 계속 올리고, 첨부 행에는 올린 사람·실제 크기가 남는다', { skip }, () => {
  setLimit(null);
  for (let i = 0; i < 3; i++) sendOk(U.h, DM.h, 6000);
  const r = sendOk(U.h, DM.h, 7000);
  assert.equal(sql(`select uploader_id || ':' || bytes from public.msgr_attachments where storage_path = '${r.path}'`), `${U.h}:7000`, '앱이 1바이트라 해도 저장소 크기로');
  assert.equal(used(U.h), 25000);
  for (const bad of ['', 'abc', '0', '-5', '1e9']) { setLimit(bad); assert.equal(sendOk(U.h, DM.h, 10).up.status, 0, `값 '${bad}'는 꺼짐`); }
  setLimit(null);
});

test('켜면: 쓴 양이 한도 미만이면 받고(넘기는 한 파일까지), 한도에 닿으면 새 업로드·새 첨부 행을 msgr_storage_limit로 거절', { skip }, () => {
  setLimit(10000);
  try {
    const a = sendOk(U.f, DM.f, 4000);
    sendOk(U.f, DM.f, 4000);
    sendOk(U.f, DM.f, 4000); // 8000 < 10000 → 받는다(Storage 정책은 크기를 모른다 — 넘기는 파일 하나까지)
    assert.equal(used(U.f), 12000);
    const blocked = send(U.f, DM.f, 4000);
    fails(blocked.up, LIMIT, '한도에 닿은 뒤 개인 방 업로드');
    assert.match(blocked.up.stderr, /PT402|msgr_storage_limit/);
    // 업로드를 건너뛴 첨부 행(정책 밖에서 넣은 객체를 가리키는 새 경로)도 같은 판정
    const m = post(U.f, DM.f); const p = `p/${DM.f}/${m}/svc-f.bin`;
    sql(`insert into storage.objects (bucket_id, name, owner, metadata) values ('msgr', '${p}', '${U.f}', '{"size": 10}')`);
    fails(attachRaw(U.f, m, p), LIMIT, '한도에 닿은 뒤 새 첨부 행');
    // 조직 경로(msgr_files_insert)도 같다
    fails(uploadRaw(U.f, `${ORG}/${PUB}/${post(U.f, PUB)}/x.bin`), LIMIT, '조직 방 업로드');
    // 기존 파일은 그대로 — 지우지 않고 읽힌다
    assert.equal(sql(`select count(*) from public.msgr_attachments where uploader_id = '${U.f}'`), '3');
    assert.equal(asUser(U.x, `select count(*) from storage.objects where bucket_id = 'msgr' and name = '${a.path}'`), '1', '상대는 지난 파일을 그대로 읽는다');
    // 한도를 올리면 다시 받는다(값만 바꾸면 된다)
    setLimit(20000);
    sendOk(U.f, DM.f, 100);
  } finally { setLimit(null); }
});

test('같은 객체를 다시 가리키는 첨부 행(게이트웨이 재사용)은 새 저장이 아니다 — 한도에 걸리지 않고 한 번만 센다', { skip }, () => {
  setLimit(null);
  const first = sendOk(U.g, PUB, 5000, { org: ORG });
  const before = used(U.g);
  setLimit(1);
  try {
    const m2 = post(U.g, PUB);
    assert.equal(attachRaw(U.g, m2, first.path, ORG).status, 0, '재사용 행은 한도를 넘어도 된다');
    assert.equal(used(U.g), before, '같은 경로는 한 번만');
    fails(uploadRaw(U.g, `${ORG}/${PUB}/${m2}/new.bin`), LIMIT, '새 객체는 막힌다');
  } finally { setLimit(null); }
});

test('Pro 결제·운영자 부여·체험·유료 조직 좌석은 한도를 넘어도 올리고, 유료 조직 손님은 무료와 같다', { skip }, () => {
  setLimit(1);
  try {
    for (const k of ['p', 'r', 't', 's']) {
      assert.equal(sql(`select public.is_pro_for('${U[k]}')`), 't', `${k}는 Pro 판정`);
      sendOk(U[k], DM[k], 5000); sendOk(U[k], DM[k], 5000);
    }
    sendOk(U.s, PAID_CH, 5000, { org: PAID }); // 조직 공간 — 유료 좌석 멤버
    assert.equal(sql(`select public.is_pro_for('${U.q}')`), 'f');
    sendOk(U.q, DM.q, 5000); // 0 < 1 → 첫 파일은 받는다
    fails(send(U.q, DM.q, 5000).up, LIMIT, '유료 조직 손님(좌석 아님)');
  } finally { setLimit(null); }
});

test('봇: 주인이 무료이고 한도에 닿았으면 준비(createUpload)를 거절, 준비 뒤 닿으면 등록(attachFile)을 거절 — 같은 판정', { skip }, () => {
  setLimit(null);
  const bot = JSON.parse(last(asUser(U.f, `select msgr_bot_create('${ORG}','hermes','pepper','moderator')`)));
  sql(`update msgr_crews set allow='all', last_seen_at=now(), dm_delivery_protocol=1 where id='${bot.crew_id}'`);
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${PUB}','crew','${bot.crew_id}') on conflict do nothing`);
  const say = () => last(sql(`set role anon; select public.msgr_bot_send('${bot.token}', '${PUB}', 'report')`));
  const prepare = (mid) => asAnonRaw(`select public.msgr_bot_attach_prepare('${bot.token}', ${mid}, 'r.pdf', 1000)`);
  const commit = (mid, path) => asAnonRaw(`select public.msgr_bot_attach_commit('${bot.token}', ${mid}, '${path}', 'r.pdf', null)`);
  const mid = say();
  const r = prepare(mid); assert.equal(r.status, 0, r.stderr);
  const path = JSON.parse(last(r.stdout)).storage_path;
  sql(`insert into storage.objects (bucket_id, name, metadata) values ('msgr', '${path}', '{"size": 3000}')`); // 서명 주소 PUT — 정책 밖(슈퍼유저)
  setLimit(used(U.f)); // 준비와 등록 사이에 주인이 한도에 닿았다
  try {
    fails(commit(mid, path), LIMIT, '등록');
    fails(prepare(say()), LIMIT, '준비');
    setLimit(null);
    const ok = commit(mid, path); assert.equal(ok.status, 0, ok.stderr);
    assert.equal(sql(`select uploader_id || ':' || bytes from public.msgr_attachments where storage_path = '${path}'`), `${U.f}:3000`, '봇 첨부는 에이전트 주인 몫');
    const again = commit(mid, path); assert.equal(again.status, 0, '같은 경로 재등록은 같은 id(재시도 안전) — 한도와 무관');
    setLimit(1);
    assert.equal(commit(mid, path).status, 0, '이미 등록된 경로 재등록은 한도에 닿아도 같은 id');
  } finally { setLimit(null); }
});

test('다른 버킷(아바타)은 한도와 무관 — Storage 한도 정책은 msgr 버킷만 보는 제한 정책 하나', { skip }, () => {
  setLimit(1);
  try {
    assert.ok(used(U.f) >= 1);
    const r = uploadRaw(U.f, `avatars/${U.f}/a.jpg`, 'msgr-avatars');
    assert.equal(r.status, 0, r.stderr);
  } finally { setLimit(null); }
  assert.equal(sql(`select permissive || ':' || cmd || ':' || array_to_string(roles, ',') from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'msgr_files_storage_limit'`), 'RESTRICTIVE:INSERT:authenticated');
});

test('판정은 쓰기 0, 남의 사용량·플랜을 묻는 통로가 없다', { skip }, () => {
  setLimit(10000);
  try {
    // 통과·거절 모두 트랜잭션 번호를 받지 않는다(= 어떤 행도 쓰지 않는다)
    // psql -c 한 번 = 한 트랜잭션 — 판정 뒤 트랜잭션 번호가 아직 없으면 그 사이에 쓴 행이 없다
    assert.equal(last(asUser(U.x, `select public.msgr_upload_check(); select coalesce(txid_current_if_assigned()::text, 'none')`)), 'none');
    const r = asUserRaw(U.f, `select public.msgr_upload_check()`);
    fails(r, LIMIT, '본인 판정만 — 넘은 사람은 오류');
    for (const fn of [`public._msgr_upload_gate('${U.p}')`, `public._msgr_storage_used('${U.p}')`, `public._msgr_upload_allowed('${U.p}')`]) {
      fails(asUserRaw(U.f, `select ${fn}`), /permission denied/, `authenticated → ${fn}`);
      fails(asAnonRaw(`select ${fn}`), /permission denied/, `anon → ${fn}`);
    }
    fails(asAnonRaw(`select public.msgr_upload_check()`), /permission denied/, 'anon → msgr_upload_check');
  } finally { setLimit(null); }
});

test('마이그레이션은 다시 적용해도 되고, 비어 있는 옛 행의 올린 사람을 채운다', { skip }, () => {
  sql(`update public.msgr_attachments set uploader_id = null`);
  psql(['-c', readFileSync(mig(MINE), 'utf8')]);
  assert.equal(sql(`select count(*) from public.msgr_attachments where uploader_id is null`), '0');
  assert.equal(sql(`select count(*) from public.msgr_settings where key = 'free_storage_limit_bytes'`), '0', '적용만으로는 켜지지 않는다');
});
