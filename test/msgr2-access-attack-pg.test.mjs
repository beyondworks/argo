// 검수 1의 #1070 공격 재현(검수 1 scratchpad review-1070-attack-pg.test.mjs, 2026-10-17 15:17 KST)을 단언으로 바꿔 PR 시험에 넣었다.
// 수정 전: ① 회원 B가 id를 직접 지정해 앞으로 쓸 id를 선점 → 회원 C의 평범한 글이 pkey 충돌로 실패 ② created_at·meta(시스템 글 코드) 위조 ③ B가 못 보는 방의 첨부 경로를 자기 방 첨부 행으로 등록
// ④ 다른 방 글 id를 답글로. ⑤(대조) B는 남의 방 행·글·첨부를 못 본다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-access-attack-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-access-attack-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const FILE = readdirSync(mig('')).filter((f) => f.endsWith('_msgr2_space.sql')).sort().pop();
const run = (args) => psqlSpawn(DB, args);
const sql = (q) => { const r = run(['-A', '-t', '-c', q]); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
const as = (uid, q) => { const r = run(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() }; };
const A = '30000000-0000-4000-8000-000000000001', B = '30000000-0000-4000-8000-000000000002', C = '30000000-0000-4000-8000-000000000003';
const DEVICE_TRUE = `create or replace function public._msgr2_device_ok() returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select true $$;
  create or replace function public._msgr2_device_app() returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select true $$;`;
let T, R1, R2;
before(() => {
  if (!DB) return;
  run(['-c', `do $$ begin if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;
    grant usage on schema public to anon, authenticated, service_role; create schema if not exists auth; grant usage on schema auth to anon, authenticated, service_role;
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;`]);
  sql(readFileSync(mig(FILE), 'utf8'));
  sql(DEVICE_TRUE); // U3 전 자리 함수는 닫힘(거짓) — 판정 행렬은 기기가 유효하다는 전제로 본다
  T = sql(`insert into msgr2_spaces (kind,name,owner_user_id) values ('team','t','${A}') returning id`);
  sql(`insert into msgr2_space_members (space_id,user_id,role) values ('${T}','${A}','owner'),('${T}','${B}','member'),('${T}','${C}','member')`);
  R1 = sql(`insert into msgr2_rooms (space_id,kind,name) values ('${T}','private','r1') returning id`); // A·C만
  R2 = sql(`insert into msgr2_rooms (space_id,kind,name) values ('${T}','private','r2') returning id`); // B만
  sql(`insert into msgr2_room_members (room_id,member_kind,member_id) values ('${R1}','user','${A}'),('${R1}','user','${C}'),('${R2}','user','${B}')`);
  sql(`insert into msgr2_messages (room_id,author_kind,author_user_id,body) values ('${R1}','user','${A}','secret-file-msg')`);
  sql(`insert into msgr2_attachments (message_id,room_id,storage_path,name) select id,'${R1}','r1/secret.pdf','secret.pdf' from msgr2_messages where body='secret-file-msg'`);
});

test('① id 선점 금지 — B가 앞으로 쓸 id를 지정해 넣지 못하고, C의 다음 글은 그대로 들어간다', { skip }, () => {
  const next = Number(sql('select coalesce(max(id),0)+1 from msgr2_messages'));
  const r = as(B, `insert into msgr2_messages (id,room_id,author_kind,author_user_id,body) select g, '${R2}','user','${B}','squat' from generate_series(${next}, ${next + 4}) g`);
  assert.equal(r.ok, false, 'B의 선점이 성공했다'); assert.match(r.err, /permission denied/);
  const c = as(C, `insert into msgr2_messages (room_id,author_kind,author_user_id,body) values ('${R1}','user','${C}','normal') returning id`);
  assert.equal(c.ok, true, c.err);
});

test('② 기록 위조 금지 — created_at·meta(시스템 글 코드)를 사람이 넣지 못한다', { skip }, () => {
  const r = as(B, `insert into msgr2_messages (room_id,author_kind,author_user_id,body,created_at,meta) values ('${R2}','user','${B}','backdated','2001-01-01','{"code":"topic.resolved"}') returning created_at, meta`);
  assert.equal(r.ok, false); assert.match(r.err, /permission denied/, 'created_at 열 권한 없음');
  const m = as(B, `insert into msgr2_messages (room_id,author_kind,author_user_id,body,meta) values ('${R2}','user','${B}','m','{"code":"topic.resolved"}')`);
  assert.equal(m.ok, false); assert.match(m.err, /row-level security/, '사람 글의 meta는 빈 값만');
});

test('③ 남의 방 첨부 경로 등록 금지 — 사람은 첨부 행을 직접 넣지 못한다(경로는 업로드 슬롯 RPC가 정한다)', { skip }, () => {
  const m = as(B, `insert into msgr2_messages (room_id,author_kind,author_user_id,body) values ('${R2}','user','${B}','m') returning id`);
  assert.equal(m.ok, true, m.err);
  const id = m.out.split('\n').pop();
  const r = as(B, `insert into msgr2_attachments (message_id,room_id,storage_path,name) values (${id},'${R2}','r1/secret.pdf','x') returning storage_path`);
  assert.equal(r.ok, false); assert.match(r.err, /permission denied/);
  assert.equal(as(B, `select count(*) from msgr2_attachments where storage_path='r1/secret.pdf'`).out, '0', 'B가 보는 secret 경로 행 없음');
});

test('④ 다른 방 글에 답글 금지 — 같은 방 글만', { skip }, () => {
  const sid = sql(`select id from msgr2_messages where body='secret-file-msg'`);
  const r = as(B, `insert into msgr2_messages (room_id,author_kind,author_user_id,body,reply_to) values ('${R2}','user','${B}','re',${sid}) returning id`);
  assert.equal(r.ok, false); assert.match(r.err, /row-level security/);
});

test('⑤ 대조 — B는 R1의 방·글·첨부를 못 본다', { skip }, () => {
  assert.equal(as(B, `select count(*) from msgr2_rooms where id='${R1}'`).out, '0');
  assert.equal(as(B, `select count(*) from msgr2_messages where room_id='${R1}'`).out, '0');
  assert.equal(as(B, `select count(*) from msgr2_attachments where room_id='${R1}'`).out, '0');
});
