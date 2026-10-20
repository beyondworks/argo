// 본체 연결부(U4 src/agent-link-host.mjs)의 기기 등록 인자 × U3 msgr2_device_register(…_msgr2_device.sql)를 실제 Postgres에서 맞춰 본다
// (PR #1074 분리 검수 높음 1, 2026-10-17: 이름 없는 인자 kind·app 'argo'로 보내 22023/PGRST202로 거부되던 것).
// runnerRegisterArgs가 만든 객체를 **이름 있는 인자**(p_kind => …)로 그대로 부른다 — PostgREST가 JSON 키를 함수 인자 이름에 잇는 것과 같다.
// 키 이름이나 app 값이 함수와 어긋나면 이 시험이 빨강이 된다. 로그인 지점(registerRunnerOnLogin)도 같은 함수로 돌린다.
// 적용: _msgr_app_min_version → U1(_msgr2_space.sql) → U3(_msgr2_device.sql) — U3 시험(msgr2-device-pg)과 같은 순서.
// JWT session_id: 실 GoTrue 토큰 대신 request.jwt.claims를 직접 넣는다(PostgREST가 넣는 방식). 실 GoTrue·실 PostgREST 미확인.
// 건너뜀: ARGO_PG_TEST_URL 미설정. 실행: bash scripts/billing-pg-drill.sh test/agent-link-register-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { psqlSpawn } from './helpers/pg.mjs';
import { runnerRegisterArgs, registerRunnerOnLogin } from '../src/agent-link-host.mjs';
import { APP_VERSION } from '../src/app-version.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/agent-link-register-pg.test.mjs';
const migDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const migBy = (suffix) => {
  const f = readdirSync(migDir).filter((x) => x.endsWith(suffix));
  assert.equal(f.length, 1, `마이그레이션 파일 하나 (${suffix}: ${f})`);
  return readFileSync(migDir + f[0], 'utf8');
};
const psql = (args) => { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; };
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const val = (v) => (Array.isArray(v) ? `array[${v.map(lit).join(',')}]::text[]` : typeof v === 'number' ? String(v) : lit(v));
const ident = (k) => { assert.match(k, /^[a-z_][a-z0-9_]*$/, `인자 이름 모양: ${k}`); return k; };

/** PostgREST처럼: 역할·JWT 클레임을 넣고, JSON 키를 이름 있는 인자로 잇는다. 오류는 { code: SQLSTATE, message, status }. */
function rpcAs(uid, sid, name, args) {
  const claims = JSON.stringify({ sub: uid, role: 'authenticated', session_id: sid });
  const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${val(v)}`).join(', ');
  const q = `set role authenticated; select set_config('request.jwt.claims', '${claims}', false); select public.${ident(name)}(${named})::text`;
  const r = psqlSpawn(DB, ['-v', 'VERBOSITY=verbose', '-A', '-t', '-c', q]);
  if (r.status === 0) return { data: JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()), error: null };
  const m = r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]+)/);
  const code = m?.[1] ?? 'unknown';
  // PostgREST: 42883(이름·인자가 맞는 함수 없음) → PGRST202 404, 42501 → 403, 22023·P0001 → 400
  return { data: null, error: { code: code === '42883' ? 'PGRST202' : code, message: (m?.[2] ?? r.stderr).trim(), status: code === '42883' ? 404 : code === '42501' ? 403 : 400 } };
}
const session = (uid) => { const s = randomUUID(); sql(`insert into auth.sessions (id, user_id) values ('${s}', '${uid}')`); return s; };
const rowOf = (sid) => sql(`select kind || '|' || app || '|' || app_version || '|' || lower(link_v)::text || '-' || (upper(link_v) - 1)::text || '|' || array_to_string(runners, ',') from public.msgr2_devices where session_id = '${sid}'`);

const U = { conn: randomUUID(), login: randomUUID() };

before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    create extension if not exists pgcrypto;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth; grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now());
    create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create schema if not exists realtime;
    create table if not exists realtime.sent (id bigint generated always as identity primary key, topic text, event text, payload jsonb);
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$
      insert into realtime.sent (topic, event, payload) values (topic, event, payload) $$;
    create table if not exists public.msgr_settings (key text primary key, value text not null); alter table public.msgr_settings enable row level security;
  `]);
  psql(['-c', migBy('_msgr_app_min_version.sql')]);
  psql(['-c', migBy('_msgr2_space.sql')]); // U1(버전 순서 U1 → U3)
  psql(['-c', migBy('_msgr2_device.sql')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, email) values ('${id}', '${k}@example.test')`);
});

test('연결부 시작 인자(runnerRegisterArgs) 그대로 실제 함수 호출 — 등록 성공, kind=runner·app=desktop으로 잠긴다', { skip }, () => {
  assert.ok(APP_VERSION, '본체 버전을 읽는다');
  const sid = session(U.conn);
  const args = runnerRegisterArgs({ appVersion: APP_VERSION, runners: ['codex', 'claude'] });
  const r = rpcAs(U.conn, sid, 'msgr2_device_register', args);
  assert.equal(r.error, null, `등록 거부: ${JSON.stringify(r.error)}`);
  assert.ok(r.data.device_id);
  assert.equal(r.data.kind, 'runner');
  assert.equal(rowOf(sid), `runner|desktop|${APP_VERSION}|${args.p_link_min}-${args.p_link_max}|claude,codex`);
  // 같은 세션은 runner로 잠긴다: 에이전트 셸이 이 세션으로 app 기기 등록을 시도하면 42501
  const asApp = rpcAs(U.conn, sid, 'msgr2_device_register', { p_kind: 'app', p_app: 'messenger', p_app_version: '0.2.0' });
  assert.equal(asApp.error?.code, '42501');
  assert.match(asApp.error.message, /msgr2_device_kind_locked/);
  assert.equal(rowOf(sid).split('|')[0], 'runner', '행은 그대로 runner');
  // 다시 시작해도(같은 인자) 같은 기기, 쓰기 0
  const again = rpcAs(U.conn, sid, 'msgr2_device_register', args);
  assert.equal(again.data.device_id, r.data.device_id);
  assert.equal(again.data.wrote, false);
});

test('로그인 지점(registerRunnerOnLogin)이 실제 함수로 runner 기기를 만든다', { skip }, async () => {
  const sid = session(U.login);
  const calls = [];
  const mkClient = () => ({ rpc: async (name, args) => { calls.push(name); return rpcAs(U.login, sid, name, args); } });
  const r = await registerRunnerOnLogin({ url: 'u', anonKey: 'k', accessToken: 't' }, { mkClient, appVersion: APP_VERSION, runners: ['claude'], sleep: async () => {}, log: () => {} });
  assert.equal(r.ok, true, `로그인 등록 실패: ${r.code}`);
  assert.equal(calls.length, 1, '한 번에 성공');
  assert.equal(sql(`select kind || '|' || app from public.msgr2_devices where session_id = '${sid}'`), 'runner|desktop');
});
