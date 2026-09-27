// 아르고 오피스 메일 계정(20260927171000_office_mail.sql) — 본인 계정만, 토큰 표는 함수로만, 같은 값이면 쓰지 않는다.
// 실행: bash scripts/billing-pg-drill.sh test/office-mail-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/office-mail-pg.test.mjs';
const mig = fileURLToPath(new URL('../supabase/migrations/20260927171000_office_mail.sql', import.meta.url));
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

const raw = (q) => psqlSpawn(DB, ['-A', '-t', '-c', q]);
const sql = (q) => { const r = raw(q); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); };
const as = (uid, q) => `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`;
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const asUser = (uid, q) => last(sql(as(uid, q)));
const fails = (r, re) => { assert.notEqual(r.status, 0, '허용되면 안 된다'); if (re) assert.match(r.stderr, re); };
const connect = (uid, addr, sealed = 'S1', expect = uid) => asUser(uid, `select public.office_mail_connect('${expect}', 'google', '${addr}', '이름', null, '${sealed}')`);
const xmin = (acc) => sql(`select xmin from public.office_mail_secrets where account_id = '${acc}'`);

before(() => {
  if (!DB) return;
  sql(`
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated;
    create schema if not exists auth; grant usage on schema auth to anon, authenticated;
    create table if not exists auth.users (id uuid primary key, email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    insert into auth.users values ('${A}', 'a@example.test'), ('${B}', 'b@example.test') on conflict do nothing;`);
  const r = psqlSpawn(DB, ['-v', 'ON_ERROR_STOP=1', '-f', mig]);
  if (r.status !== 0) throw new Error(r.stderr);
});

test('연결한 계정은 본인만 본다, 토큰 표는 직접 읽을 수 없다', { skip }, () => {
  const acc = connect(A, 'Kim@Company.co.kr');
  assert.equal(asUser(A, `select address from public.office_mail_accounts where id = '${acc}'`), 'kim@company.co.kr');
  assert.equal(asUser(B, `select count(*) from public.office_mail_accounts where id = '${acc}'`), '0');
  fails(raw(as(A, 'select * from public.office_mail_secrets')), /permission denied/);
  assert.equal(asUser(A, `select sealed from public.office_mail_secret('${acc}')`), 'S1');
  assert.equal(asUser(B, `select count(*) from public.office_mail_secret('${acc}')`), '0', '남의 계정 토큰은 못 꺼낸다');
});

test('연결을 시작한 사람과 끝내는 세션이 다르면 거절한다(state 도용)', { skip }, () => {
  fails(raw(as(B, `select public.office_mail_connect('${A}', 'google', 'x@gmail.com', '', null, 'S')`)), /session mismatch/);
  fails(raw(`set role anon; select public.office_mail_connect('${A}', 'google', 'x@gmail.com', '', null, 'S')`), /permission denied/);
});

test('한 사람이 여러 계정, 같은 주소 다시 연결은 같은 계정으로 되살린다', { skip }, () => {
  const personal = connect(A, 'me@gmail.com');
  const work = connect(A, 'me@corp.example');
  assert.notEqual(personal, work);
  asUser(A, `select public.office_mail_token_put('${personal}', 'AC', now() + interval '1 hour')`);
  asUser(A, `select public.office_mail_mark('${personal}', 'expired')`);
  assert.equal(connect(A, 'ME@gmail.com', 'S2'), personal);
  assert.equal(asUser(A, `select status || ':' || coalesce(access_sealed, '-') || ':' || sealed from public.office_mail_secret('${personal}')`), 'ok:-:S2');
});

test('토큰 저장·상태 표시는 값이 바뀔 때만 쓴다, 남의 계정은 못 바꾼다', { skip }, () => {
  const acc = connect(A, 'idle@gmail.com');
  asUser(A, `select public.office_mail_token_put('${acc}', 'T1', '2030-01-01')`);
  const x = xmin(acc);
  asUser(A, `select public.office_mail_token_put('${acc}', 'T1', '2030-01-01')`);
  assert.equal(xmin(acc), x, '같은 토큰이면 행을 다시 쓰지 않는다');
  asUser(B, `select public.office_mail_token_put('${acc}', 'EVIL', '2030-01-01')`);
  assert.equal(asUser(A, `select access_sealed from public.office_mail_secret('${acc}')`), 'T1');
  asUser(A, `select public.office_mail_mark('${acc}', 'expired')`);
  const y = sql(`select xmin from public.office_mail_accounts where id = '${acc}'`);
  asUser(A, `select public.office_mail_mark('${acc}', 'expired')`);
  assert.equal(sql(`select xmin from public.office_mail_accounts where id = '${acc}'`), y);
});

test('연결 해제는 본인만, 계정과 토큰이 함께 지워진다', { skip }, () => {
  const acc = connect(A, 'bye@gmail.com');
  asUser(B, `select public.office_mail_disconnect('${acc}')`);
  assert.equal(sql(`select count(*) from public.office_mail_accounts where id = '${acc}'`), '1');
  asUser(A, `select public.office_mail_disconnect('${acc}')`);
  assert.equal(sql(`select (select count(*) from public.office_mail_accounts where id = '${acc}') + (select count(*) from public.office_mail_secrets where account_id = '${acc}')`), '0');
});
