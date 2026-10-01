// 메신저 첫 사용 안내 본 기록(2026-10-01) — 배포될 마이그레이션을 그대로 적용해 확인한다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-guide-seen-pg.test.mjs
// 지키는 것: 본인만 읽고 쓴다(표 직접 접근 0) · 같은 판 번호면 행을 다시 쓰지 않는다(xmin 불변, DB 위생) · 낮은 번호로 되돌리지 않는다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-guide-seen-pg.test.mjs';
const mig = fileURLToPath(new URL('../supabase/migrations/20261001173000_msgr_guide_seen.sql', import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };
const run = (q) => psqlSpawn(DB, ['-A', '-t', '-c', q]);
const sql = (q) => { const r = run(q); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout.trim(); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const asUser = (uid, q) => last(sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`));
const asUserRaw = (uid, q) => run(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asAnonRaw = (q) => run(`set role anon; ${q}`);

before(() => {
  if (!DB) return;
  sql(`
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth; grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
  `);
  sql(readFileSync(mig, 'utf8'));
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, email) values ('${id}', '${k}@example.test') on conflict do nothing`);
});

test('안 봤으면 null, 남기면 본인 판 번호를 돌려준다', { skip }, () => {
  assert.equal(asUser(U.a, 'select coalesce(public.msgr_my_guide_seen()::text, \'null\')'), 'null');
  asUser(U.a, 'select public.msgr_mark_guide_seen(1::smallint)');
  assert.equal(asUser(U.a, 'select public.msgr_my_guide_seen()'), '1');
  assert.equal(asUser(U.b, 'select coalesce(public.msgr_my_guide_seen()::text, \'null\')'), 'null', '남의 기록은 안 보인다');
});

test('같은 판 번호로 다시 남기면 행을 다시 쓰지 않는다(xmin 불변), 낮은 번호로는 되돌리지 않는다', { skip }, () => {
  asUser(U.b, 'select public.msgr_mark_guide_seen(2::smallint)');
  const x1 = sql(`select xmin::text || ':' || version from public.msgr_guide_seen where user_id = '${U.b}'`);
  asUser(U.b, 'select public.msgr_mark_guide_seen(2::smallint)');
  asUser(U.b, 'select public.msgr_mark_guide_seen(1::smallint)');
  assert.equal(sql(`select xmin::text || ':' || version from public.msgr_guide_seen where user_id = '${U.b}'`), x1);
  asUser(U.b, 'select public.msgr_mark_guide_seen(3::smallint)');
  assert.equal(asUser(U.b, 'select public.msgr_my_guide_seen()'), '3', '더 높은 판은 올린다');
  assert.equal(sql('select count(*) from public.msgr_guide_seen'), '2', '사용자당 한 행');
});

test('표는 직접 읽고 쓸 수 없고, 로그인 안 한 요청·잘못된 번호는 거절한다', { skip }, () => {
  assert.notEqual(asUserRaw(U.a, 'select * from public.msgr_guide_seen').status, 0, '본인도 표 직접 조회 불가 — RPC로만');
  assert.notEqual(asUserRaw(U.a, `insert into public.msgr_guide_seen (user_id, version) values ('${U.a}', 9)`).status, 0);
  assert.notEqual(asAnonRaw('select public.msgr_my_guide_seen()').status, 0);
  assert.notEqual(asAnonRaw('select public.msgr_mark_guide_seen(1::smallint)').status, 0);
  assert.notEqual(asUserRaw(U.a, 'select public.msgr_mark_guide_seen(0::smallint)').status, 0);
  assert.notEqual(run(`set role authenticated; select public.msgr_mark_guide_seen(1::smallint)`).status, 0, 'uid 없음');
});

test('계정을 지우면 기록도 함께 지워진다', { skip }, () => {
  sql(`delete from auth.users where id = '${U.a}'`);
  assert.equal(sql(`select count(*) from public.msgr_guide_seen where user_id = '${U.a}'`), '0');
});
