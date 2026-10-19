// 동기화 '새 시작' 서버 스위치(20261019140000) — 실제 Postgres. ARGO_PG_TEST_URL 미설정이면 skip. 실행: `npm run test:pg`.
// 계약: 기본(행 없음) 꺼짐, 'on'일 때만 참, 다른 값은 꺼짐, 로그인 사용자만 부른다(anon 거절), 표(msgr_settings)는 직접 못 읽는다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
function psql(args) { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asAuth = (q) => sql(`set role authenticated; ${q}`).split('\n').filter(Boolean).pop();

before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create table if not exists public.msgr_settings (key text primary key, value text);
    alter table public.msgr_settings enable row level security;
  `]);
  psql(['-f', mig('20261019140000_sync_fresh_start_switch.sql')]);
});

test('기본(행 없음)은 꺼짐, on만 켜짐, 다른 값은 꺼짐', { skip }, () => {
  assert.equal(asAuth('select public.argo_sync_fresh_start()'), 'f');
  sql(`insert into public.msgr_settings values ('sync_fresh_start', 'on')`);
  assert.equal(asAuth('select public.argo_sync_fresh_start()'), 't');
  sql(`update public.msgr_settings set value = 'yes' where key = 'sync_fresh_start'`);
  assert.equal(asAuth('select public.argo_sync_fresh_start()'), 'f');
  sql(`delete from public.msgr_settings where key = 'sync_fresh_start'`);
  assert.equal(asAuth('select public.argo_sync_fresh_start()'), 'f');
});

test('anon은 부를 수 없고, 로그인 사용자도 설정 표는 직접 못 읽는다(비밀값 행이 같은 표)', { skip }, () => {
  const r = psqlSpawn(DB, ['-c', 'set role anon; select public.argo_sync_fresh_start()']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /permission denied/i);
  const t = psqlSpawn(DB, ['-c', 'set role authenticated; select * from public.msgr_settings']);
  assert.notEqual(t.status, 0);
});
