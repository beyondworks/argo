// 메신저 v2 연결(U5) × U3 기기 등록(…_msgr2_device.sql)을 실제 Postgres에서 맞춰 본다(검수 2, 2026-10-17).
// 등록 RPC만 진짜 함수를 부르고(psql, PostgREST처럼 request.jwt.claims를 넣는다), 오류는 PostgREST 모양({ code: SQLSTATE, message })으로 바꿔
// policy.rejectCodeOf·상태 기계에 그대로 넣는다. 나머지(최소 버전·중단·따라잡기·Realtime)는 비어 있는 가짜다.
// 건너뜀: ARGO_PG_TEST_URL이 없거나 U3 마이그레이션이 없을 때(저장소에 없으면 MSGR2_U3_MIG=<경로>).
// 실행 예: ARGO_PG_TEST_URL=postgres://… MSGR2_U3_MIG=<U3 sql> node --test apps/messenger/test/link-u3-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { psqlSpawn } from '../../../test/helpers/pg.mjs';
import { createLinkMachine } from '../src/link/machine.mjs';
import { rejectCodeOf } from '../src/link/policy.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const migDir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
const migBy = (suffix) => { const f = readdirSync(migDir).filter((x) => x.endsWith(suffix)); return f.length === 1 ? migDir + f[0] : null; };
const u3File = migBy('_msgr2_device.sql') || (process.env.MSGR2_U3_MIG && existsSync(process.env.MSGR2_U3_MIG) ? process.env.MSGR2_U3_MIG : null);
const skip = !DB ? 'ARGO_PG_TEST_URL 미설정' : !u3File ? 'U3 마이그레이션(_msgr2_device.sql) 없음 — MSGR2_U3_MIG로 지정' : false;

const psql = (args) => { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout; };
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const arr = (a) => (a == null ? 'null' : `array[${a.map(lit).join(',')}]::text[]`);

/** PostgREST처럼: 역할·JWT 클레임을 넣고 함수를 부른다. 오류는 { code: SQLSTATE, message }(+ PostgREST 상태). */
function callRegister(uid, sid, a) {
  const claims = JSON.stringify({ sub: uid, role: 'authenticated', ...(sid ? { session_id: sid } : {}) });
  const q = `set role authenticated; select set_config('request.jwt.claims', '${claims}', false); `
    + `select public.msgr2_device_register(${lit(a.p_kind)}, ${lit(a.p_app)}, ${lit(a.p_app_version)}, ${a.p_link_min ?? 'null'}, ${a.p_link_max ?? 'null'}, ${arr(a.p_runners)}, ${lit(a.p_push_token)})::text`;
  const r = psqlSpawn(DB, ['-v', 'VERBOSITY=verbose', '-A', '-t', '-c', q]);
  if (r.status === 0) return { data: JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()), error: null, status: 200 };
  const m = r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]+)/);
  if (!m) throw new Error(`psql 오류 모양을 못 읽음: ${r.stderr}`);
  const status = m[1] === '42501' ? 403 : 400; // PostgREST: insufficient_privilege(인증됨) 403, 22023·P0001 400
  return { data: null, error: { code: m[1], message: m[2].trim(), details: null, hint: null }, status };
}

function client(uid, sid) {
  const log = [];
  return {
    log,
    rpc: async (name, args) => {
      log.push(name);
      if (name === 'msgr2_device_register') return callRegister(uid, sid, args);
      if (name === 'msgr2_catch_up') return { data: { rooms: [] }, error: null, status: 200 };
      return { data: null, error: null, status: 200 }; // 최소 버전 없음·중단 아님
    },
    channel: () => ({ on() { return this; }, subscribe(cb) { queueMicrotask(() => cb('SUBSCRIBED')); return this; } }),
    removeChannel: () => {},
    from: () => { throw new Error('REST 없음'); },
    storage: {},
  };
}
const fakeClock = () => ({ now: () => 1e6, setTimeout: () => 0, clearTimeout: () => {} });
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function run(uid, sid) {
  const c = client(uid, sid);
  const m = createLinkMachine({ client: c, userId: uid, appVersion: '0.2.0', storage: null, clock: fakeClock(), random: () => 1 });
  await m.start(); await flush();
  return { snap: m.getSnapshot(), log: c.log };
}
const user = () => { const u = randomUUID(); sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test')`); return u; };
const session = (u, ago = '0 minutes') => { const s = randomUUID(); sql(`insert into auth.sessions (id, user_id, created_at) values ('${s}', '${u}', now() - interval '${ago}')`); return s; };

before(() => {
  if (skip) return;
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
  psql(['-c', readFileSync(migBy('_msgr_app_min_version.sql'), 'utf8')]);
  psql(['-c', readFileSync(u3File, 'utf8')]);
});

test('실제 U3: 앱 등록 인자(약속 범위 null)로 새 기기 등록 → ready', { skip }, async () => {
  const u = user(); const s = session(u);
  const { snap, log } = await run(u, s);
  assert.equal(snap.state, 'ready', JSON.stringify(snap));
  assert.ok(snap.deviceId);
  assert.equal(sql(`select kind || '/' || app || '/' || coalesce(lower(link_v::text), 'null') from public.msgr2_devices where session_id = '${s}'`), 'app/messenger/null');
  assert.deepEqual(log, ['argo_min_app_version', 'msgr2_service_pause', 'msgr2_device_register', 'msgr2_catch_up']);
});

test('실제 U3: 앱이 약속 범위를 실으면 22023 msgr2_device_invalid → invalid(로그아웃 아님)', { skip }, () => {
  const u = user(); const s = session(u);
  const r = callRegister(u, s, { p_kind: 'app', p_app: 'messenger', p_app_version: '0.2.0', p_link_min: 1, p_link_max: 1, p_runners: [], p_push_token: null });
  assert.equal(r.error?.code, '22023'); assert.match(r.error.message, /msgr2_device_invalid/);
  assert.equal(rejectCodeOf(r.error, r.status), 'invalid');
});

test('실제 U3: 다시 로그인해야 하는 거부 3종 → signed_out(login_required), 재시도 0', { skip }, async () => {
  const old = user(); const oldS = session(old, '30 minutes');
  const noSid = user();
  const locked = user(); const lockedS = session(locked);
  const asRunner = callRegister(locked, lockedS, { p_kind: 'runner', p_app: 'desktop', p_app_version: '0.2.0', p_link_min: 1, p_link_max: 1, p_runners: ['claude'], p_push_token: null });
  assert.equal(asRunner.error, null, '같은 세션을 본체 기기로 먼저 등록');
  for (const [label, uid, sid, msg] of [
    ['10분 지난 세션의 새 기기', old, oldS, /device_login_required/],
    ['JWT에 session_id 없음', noSid, null, /msgr2_session_required/],
    ['종류 잠금', locked, lockedS, /msgr2_device_kind_locked/],
  ]) {
    const raw = callRegister(uid, sid, { p_kind: 'app', p_app: 'messenger', p_app_version: '0.2.0', p_link_min: null, p_link_max: null, p_runners: [], p_push_token: null });
    assert.match(raw.error?.message ?? '', msg, label);
    assert.equal(rejectCodeOf(raw.error, raw.status), 'login_required', label);
    const { snap, log } = await run(uid, sid);
    assert.equal(snap.state, 'signed_out', label); assert.equal(snap.reason, 'login_required', label);
    assert.equal(log.filter((n) => n === 'msgr2_device_register').length, 1, `${label}: 재시도 0`);
  }
});
