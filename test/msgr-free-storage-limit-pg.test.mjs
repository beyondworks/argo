// 무료 계정 메신저 첨부 저장 한도(20261011150000) — 유건 2026-10-11 "무료: 저장 용량 1GB, 파일 하나 25MB".
// 고정하는 것: 스위치(msgr_settings free_storage_limit_bytes)가 없으면 아무것도 막지 않는다 / 켜면 올린 사람 기준 합계가 한도 미만일 때만
// 새 파일을 받는다(앱 업로드 = Storage 정책, 첨부 행 = 트리거, 봇 = 준비·등록 — 모두 _msgr_upload_gate 하나) / Pro·운영자 부여·체험·유료 조직 좌석은
// 한도 밖(is_pro_for) / 이미 넘은 사람의 파일은 지우지 않는다 / 같은 객체를 다시 가리키는 행은 새 저장이 아니다 / 다른 버킷은 무관 /
// 판정은 쓰기 0 / 남의 사용량을 묻는 통로가 없다.
// Storage 흉내: storage-api(2026-03 #825 이후 — 운영은 2026-09 이후 버전)는 사용자 권한으로 행 넣기를 시험하며(정책 판정) metadata.contentLength에
// 신고 크기를 싣고, 올린 뒤 슈퍼유저로 실제 크기(metadata.size)를 채운다 — uploadRaw(정책 판정, 신고 크기) + fill(서비스가 크기 채움)이 그 두 단계다.
// 신고 크기가 없는 옛 storage-api(v1.41.8 등)는 declared=null로 흉내 낸다.
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

test('기본(스위치 없음)은 한도 없음 — 무료 계정도 계속 올리고, 첨부 행 크기는 저장소 실제 크기로 남는다', { skip }, () => {
  setLimit(null);
  for (let i = 0; i < 3; i++) sendOk(U.h, DM.h, 6000);
  const r = sendOk(U.h, DM.h, 7000);
  assert.equal(sql(`select bytes from public.msgr_attachments where storage_path = '${r.path}'`), '7000', '앱이 1바이트라 해도 저장소 크기로');
  assert.equal(used(U.h), 25000);
  for (const bad of ['', 'abc', '0', '-5', '1e9']) { setLimit(bad); assert.equal(sendOk(U.h, DM.h, 10).up.status, 0, `값 '${bad}'는 꺼짐`); }
  setLimit(null);
});

test('켜면: 쓴 양 + 이번 크기가 한도 안이면 받고, 넘으면 업로드 전에 msgr_storage_limit로 거절 — 첨부 행도 같은 판정', { skip }, () => {
  setLimit(10000);
  try {
    const a = sendOk(U.f, DM.f, 4000);
    sendOk(U.f, DM.f, 4000);
    const over = send(U.f, DM.f, 4000); // 8000 + 4000 > 10000 — 신고 크기로 올리기 전에 막는다(남는 객체 없음)
    fails(over.up, LIMIT, '한도를 넘길 파일');
    // SQLSTATE PT402 — storage-api는 원문 대신 'database error, code: PT402'를 돌려주므로 앱·게이트웨이가 이 코드로 알아본다
    const st = asUserRaw(U.f, `do $$ begin perform public.msgr_upload_check('{"metadata": {"contentLength": 4000}}'::jsonb); exception when others then raise exception 'state=%', sqlstate; end $$`);
    assert.match(st.stderr, /state=PT402/);
    assert.equal(sql(`select count(*) from storage.objects where name = '${over.path}'`), '0', '거절된 업로드는 객체를 남기지 않는다');
    sendOk(U.f, DM.f, 2000); // 정확히 10000 — 한도까지는 된다
    assert.equal(used(U.f), 10000);
    fails(send(U.f, DM.f, 1).up, LIMIT, '한도에 닿은 뒤 1바이트');
    fails(uploadRaw(U.f, `${ORG}/${PUB}/${post(U.f, PUB)}/x.bin`, 'msgr', 1), LIMIT, '조직 방 업로드(msgr_files_insert)도 같다');
    // 기존 파일은 그대로 — 지우지 않고 읽힌다
    assert.equal(sql(`select count(*) from public.msgr_attachments a join public.msgr_messages m on m.id = a.message_id where m.author_user_id = '${U.f}' and m.channel_id = '${DM.f}'`), '3');
    assert.equal(asUser(U.x, `select count(*) from storage.objects where bucket_id = 'msgr' and name = '${a.path}'`), '1', '상대는 지난 파일을 그대로 읽는다');
    // 한도를 올리면 다시 받는다(값만 바꾸면 된다)
    setLimit(20000);
    sendOk(U.f, DM.f, 100);
  } finally { setLimit(null); }
});

test('신고 크기가 없는 옛 storage-api: 업로드는 쓴 양 ≤ 한도로 받고, 첨부 행이 실제 크기로 막으면 그 객체는 사용량에 남는다', { skip }, () => {
  sendOk(U.g, DM.g, 9000);
  setLimit(10000);
  try {
    const r = send(U.g, DM.g, 2000, { declared: null });
    assert.equal(r.up.status, 0, '크기를 모르면 9000 ≤ 10000으로 받는다');
    fails(r.att, LIMIT, '첨부 행은 실제 크기(9000 + 2000 > 10000)로 막는다');
    assert.equal(used(U.g), 11000, '등록 못 한 내 객체도 내 사용량');
    fails(send(U.g, DM.g, 1, { declared: null }).up, LIMIT, '그 뒤 업로드');
  } finally { setLimit(null); }
});

test('M2: 첨부 행 없이 업로드만 반복해도 내 객체가 사용량에 들어 한도에서 멈춘다(남의 객체는 안 셈)', { skip }, () => {
  const base = used(U.h); const xBase = used(U.x);
  setLimit(base + 10000);
  try {
    const paths = [];
    for (let i = 0; i < 2; i++) { const m = post(U.h, DM.h); const p = `p/${DM.h}/${m}/${++seq}-u.bin`; const r = uploadRaw(U.h, p, 'msgr', 4000); assert.equal(r.status, 0, r.stderr); fill(p, 4000); paths.push(p); }
    assert.equal(used(U.h), base + 8000, '미등록 객체 2개(8000)가 더해진다');
    fails(uploadRaw(U.h, `p/${DM.h}/${post(U.h, DM.h)}/${++seq}-u.bin`, 'msgr', 4000), LIMIT, '세 번째 미등록 업로드(8000 + 4000 > 10000)');
    assert.equal(used(U.x), xBase, '친구 x에게는 h의 객체가 안 들어간다');
    setLimit(null);
    assert.equal(attachRaw(U.h, paths[0].split('/')[2], paths[0]).status, 0);
    assert.equal(used(U.h), base + 8000, '등록해도 객체는 하나 — 한 번만 센다');
  } finally { setLimit(null); }
});

test('M1: 켜져 있으면 객체 없는 첨부 행(먼저 행, 나중 업로드)은 거절 — 꺼져 있으면 종전대로', { skip }, () => {
  const m = post(U.g, PUB);
  setLimit(1000000);
  try {
    fails(attachRaw(U.g, m, `${ORG}/${PUB}/${m}/ghost.bin`, ORG), /msgr_attach_upload_missing/, '켜짐 — 객체 없는 새 경로');
    sendOk(U.g, PUB, 10, { org: ORG, mid: m }); // 정상 순서(업로드 → 행)는 된다
  } finally { setLimit(null); }
  assert.equal(attachRaw(U.g, m, `${ORG}/${PUB}/${m}/ghost2.bin`, ORG).status, 0, '꺼짐 — 종전 동작 그대로');
});

test('방을 지워도 한도는 줄지 않는다 — 파일 행은 남아 올린 사람 몫으로 세고 정리 후보가 된다. 다른 방·조직·개인 방 파일은 후보가 아니다', { skip }, () => {
  setLimit(null);
  const ch = last(asUser(U.g, `select msgr_create_channel('${ORG}','public','tmp-${seq}','[]')`)); // 관리자가 아닌 멤버가 만든 채널
  const keepCh = sendOk(U.g, PUB, 10, { org: ORG }).path;
  const gone = [sendOk(U.g, ch, 10, { org: ORG }).path, sendOk(U.g, ch, 20, { org: ORG }).path];
  const m = post(U.g, ch); const unreg = `${ORG}/${ch}/${m}/${++seq}-o.bin`; assert.equal(uploadRaw(U.g, unreg, 'msgr', 500).status, 0); fill(unreg, 500);
  gone.push(unreg);
  const keepPaid = sendOk(U.s, PAID_CH, 10, { org: PAID }).path;
  const keepDm = sendOk(U.g, DM.g, 10).path;
  const u0 = used(U.g);
  const del = asUserRaw(U.g, `delete from public.msgr_channels where id = '${ch}' returning id`);
  assert.equal(del.status, 0, del.stderr);
  assert.match(del.stdout, new RegExp(ch), '만든 사람이 지웠다');
  assert.equal(sql(`select count(*) from storage.objects where name in ('${gone.join("','")}')`), '3', '파일 행은 SQL로 지우지 않는다(바이트가 남는 길)');
  assert.equal(used(U.g), u0, '방을 지워도 사용량은 그대로 — 1GB 올리고 방 지우기로 한도 초기화 금지');
  const cand = sql(`set role service_role; select string_agg(n, ',') from public.msgr_storage_sweep_list(1000) n`);
  for (const p of gone) assert.ok(cand.includes(p), `정리 후보: ${p}`);
  for (const p of [keepCh, keepPaid, keepDm]) assert.ok(!cand.includes(p), `후보 아님: ${p}`);
  // 정리 엣지가 Storage API로 지운 뒤(여기서는 행 삭제로 흉내)에야 준다 — 그때는 바이트도 없어진 것
  sql(`delete from storage.objects where name in ('${gone.join("','")}')`);
  assert.equal(used(U.g), u0 - 530);
});

test('개인 방도 같다 — SQL 행 삭제 트리거(msgr_personal_files_purge)를 뗐다', { skip }, () => {
  setLimit(null);
  assert.equal(sql(`select count(*) from pg_trigger where tgname = 'msgr_personal_files_purge'`), '0');
  befriend(U.g, U.h);
  const grp = last(asUser(U.g, `select public.msgr_dm_personal_group(array['${U.x}','${U.h}']::uuid[], 'tmp')`));
  const f = sendOk(U.g, grp, 300).path;
  const u0 = used(U.g);
  sql(`delete from public.msgr_channels where id = '${grp}'`);
  assert.equal(sql(`select count(*) from storage.objects where name = '${f}'`), '1');
  assert.equal(used(U.g), u0);
  assert.ok(sql(`set role service_role; select string_agg(n, ',') from public.msgr_storage_sweep_list(1000) n`).includes(f));
});

test('방이 남아 있는 동안 파일 삭제 권한은 종전 그대로(조직 관리자만) — 방을 지울 수 있는 사람도 남의 파일은 못 지운다', { skip }, () => {
  setLimit(null);
  const del = (uid, p) => asUser(uid, `with d as (delete from storage.objects where bucket_id = 'msgr' and name = '${p}' returning 1) select count(*) from d`);
  const dmFile = sendOk(U.f, DM.f, 10).path;
  assert.equal(del(U.x, dmFile), '0', '개인 1:1 상대');
  const ch = last(asUser(U.g, `select msgr_create_channel('${ORG}','public','own-${seq}','[]')`));
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${ch}','user','${U.f}') on conflict do nothing`);
  const theirs = sendOk(U.f, ch, 10, { org: ORG }).path;
  assert.equal(del(U.g, theirs), '0', '조직 채널 만든 사람(관리자 아님)');
  const mine = sendOk(U.g, ch, 10, { org: ORG }).path;
  assert.equal(del(U.g, mine), '0', '내 파일도 종전처럼 관리자만 지운다');
  assert.equal(del(U.f, mine), '1', '조직 관리자는 종전대로 지운다');
  assert.equal(sql(`select string_agg(policyname, ',' order by policyname) from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = 'DELETE' and qual like '%''msgr''%'`), 'msgr_files_delete', 'msgr 버킷 삭제 정책은 하나');
});

test('남이 내 사용량을 부풀릴 수 없다 — 내 글 폴더에 올린 파일은 그 사람 몫, 남이 방을 지워도 내 몫은 내가 올린 만큼', { skip }, () => {
  setLimit(null);
  const mineMsg = post(U.f, PUB);
  const fBefore = used(U.f); const gBefore = used(U.g);
  const p = `${ORG}/${PUB}/${mineMsg}/${++seq}-grief.bin`;
  assert.equal(uploadRaw(U.g, p, 'msgr', 4000).status, 0); fill(p, 4000);
  assert.equal(used(U.f), fBefore, 'f의 글 폴더라도 f 몫이 아니다');
  assert.equal(used(U.g), gBefore + 4000, '올린 g 몫');
  fails(attachRaw(U.g, mineMsg, p, ORG), /row-level security/, 'f의 글에 붙일 수도 없다');
  const ch = last(asUser(U.g, `select msgr_create_channel('${ORG}','public','grief-${seq}','[]')`));
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${ch}','user','${U.f}') on conflict do nothing`);
  const fFile = sendOk(U.f, ch, 700, { org: ORG });
  const f1 = used(U.f); const g1 = used(U.g);
  assert.equal(asUserRaw(U.g, `delete from public.msgr_channels where id = '${ch}'`).status, 0);
  assert.equal(used(U.f), f1, 'g가 방을 지워도 f 몫은 f가 올린 만큼 그대로(정리 뒤 준다)');
  assert.equal(used(U.g), g1, 'f의 파일이 g 몫이 되지도 않는다');
  sql(`delete from storage.objects where name = '${fFile.path}'`);
  assert.equal(used(U.f), f1 - 700);
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
  setLimit(6000);
  try {
    for (const k of ['p', 'r', 't', 's']) {
      assert.equal(sql(`select public.is_pro_for('${U[k]}')`), 't', `${k}는 Pro 판정`);
      sendOk(U[k], DM[k], 5000); sendOk(U[k], DM[k], 5000);
    }
    sendOk(U.s, PAID_CH, 5000, { org: PAID }); // 조직 공간 — 유료 좌석 멤버
    assert.equal(sql(`select public.is_pro_for('${U.q}')`), 'f');
    sendOk(U.q, DM.q, 5000); // 0 + 5000 ≤ 6000 → 첫 파일은 받는다
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
  setLimit(used(U.f) - 1); // 준비와 등록 사이에 주인이 한도를 넘었다(올린 봇 객체 3000은 등록 전에도 주인 몫으로 이미 센다)
  try {
    fails(commit(mid, path), LIMIT, '등록');
    fails(prepare(say()), LIMIT, '준비');
    setLimit(null);
    const ok = commit(mid, path); assert.equal(ok.status, 0, ok.stderr);
    assert.equal(sql(`select bytes from public.msgr_attachments where storage_path = '${path}'`), '3000');
    const u = used(U.f);
    sql(`update storage.objects set metadata = '{"size": 9000}' where name = '${path}'`); // 같은 서명 주소로 더 큰 파일을 다시 PUT(정책 밖)
    assert.equal(used(U.f), u + 6000, '첨부 행 크기(3000)가 아니라 지금 있는 객체 크기로 센다');
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

test('저장소 버전 관리 열: 보관본·삭제 표시는 세지도 정리하지도 않고, owner가 비고 owner_id만 있으면 owner_id로 센다', { skip }, () => {
  setLimit(null);
  const u0 = used(U.h);
  const m = post(U.h, DM.h);
  const live = `p/${DM.h}/${m}/${++seq}-v.bin`;
  sql(`insert into storage.objects (bucket_id, name, owner, metadata) values ('msgr', '${live}', '${U.h}', '{"size": 100}')`);
  sql(`insert into storage.objects (bucket_id, name, owner, metadata, archived_at, created_at) values ('msgr', '${live}', '${U.h}', '{"size": 7000}', now(), now() - interval '30 hours')`); // 같은 경로의 보관본
  const marker = `p/${DM.h}/${m}/${++seq}-d.bin`;
  sql(`insert into storage.objects (bucket_id, name, owner, metadata, is_delete_marker, created_at) values ('msgr', '${marker}', '${U.h}', '{"size": 900}', true, now() - interval '30 hours')`);
  assert.equal(used(U.h), u0 + 100, '보관본 7000·삭제 표시 900은 세지 않는다');
  const xBefore = used(U.x);
  const oid = `p/${DM.h}/${post(U.x, DM.h)}/${++seq}-oid.bin`; // 경로의 글은 x 것 — 경로로 추정하면 x 몫이 된다
  sql(`insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ('msgr', '${oid}', null, '${U.h}', '{"size": 40}')`);
  assert.equal(used(U.h), u0 + 140, 'owner가 비어도 owner_id(문자열)로 센다');
  assert.equal(used(U.x), xBefore, '경로의 글 주인(x) 몫이 아니다');
  const cand = sql(`set role service_role; select coalesce(string_agg(n, ','), '') from public.msgr_storage_sweep_list(1000) n`);
  assert.ok(!cand.includes(marker), '삭제 표시는 정리 후보가 아니다(Storage가 관리)');
  assert.equal(attachRaw(U.h, m, live).status, 0);
  assert.equal(sql(`select bytes from public.msgr_attachments where storage_path = '${live}'`), '100', '첨부 행 크기도 지금 버전(보관본 아님)');
});

test('판정은 쓰기 0, 남의 사용량·플랜을 묻는 통로가 없다', { skip }, () => {
  setLimit(10000);
  try {
    // 통과·거절 모두 트랜잭션 번호를 받지 않는다(= 어떤 행도 쓰지 않는다)
    // psql -c 한 번 = 한 트랜잭션 — 판정 뒤 트랜잭션 번호가 아직 없으면 그 사이에 쓴 행이 없다
    assert.equal(last(asUser(U.x, `select public.msgr_upload_check('{}'::jsonb); select coalesce(txid_current_if_assigned()::text, 'none')`)), 'none');
    const r = asUserRaw(U.f, `select public.msgr_upload_check('{"metadata": {"contentLength": 1}}'::jsonb)`);
    fails(r, LIMIT, '본인 판정만 — 넘은 사람은 오류');
    for (const fn of [`public._msgr_upload_gate('${U.p}', 0)`, `public._msgr_storage_used('${U.p}')`, `public._msgr_upload_allowed('${U.p}', 0)`]) {
      fails(asUserRaw(U.f, `select ${fn}`), /permission denied/, `authenticated → ${fn}`);
      fails(asAnonRaw(`select ${fn}`), /permission denied/, `anon → ${fn}`);
    }
    fails(asAnonRaw(`select public.msgr_upload_check('{}'::jsonb)`), /permission denied/, 'anon → msgr_upload_check');
  } finally { setLimit(null); }
});

// ── 커밋 보안 점검 "quota-bypass" 재현(#946 2차) — 신고 크기·owner 빈 객체·지우고 다시 쓰기·스위치 틈·여러 행 한 번에 ──

test('신고 크기는 믿지 않는다: 0을 신고하고 큰 파일을 올려도 실제 크기가 내 사용량에 들어가 다음 업로드가 막히고, 한도에 닿은 뒤에는 0 신고도 막힌다', { skip }, () => {
  const base = used(U.x);
  setLimit(base + 5000);
  try {
    const m = post(U.x, DM.f); const p = `p/${DM.f}/${m}/${++seq}-lie.bin`;
    const up = uploadRaw(U.x, p, 'msgr', 0);
    assert.equal(up.status, 0, '쓴 양 < 한도면 신고 0은 받는다(실제 크기는 정책이 모른다)');
    fill(p, 8000);
    assert.equal(used(U.x), base + 8000, '등록하지 않아도 실제 크기가 내 몫');
    fails(uploadRaw(U.x, `p/${DM.f}/${post(U.x, DM.f)}/${++seq}-lie.bin`, 'msgr', 0), LIMIT, '그 뒤 0 신고');
    fails(attachRaw(U.x, m, p), LIMIT, '그 객체 등록도 실제 크기로 막힌다');
    setLimit(used(U.x));
    fails(uploadRaw(U.x, `p/${DM.f}/${post(U.x, DM.f)}/${++seq}-lie.bin`, 'msgr', 0), LIMIT, '쓴 양 = 한도에서 0 신고(최소 1바이트로 본다)');
  } finally { setLimit(null); }
});

test('owner가 빈 봇 업로드(서명 주소)도 등록 없이 남으면 에이전트 주인 몫 — 다음 준비가 막힌다', { skip }, () => {
  setLimit(null);
  const bot = JSON.parse(last(asUser(U.f, `select msgr_bot_create('${ORG}','openclaw','claw2','peer')`)));
  sql(`update msgr_crews set allow='all', last_seen_at=now(), dm_delivery_protocol=1 where id='${bot.crew_id}'`);
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${PUB}','crew','${bot.crew_id}') on conflict do nothing`);
  const say = () => last(sql(`set role anon; select public.msgr_bot_send('${bot.token}', '${PUB}', 'r')`));
  const before = used(U.f);
  const mid = say();
  const r = asAnonRaw(`select public.msgr_bot_attach_prepare('${bot.token}', ${mid}, 'r.pdf', 1)`); assert.equal(r.status, 0, r.stderr);
  const path = JSON.parse(last(r.stdout)).storage_path;
  sql(`insert into storage.objects (bucket_id, name, metadata) values ('msgr', '${path}', '{"size": 9000}')`); // 신고는 1, 실제 PUT은 9000 — owner 없음
  assert.equal(used(U.f), before + 9000, '등록 안 한 봇 객체도 주인 몫');
  setLimit(before + 5000);
  try { fails(asAnonRaw(`select public.msgr_bot_attach_prepare('${bot.token}', ${say()}, 'r.pdf', 1)`), LIMIT, '다음 준비'); } finally { setLimit(null); }
});

test('지우고 다시 쓰기: 글 지우기·첨부 행 지우기·남의 글에 붙이기는 사용량을 줄이지 못하고, 남의 글 폴더에 올린 객체도 내 몫', { skip }, () => {
  setLimit(null);
  const a = sendOk(U.g, PUB, 700, { org: ORG });
  const u0 = used(U.g);
  sql(`set role authenticated; select set_config('argo.uid', '${U.g}', false); update public.msgr_messages set deleted_at = now() where id = ${a.m}`);
  assert.equal(sql(`select deleted_at is not null from public.msgr_messages where id = ${a.m}`), 't');
  assert.equal(used(U.g), u0, '글을 지워도(삭제 표시) 첨부 행·객체가 남아 그대로 센다');
  assert.equal(asUser(U.g, `with d as (delete from public.msgr_attachments where storage_path = '${a.path}' returning 1) select count(*) from d`), '0', '첨부 행은 지울 수 없다');
  const theirs = post(U.f, PUB);
  fails(attachRaw(U.g, theirs, a.path, ORG), /row-level security/, '남의 글에 내 파일 붙이기');
  const p = `${ORG}/${PUB}/${theirs}/${++seq}-mine.bin`; // 경로는 f의 글 폴더, 올린 사람은 g
  assert.equal(uploadRaw(U.g, p, 'msgr', 300).status, 0); fill(p, 300);
  assert.equal(used(U.g), u0 + 300, 'owner = 나 — 경로가 남의 글 폴더여도 내 몫');
  assert.equal(used(U.f) >= 0, true);
});

test('지우고 같은 경로에 더 큰 파일을 올려도 지금 있는 크기로 센다 — 재업로드를 막지 않는다(Pro 포함)', { skip }, () => {
  setLimit(null);
  const a = sendOk(U.f, PUB, 100, { org: ORG }); // f = 조직 관리자(지울 수 있다)
  const u0 = used(U.f);
  assert.equal(asUser(U.f, `with d as (delete from storage.objects where bucket_id = 'msgr' and name = '${a.path}' returning 1) select count(*) from d`), '1');
  setLimit(u0 + 1000000);
  try {
    const r = uploadRaw(U.f, a.path, 'msgr', 5000); assert.equal(r.status, 0, r.stderr); fill(a.path, 5000);
    assert.equal(used(U.f), u0 - 100 + 5000, '첨부 행 크기(100)가 아니라 새 객체 크기(5000)');
  } finally { setLimit(null); }
});

test('스위치는 판정마다 읽는다 — 같은 연결에서 켜기·끄기·켜기가 바로 반영된다', { skip }, () => {
  const r = psqlRaw(['-A', '-t', '-c', `do $$ declare r text := ''; u uuid := '${U.g}'; begin
    insert into public.msgr_settings (key, value) values ('free_storage_limit_bytes', '1') on conflict (key) do update set value = excluded.value;
    r := r || public._msgr_upload_allowed(u, 1)::text;
    delete from public.msgr_settings where key = 'free_storage_limit_bytes';
    r := r || ',' || public._msgr_upload_allowed(u, 1)::text;
    insert into public.msgr_settings (key, value) values ('free_storage_limit_bytes', '1');
    r := r || ',' || public._msgr_upload_allowed(u, 1)::text;
    raise exception 'seq=%', r; end $$`]); // 끝에서 raise — 결과를 돌려받고 설정 변경은 되돌린다
  assert.match(r.stderr, /seq=false,true,false/);
  assert.equal(sql(`select count(*) from public.msgr_settings where key = 'free_storage_limit_bytes'`), '0');
});

test('여러 첨부 행을 한 문장으로 넣어도 행마다 판정 — 한도를 넘으면 전부 거절(0행)', { skip }, () => {
  setLimit(null);
  const m = post(U.g, PUB); const ps = [1, 2, 3].map(() => `${ORG}/${PUB}/${m}/${++seq}-b.bin`);
  for (const p of ps) { assert.equal(uploadRaw(U.g, p, 'msgr', 100).status, 0); fill(p, 100); }
  setLimit(used(U.g) - 1);
  try {
    const vals = ps.map((p) => `(${m}, '${ORG}', '${p}', 'b', null, 1)`).join(',');
    fails(asUserRaw(U.g, `insert into public.msgr_attachments (message_id, org_id, storage_path, name, mime, bytes) values ${vals}`), LIMIT, '한 문장 세 행');
    assert.equal(sql(`select count(*) from public.msgr_attachments where message_id = ${m}`), '0');
  } finally { setLimit(null); }
});

test('정리 호출: 후보가 없으면 엣지를 부르지 않고(유휴 0), 후보가 있고 주소·비밀이 있을 때만 1번. 목록은 서비스 역할만', { skip }, () => {
  sql(`create table if not exists public.test_net_calls (id bigint generated always as identity, url text)`);
  sql(`create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
    language sql as $$ insert into public.test_net_calls (url) values (url) returning 1::bigint $$`);
  fails(asUserRaw(U.f, `select public.msgr_storage_sweep_list(1)`), /permission denied/, 'authenticated → 목록');
  fails(asAnonRaw(`select public.msgr_storage_sweep_list(1)`), /permission denied/, 'anon → 목록');
  fails(asUserRaw(U.f, `select public.msgr_storage_sweep_kick()`), /permission denied/, 'authenticated → kick');
  const calls = () => Number(sql(`select count(*) from public.test_net_calls`));
  sql(`delete from storage.objects where name in (select public.msgr_storage_sweep_list(1000))`); // 지금 후보를 비운다(정리 흉내)
  const c0 = calls();
  assert.equal(sql(`select public.msgr_storage_sweep_kick()`), 'f', '주소·비밀 없음');
  sql(`insert into public.msgr_settings (key, value) values ('storage_sweep_url', 'https://example.test/functions/v1/msgr-storage-sweep'), ('storage_sweep_secret', 's') on conflict (key) do update set value = excluded.value`);
  try {
    assert.equal(sql(`select public.msgr_storage_sweep_kick()`), 'f', '후보 없음 — 호출 0');
    assert.equal(calls(), c0);
    // 24시간 지난 미등록 객체 = 후보, 최근 미등록·등록된 것 = 후보 아님
    const m = post(U.h, DM.h);
    const old = `p/${DM.h}/${m}/${++seq}-old.bin`; const fresh = `p/${DM.h}/${m}/${++seq}-new.bin`;
    sql(`insert into storage.objects (bucket_id, name, owner, metadata, created_at) values ('msgr', '${old}', '${U.h}', '{"size": 1}', now() - interval '25 hours'), ('msgr', '${fresh}', '${U.h}', '{"size": 1}', now())`);
    const reg = sendOk(U.h, DM.h, 1).path; sql(`update storage.objects set created_at = now() - interval '25 hours' where name = '${reg}'`);
    const cand = sql(`set role service_role; select coalesce(string_agg(n, ','), '') from public.msgr_storage_sweep_list(1000) n`);
    assert.ok(cand.includes(old) && !cand.includes(fresh) && !cand.includes(reg), cand);
    assert.equal(sql(`select public.msgr_storage_sweep_kick()`), 't');
    assert.equal(calls(), c0 + 1, '후보가 있으면 1번');
  } finally { sql(`delete from public.msgr_settings where key in ('storage_sweep_url', 'storage_sweep_secret')`); }
});

test('마이그레이션은 다시 적용해도 되고, 적용만으로는 켜지지 않는다', { skip }, () => {
  psql(['-c', readFileSync(mig(MINE), 'utf8')]);
  assert.equal(sql(`select count(*) from public.msgr_settings where key = 'free_storage_limit_bytes'`), '0', '적용만으로는 켜지지 않는다');
  assert.equal(sql(`select count(*) from pg_trigger where tgname = 'msgr_personal_files_purge'`), '0');
});
