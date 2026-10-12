// 유료 조직 손님 첨부 = 조직 할당량(20261012140000) — 준비는 msgr-free-storage-limit-pg.test.mjs와 같다. 원 파일 머리말:
// 무료 계정 메신저 첨부 저장 한도(20261011150000) — 유건 2026-10-11 "무료: 저장 용량 1GB, 파일 하나 25MB".
// 고정하는 것: 스위치(msgr_settings free_storage_limit_bytes)가 없으면 아무것도 막지 않는다 / 켜면 올린 사람 기준 합계가 한도 미만일 때만
// 새 파일을 받는다(앱 업로드 = Storage 정책, 첨부 행 = 트리거, 봇 = 준비·등록 — 모두 _msgr_upload_gate 하나) / Pro·운영자 부여·체험·유료 조직 좌석은
// 한도 밖(is_pro_for) / 이미 넘은 사람의 파일은 지우지 않는다 / 같은 객체를 다시 가리키는 행은 새 저장이 아니다 / 다른 버킷은 무관 /
// 판정은 쓰기 0 / 남의 사용량을 묻는 통로가 없다.
// Storage 흉내: storage-api(2026-03 #825 이후 — 운영은 2026-09 이후 버전)는 사용자 권한으로 행 넣기를 시험하며(정책 판정) metadata.contentLength에
// 신고 크기를 싣고, 올린 뒤 슈퍼유저로 실제 크기(metadata.size)를 채운다 — uploadRaw(정책 판정, 신고 크기) + fill(서비스가 크기 채움)이 그 두 단계다.
// 신고 크기가 없는 옛 storage-api(v1.41.8 등)는 declared=null로 흉내 낸다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-org-guest-storage-pg.test.mjs
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
const uploadRaw = (uid, path, bucket = 'msgr', declared = null) => asUserRaw(uid, `insert into storage.objects (bucket_id, name, owner, metadata) values ('${bucket}', '${path}', '${uid}', ${declared == null ? 'null' : `'{"contentLength": ${declared}}'`})`);
const fill = (path, size) => sql(`update storage.objects set metadata = jsonb_build_object('size', ${size}, 'mimetype', 'application/octet-stream') where bucket_id = 'msgr' and name = '${path}'`);
const attachRaw = (uid, mid, path, org = null, bytes = 1) => asUserRaw(uid, `insert into public.msgr_attachments (message_id, org_id, storage_path, name, mime, bytes) values (${mid}, ${org ? `'${org}'` : 'null'}, '${path}', 'a.bin', 'application/octet-stream', ${bytes})`);
let seq = 0;
// 앱 한 파일 전송 = 업로드(정책) → 크기 채움(서비스) → 첨부 행(정책 + 트리거). 단계별 결과를 돌려준다
function send(uid, ch, size, { org = null, mid = null, declared = size } = {}) {
  const m = mid ?? post(uid, ch);
  const path = `${org ?? 'p'}/${ch}/${m}/${++seq}-f.bin`;
  const up = uploadRaw(uid, path, 'msgr', declared);
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
    -- 운영 storage-api(마이그레이션 0072)의 버전 관리·소유자 열 — 다른 pg 시험의 흉내 표에는 없다(그쪽은 열 없는 환경을 확인한다)
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


// ───────── 유료 조직 손님 = 조직 할당량(20261012140000, 유건 2026-10-12) ─────────
const setKey = (k, v) => v == null ? sql(`delete from public.msgr_settings where key = '${k}'`)
  : sql(`insert into public.msgr_settings (key, value) values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const orgUsed = (org) => Number(sql(`select public._msgr_org_storage_used('${org}')`));
const allOff = () => { setLimit(null); setKey('pro_storage_limit_bytes', null); setKey('org_storage_seat_bytes', null); };
let GCH = null; // 손님 q가 들어 있는 유료 조직의 비공개 방(손님은 초대된 방에서만 쓴다)
const joinPaid = () => { if (!GCH) GCH = last(asUser(U.s, `select msgr_create_channel('${PAID}', 'private', 'guest-room', '[{"kind":"user","id":"${U.q}"}]'::jsonb)`)); return GCH; };

test('[조직 할당량] 유료 조직 손님이 그 조직 방에 올린 파일은 조직 할당량에서 세고 본인 무료 한도에서는 빠진다 — 개인 1:1은 종전대로 본인 한도', { skip }, () => {
  joinPaid();
  assert.equal(sql(`select public._msgr_org_guest_pool('${U.q}', '${PAID}')`), 't', 'q는 유료 조직 손님');
  assert.equal(sql(`select public._msgr_org_guest_pool('${U.s}', '${PAID}')`), 'f', '좌석 멤버는 해당 없음(본인 Pro 한도)');
  setLimit(1000); setKey('org_storage_seat_bytes', 3000); // 개인 1000 · 조직 = 좌석 10 × 3000 = 30000
  try {
    const mine0 = used(U.q);
    sendOk(U.q, GCH, 5000, { org: PAID }); // 본인 한도(1000)였다면 막혔다
    assert.equal(used(U.q), mine0, '조직 방 파일은 본인 사용량에 들지 않는다');
    assert.ok(orgUsed(PAID) >= 5000, '조직 사용량에 든다');
    fails(send(U.q, DM.q, 2000).up, LIMIT, '개인 1:1은 본인 무료 한도');
  } finally { allOff(); }
});

test('[조직 할당량] 할당량 = 좌석 수 × 좌석당 용량, 멤버·손님 파일을 함께 센다 — 넘으면 msgr_storage_limit(PT402), 정확히 한도까지는 받는다', { skip }, () => {
  joinPaid();
  const base = orgUsed(PAID);
  setKey('org_storage_seat_bytes', 1000); // 좌석 10 × 1000 = 10000
  const lim = Number(sql(`select public._msgr_org_storage_limit('${PAID}')`));
  assert.equal(lim, 10000);
  try {
    if (base < lim) sendOk(U.s, GCH, lim - base - 1000, { org: PAID }); // 좌석 멤버가 채운 것도 조직 묶음에서 센다(멤버 본인 판정은 Pro라 통과)
    fails(send(U.q, GCH, 2000, { org: PAID }).up, LIMIT, '조직 할당량 초과');
    const st = asUserRaw(U.q, `do $$ begin perform public.msgr_upload_check(jsonb_build_object('name', '${PAID}/x/1/y', 'metadata', jsonb_build_object('contentLength', 2000))); exception when others then raise exception 'state=%', sqlstate; end $$`);
    assert.match(st.stderr, /state=PT402/, '총량 초과는 PT402');
    sendOk(U.q, GCH, 1000, { org: PAID }); // 정확히 한도
    assert.equal(orgUsed(PAID), lim);
  } finally { allOff(); }
});

test('[조직 할당량] 파일 하나 상한은 조직 플랜(500MB) — 같은 손님의 개인 1:1은 무료 25MB', { skip }, () => {
  joinPaid();
  setKey('org_storage_seat_bytes', '1000000000000');
  try {
    const big = 31457280; // 30MB
    const path = `${PAID}/${GCH}/${post(U.q, GCH)}/${++seq}-big.bin`;
    assert.equal(uploadRaw(U.q, path, 'msgr', big).status, 0, '유료 조직 방에서는 30MB도 받는다');
    fails(send(U.q, DM.q, big).up, /msgr_file_too_large/, '개인 1:1은 25MB');
    fails(uploadRaw(U.q, `${PAID}/${GCH}/${post(U.q, GCH)}/${++seq}-huge.bin`, 'msgr', 524288001), /msgr_file_too_large/, '조직 방도 500MB가 끝');
  } finally { allOff(); }
});

test('[조직 할당량] 결제가 끝난 조직(paid_until 지남)의 손님은 종전대로 본인 한도, 키가 모두 꺼져 있으면 조직 할당량도 무제한', { skip }, () => {
  joinPaid();
  setLimit(1000); setKey('org_storage_seat_bytes', '1000000000');
  sql(`update public.msgr_org_entitlements set paid_until = now() - interval '1 day' where org_id = '${PAID}'`);
  try {
    assert.equal(sql(`select public._msgr_org_guest_pool('${U.q}', '${PAID}')`), 'f');
    fails(send(U.q, GCH, 5000, { org: PAID }).up, LIMIT, '결제가 끝나면 본인 무료 한도');
  } finally { sql(`update public.msgr_org_entitlements set paid_until = now() + interval '30 days' where org_id = '${PAID}'`); allOff(); }
  assert.equal(sql(`select public._msgr_org_storage_limit('${PAID}') is null`), 't', '키가 모두 꺼지면 무제한');
  sendOk(U.q, GCH, 20000, { org: PAID });
  setKey('pro_storage_limit_bytes', 2000); // 좌석당 용량이 없으면 Pro 개인 한도를 따른다
  try { assert.equal(Number(sql(`select public._msgr_org_storage_limit('${PAID}')`)), 20000); } finally { allOff(); }
});

test('[조직 할당량] 남의 사용량을 묻는 통로가 없다 — 새 판정 함수는 클라이언트가 부를 수 없다', { skip }, () => {
  for (const fn of ['_msgr_org_guest_pool(uuid, uuid)', '_msgr_org_seat_bytes()', '_msgr_org_storage_limit(uuid)', '_msgr_org_storage_used(uuid, text)', '_msgr_file_max_in(uuid, uuid)', '_msgr_upload_gate_in(uuid, bigint, text, uuid)']) {
    assert.equal(sql(`select has_function_privilege('authenticated', 'public.${fn}', 'execute')`), 'f', fn);
  }
});

test('[조직 할당량] 첨부 행 트리거는 저장 경로 첫 칸으로 조직을 판단한다(행의 org_id와 어긋날 수 없다) · 기한이 지난 손님은 조직 할당량을 쓰지 못한다', { skip }, () => {
  joinPaid();
  setLimit(1000); setKey('org_storage_seat_bytes', 100000);
  try {
    const m = post(U.q, GCH);
    const path = PAID + '/' + GCH + '/' + m + '/' + (++seq) + '-ctx.bin';
    assert.equal(uploadRaw(U.q, path, 'msgr', 5000).status, 0, '조직 경로 업로드');
    fill(path, 5000);
    // 서비스 권한으로 org_id 없이 행을 넣어도 트리거는 경로의 조직(유료 조직 손님)으로 판단한다 — 본인 한도(1000)였다면 거절
    const r = psqlRaw(['-A', '-t', '-c', "insert into public.msgr_attachments (message_id, org_id, storage_path, name, mime, bytes) values (" + m + ", null, '" + path + "', 'a.bin', 'application/octet-stream', 1)"]);
    assert.match(r.stderr, /msgr_attachments_space_path/, '행의 조직과 경로의 조직은 어긋날 수 없다(제약) — 트리거의 경로 기준 판정과 같은 조직');
    sendOk(U.q, GCH, 5000, { org: PAID }); // 맞는 행은 본인 한도(1000)가 아닌 조직 할당량으로 통과
    sql("update public.msgr_org_members set expires_at = now() - interval '1 minute' where org_id = '" + PAID + "' and user_id = '" + U.q + "'");
    try {
      assert.equal(sql("select public._msgr_org_guest_pool('" + U.q + "', '" + PAID + "')"), 'f', '기한이 지난 손님은 조직 할당량 대상이 아니다');
      assert.equal(used(U.q) < 1000, true, '기한이 지나도 조직 폴더 파일은 본인 사용량으로 돌아오지 않는다(조직 사용량에서만 센다)');
    } finally { sql("update public.msgr_org_members set expires_at = null where org_id = '" + PAID + "' and user_id = '" + U.q + "'"); }
  } finally { allOff(); }
});

