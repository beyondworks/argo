// 오피스 메일 번역 통로(20260927174000_office_translate_channel.sql) — 메일 내용이 오가므로 본인 토픽만 보내고 받는다(총괄 검토 9/27).
// 실행: bash scripts/billing-pg-drill.sh test/office-translate-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/office-translate-pg.test.mjs';
const mig = fileURLToPath(new URL('../supabase/migrations/20260927174000_office_translate_channel.sql', import.meta.url));
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

const raw = (q) => psqlSpawn(DB, ['-A', '-t', '-c', q]);
const sql = (q) => { const r = raw(q); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim(); };
// 실시간 서버가 채널 가입 때 하는 것처럼 — 사용자·토픽을 세션에 싣고 정책을 본다
const as = (uid, topic, q) => `set role authenticated; select set_config('argo.uid', '${uid}', false); select set_config('realtime.topic', '${topic}', false); ${q}`;
const send = (uid, topic) => raw(as(uid, topic, `insert into realtime.messages (topic, extension, payload) values ('${topic}', 'broadcast', '{}'::jsonb)`));
const seen = (uid, topic) => sql(as(uid, topic, `select count(*) from realtime.messages where topic = '${topic}'`)).split('\n').pop();

before(() => {
  if (!DB) return;
  sql(`
    do $$ begin if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$;
    create schema if not exists auth; grant usage on schema auth to authenticated;
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create schema if not exists realtime; grant usage on schema realtime to authenticated;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated; grant usage on all sequences in schema realtime to authenticated;`);
  const r = psqlSpawn(DB, ['-v', 'ON_ERROR_STOP=1', '-f', mig]);
  if (r.status !== 0) throw new Error(r.stderr);
  sql(`insert into realtime.messages (topic, extension, payload) values ('ot:${A}', 'broadcast', '{}'), ('ot:${B}', 'broadcast', '{}')`);
});

test('본인 토픽 ot:<나>에는 보내고 받는다', { skip }, () => {
  assert.equal(send(A, `ot:${A}`).status, 0);
  assert.notEqual(seen(A, `ot:${A}`), '0');
});

test('남의 토픽 ot:<남>에는 보낼 수도, 받을 수도 없다', { skip }, () => {
  const r = send(A, `ot:${B}`);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /row-level security/);
  assert.equal(seen(A, `ot:${B}`), '0');
});

test('이 정책이 다른 토픽(u:·org:)을 열지 않는다', { skip }, () => {
  for (const t of [`u:${A}`, `org:${A}`, 'ot:', `ot:${A}x`]) assert.notEqual(send(A, t).status, 0, t);
});

test('로그인 안 한 세션(uid 없음)은 어디에도 못 보낸다', { skip }, () => {
  assert.notEqual(send('', 'ot:').status, 0);
});
