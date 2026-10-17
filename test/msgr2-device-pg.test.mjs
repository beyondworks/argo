// 메신저 v2 U3 기기·토큰·최소 버전(…_msgr2_device.sql — 이름 끝으로 찾는다) — 실제 Postgres에서 본다.
// 설계 2026-10-17 D9·D10, 5절 "토큰: 기기·만료·폐기"·"최소 버전"·"권한 표는 에이전트가 못 바꿈", 7절 경우 5·12·19.
// ① 등록 멱등: 1일 안 같은 값이면 쓰기 0(트랜잭션 번호 없음·xmin 그대로), 값이 바뀌거나 1일 지나면 쓴다
// ② 최소 버전 미만·약속 범위 밖 등록 거부(경우 5) ③ 폐기 직후 _msgr2_device_ok 거짓·재등록 거부·u: 방송(경우 19)
// ④ 사용자 세대를 올리면 그 사용자 기기 전부 거짓 ⑤ 만료 30일 경계 ⑥ runner·resident 세션의 폐기 호출 42501, 다른 사용자 기기 폐기 불가
// ⑦ 새 기기 로그인 = 새 행, 옛 기기 영향 없음(경우 12) ⑧ 종류 잠금·세션 없음·표 직접 접근 ⑨ 보존 규칙
// JWT session_id: 실 GoTrue 토큰 대신 request.jwt.claims를 직접 넣는다(PostgREST가 넣는 방식). 실 GoTrue 미확인.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-device-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-device-pg.test.mjs';
const migDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const migBy = (suffix) => {
  const f = readdirSync(migDir).filter((x) => x.endsWith(suffix));
  assert.equal(f.length, 1, `마이그레이션 파일 하나 (${suffix}: ${f})`);
  return readFileSync(migDir + f[0], 'utf8');
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰만
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const claims = (uid, sid) => JSON.stringify({ sub: uid, role: 'authenticated', ...(sid ? { session_id: sid } : {}) });
const asQ = (uid, sid, q) => `set role authenticated; select set_config('request.jwt.claims', '${claims(uid, sid)}', false); ${q}`;
const as = (uid, sid, q) => last(sql(asQ(uid, sid, q)));
const asRaw = (uid, sid, q) => psqlRaw(['-v', 'VERBOSITY=verbose', '-A', '-t', '-c', asQ(uid, sid, q)]); // 오류에 SQLSTATE가 붙는다(ERROR:  42501: …)
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const lit = (v) => (v === null || v === undefined ? 'null' : `'${v}'`);
const regQ = ({ kind = 'app', app, ver = '0.2.0', lmin, lmax, runners = null, push = null } = {}) => {
  app ??= kind === 'app' ? 'messenger' : 'desktop';
  if (kind !== 'app') { lmin ??= 1; lmax ??= 1; }
  const arr = runners ? `array[${runners.map(lit).join(',')}]::text[]` : 'null';
  return `select public.msgr2_device_register(${lit(kind)}, ${lit(app)}, ${lit(ver)}, ${lmin ?? 'null'}, ${lmax ?? 'null'}, ${arr}, ${lit(push)})`;
};
/** 등록 한 번 — 결과 JSON과 같은 트랜잭션에서 트랜잭션 번호가 생겼는지(쓰기가 있었는지) */
const reg = (uid, sid, o) => {
  // psql은 -c의 마지막 결과만 찍는다(SHOW_ALL_RESULTS=off) — 등록 결과와 트랜잭션 번호를 한 줄로 받는다(CTE가 먼저 돈다)
  const [j, tx] = as(uid, sid, `with r as (${regQ(o)} as j) select j::text || '|' || coalesce(txid_current_if_assigned()::text, 'none') from r`).split('|');
  return { ...JSON.parse(j), txid: tx !== 'none' };
};
const regRaw = (uid, sid, o) => asRaw(uid, sid, regQ(o));
const ok = (uid, sid) => as(uid, sid, 'select public._msgr2_device_ok()') === 't';
const kindOf = (uid, sid) => as(uid, sid, `select coalesce(public._msgr2_device_kind(), '(null)')`);
const row = (sid, cols = 'xmin::text') => sql(`select ${cols} from public.msgr2_devices where session_id = '${sid}'`);
const setting = (k, v) => (v === null ? sql(`delete from public.msgr_settings where key = '${k}'`)
  : sql(`insert into public.msgr_settings (key, value) values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`));
const session = (uid) => { const s = randomUUID(); sql(`insert into auth.sessions (id, user_id) values ('${s}', '${uid}')`); return s; };

const U = Object.fromEntries(['idem', 'ver', 'rev', 'gen', 'genOther', 'exp', 'kind', 'other', 'keep'].map((k) => [k, randomUUID()]));

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
    create table if not exists auth.sessions (id uuid primary key, user_id uuid not null);
    -- 실제 Supabase auth.uid()처럼 request.jwt.claim.sub 또는 request.jwt.claims의 sub를 읽는다
    create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create schema if not exists realtime;
    create table if not exists realtime.sent (id bigint generated always as identity primary key, topic text, event text, payload jsonb);
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$
      insert into realtime.sent (topic, event, payload) values (topic, event, payload) $$;
    create table if not exists public.msgr_settings (key text primary key, value text not null); alter table public.msgr_settings enable row level security;
  `]);
  psql(['-c', migBy('_msgr_app_min_version.sql')]);
  psql(['-c', migBy('_msgr2_device.sql')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, email) values ('${id}', '${k}@example.test')`);
});

test('등록 멱등 — 1일 안 같은 값이면 쓰기 0(xmin 그대로), 값이 바뀌거나 1일이 지나면 쓴다', { skip }, () => {
  const s = session(U.idem);
  const first = reg(U.idem, s);
  assert.equal(first.wrote, true); assert.equal(first.txid, true); assert.equal(first.kind, 'app');
  assert.equal(ok(U.idem, s), true, '등록 뒤 유효');
  const x0 = row(s);
  for (let i = 0; i < 3; i++) {
    const again = reg(U.idem, s);
    assert.equal(again.wrote, false); assert.equal(again.txid, false, '두 번째 등록에 트랜잭션 번호 없음');
    assert.equal(again.device_id, first.device_id); assert.equal(again.expires_at, first.expires_at);
  }
  assert.equal(row(s), x0, '행 xmin 그대로');
  assert.equal(sql(`select count(*) from public.msgr2_devices where user_id = '${U.idem}'`), '1');
  // 값이 바뀌면 쓴다(푸시 토큰·앱 버전)
  assert.equal(reg(U.idem, s, { push: 'tok-1' }).wrote, true);
  assert.equal(reg(U.idem, s, { push: 'tok-1' }).wrote, false, '같은 토큰 다시 = 쓰기 0');
  assert.equal(reg(U.idem, s, { push: 'tok-1', ver: '0.2.1' }).wrote, true);
  // 1일 경계: 23시간 전 등록이면 쓰지 않고, 25시간 전이면 쓴다(만료 연장)
  sql(`update public.msgr2_devices set registered_at = now() - interval '23 hours', expires_at = now() - interval '23 hours' + interval '30 days' where session_id = '${s}'`);
  const x1 = row(s);
  assert.equal(reg(U.idem, s, { push: 'tok-1', ver: '0.2.1' }).txid, false, '23시간 = 쓰기 0');
  assert.equal(row(s), x1);
  sql(`update public.msgr2_devices set registered_at = now() - interval '25 hours', expires_at = now() - interval '25 hours' + interval '30 days' where session_id = '${s}'`);
  const later = reg(U.idem, s, { push: 'tok-1', ver: '0.2.1' });
  assert.equal(later.wrote, true, '25시간 = 다시 쓴다');
  assert.equal(row(s, `(expires_at - registered_at = interval '30 days')::text`), 'true', '만료 = 마지막 등록 + 30일');
});

test('경우 5: 최소 버전 미만 등록 거부 — 메신저·본체 키 따로, 숫자 비교, 거부 때 쓰기 0', { skip }, () => {
  const s = session(U.ver);
  setting('min_app_version_messenger', '0.2.0');
  fails(regRaw(U.ver, s, { ver: '0.1.113' }), /app_version_unsupported/, '0.1.113 < 0.2.0');
  assert.equal(row(s, 'count(*)'), '0', '거부하면 행을 만들지 않는다');
  assert.equal(reg(U.ver, s, { ver: '0.2.0' }).wrote, true, '같은 버전은 통과');
  assert.equal(reg(U.ver, session(U.ver), { ver: '0.10.0' }).wrote, true, '0.10.0 > 0.2.0(글자 순서가 아니라 숫자)');
  assert.equal(reg(U.ver, session(U.ver), { ver: '0.2.0-beta.1' }).wrote, true, '접미사는 무시');
  fails(regRaw(U.ver, session(U.ver), { ver: 'abc' }), /msgr2_device_invalid/, '버전 모양이 아니면 거부');
  // 이미 등록한 기기도 최소 버전이 오르면 옛 버전으로 재등록할 수 없다(행은 그대로)
  setting('min_app_version_messenger', '0.3.0');
  const x = row(s);
  fails(regRaw(U.ver, s, { ver: '0.2.0' }), /app_version_unsupported/, '최소 버전 상향 뒤 재등록');
  assert.equal(row(s), x, '거부 때 행 그대로');
  setting('min_app_version_messenger', null);
  // 본체(runner)는 desktop 키, 메신저 키와 섞이지 않는다
  setting('min_app_version', '0.1.120');
  fails(regRaw(U.ver, session(U.ver), { kind: 'runner', ver: '0.1.119' }), /app_version_unsupported/, '본체 0.1.119 < 0.1.120');
  assert.equal(reg(U.ver, session(U.ver), { kind: 'runner', ver: '0.1.120' }).kind, 'runner');
  assert.equal(reg(U.ver, session(U.ver), { ver: '0.0.1' }).wrote, true, '메신저 앱은 desktop 키에 막히지 않는다');
  setting('min_app_version', null);
  // 약속 버전: 서버 범위 [2,3] 밖의 본체 거부, 겹치면 통과
  setting('link_min_v', '2'); setting('link_max_v', '3');
  fails(regRaw(U.ver, session(U.ver), { kind: 'runner', lmin: 1, lmax: 1 }), /link_version_unsupported/, '본체 [1,1] vs 서버 [2,3]');
  fails(regRaw(U.ver, session(U.ver), { kind: 'runner', lmin: 4, lmax: 5 }), /link_version_unsupported/, '본체 [4,5] vs 서버 [2,3]');
  assert.equal(reg(U.ver, session(U.ver), { kind: 'runner', lmin: 1, lmax: 2 }).kind, 'runner');
  setting('link_min_v', null); setting('link_max_v', null);
  fails(asRaw(U.ver, session(U.ver), `select public.msgr2_device_register('runner', 'desktop', '0.2.0')`), /msgr2_device_invalid/, '본체는 약속 범위를 꼭 알린다');
  fails(asRaw(U.ver, session(U.ver), `select public.msgr2_device_register('app', 'messenger', '0.2.0', 1, 1)`), /msgr2_device_invalid/, '앱은 약속 범위를 싣지 않는다');
  fails(asRaw(U.ver, session(U.ver), `select public.msgr2_device_register('app', 'desktop', '0.2.0')`), /msgr2_device_invalid/, '종류와 앱이 어긋남');
});

test('경우 19: 폐기 직후 _msgr2_device_ok 거짓 — 재등록·목록 거부, u: 방송, 다시 폐기는 쓰기 0', { skip }, () => {
  const phone = session(U.rev); const pc = session(U.rev);
  reg(U.rev, phone); const target = reg(U.rev, pc, { kind: 'runner', runners: ['claude'] }).device_id;
  assert.equal(ok(U.rev, pc), true);
  const sent0 = Number(sql(`select count(*) from realtime.sent where topic = 'u:${U.rev}' and event = 'device_revoked'`));
  assert.equal(as(U.rev, phone, `select public.msgr2_device_revoke('${target}')`), 't');
  assert.equal(ok(U.rev, pc), false, '폐기 직후 거짓');
  assert.equal(kindOf(U.rev, pc), '(null)');
  assert.equal(ok(U.rev, phone), true, '폐기한 앱 기기는 그대로');
  fails(regRaw(U.rev, pc, { kind: 'runner', runners: ['claude'] }), /device_revoked/, '폐기된 세션은 다시 등록해도 살아나지 않는다');
  fails(asRaw(U.rev, pc, 'select count(*) from public.msgr2_devices_list()'), /device_revoked/, '폐기된 세션은 목록도 못 본다');
  assert.equal(Number(sql(`select count(*) from realtime.sent where topic = 'u:${U.rev}' and event = 'device_revoked' and payload->>'device_id' = '${target}'`)), sent0 + 1, 'u: 방송 1회');
  const x = sql(`select xmin::text from public.msgr2_devices where id = '${target}'`);
  assert.equal(as(U.rev, phone, `select public.msgr2_device_revoke('${target}')`), 'f', '이미 폐기 = false');
  assert.equal(sql(`select xmin::text from public.msgr2_devices where id = '${target}'`), x, '다시 폐기는 쓰기 0');
  // 자기 자신 폐기(이 기기 로그아웃)
  const me = as(U.rev, phone, `select id from public.msgr2_devices_list() where is_current`);
  assert.equal(as(U.rev, phone, `select public.msgr2_device_revoke('${me}')`), 't');
  assert.equal(ok(U.rev, phone), false);
});

test('사용자 세대를 올리면 그 사용자 기기 전부 거짓 — 다른 사용자 영향 없음, 새 로그인은 새 세대로 유효', { skip }, () => {
  const a = session(U.gen); const b = session(U.gen); const o = session(U.genOther);
  reg(U.gen, a); reg(U.gen, b, { kind: 'runner' }); reg(U.genOther, o);
  assert.equal(ok(U.gen, a) && ok(U.gen, b) && ok(U.genOther, o), true);
  sql(`insert into public.msgr2_user_gen (user_id, gen) values ('${U.gen}', 1) on conflict (user_id) do update set gen = excluded.gen`);
  assert.equal(ok(U.gen, a), false); assert.equal(ok(U.gen, b), false);
  assert.equal(ok(U.genOther, o), true, '다른 사용자 그대로');
  fails(regRaw(U.gen, a), /device_revoked/, '세대가 지난 세션은 재등록 거부');
  const n = session(U.gen);
  reg(U.gen, n);
  assert.equal(ok(U.gen, n), true, '새 로그인 = 새 세대');
  assert.equal(row(n, 'gen::text'), '1');
});

test('만료 30일 경계 — 읽을 때 계산, 만료된 세션은 재등록 거부(쓰기 0)', { skip }, () => {
  const s = session(U.exp);
  reg(U.exp, s);
  sql(`update public.msgr2_devices set registered_at = now() - interval '30 days' + interval '1 minute', expires_at = now() + interval '1 minute' where session_id = '${s}'`);
  assert.equal(ok(U.exp, s), true, '만료 1분 전 = 유효');
  sql(`update public.msgr2_devices set registered_at = now() - interval '30 days', expires_at = now() where session_id = '${s}'`);
  assert.equal(ok(U.exp, s), false, '만료 시각 = 무효(expires_at > now()만 유효)');
  sql(`update public.msgr2_devices set registered_at = now() - interval '30 days 1 second', expires_at = now() - interval '1 second' where session_id = '${s}'`);
  assert.equal(ok(U.exp, s), false, '만료 1초 뒤 = 무효');
  assert.equal(kindOf(U.exp, s), '(null)');
  const x = row(s);
  fails(regRaw(U.exp, s), /device_expired/, '만료된 세션 재등록 거부 — 다시 로그인해야 한다');
  assert.equal(row(s), x, '거부 때 쓰기 0');
});

test('권한 표는 에이전트가 못 바꿈 — runner·resident 세션의 폐기 호출 42501, 다른 사용자 기기 폐기 불가', { skip }, () => {
  const app = session(U.kind); const runner = session(U.kind); const resident = session(U.kind);
  reg(U.kind, app);
  const rid = reg(U.kind, runner, { kind: 'runner', runners: ['claude', 'codex'] }).device_id;
  reg(U.kind, resident, { kind: 'resident' });
  const appId = as(U.kind, app, `select id from public.msgr2_devices_list() where is_current`);
  for (const [label, s] of [['runner', runner], ['resident', resident]]) {
    const r = asRaw(U.kind, s, `select public.msgr2_device_revoke('${appId}')`);
    fails(r, /42501: msgr2_app_device_required/, `${label} 세션 폐기 호출 → 42501`);
  }
  assert.equal(ok(U.kind, app), true, '앱 기기 그대로');
  // 종류 잠금: runner 세션이 app으로 다시 등록해 권한을 얻을 수 없다
  fails(regRaw(U.kind, runner), /msgr2_device_kind_locked/, 'runner → app 재등록');
  assert.equal(kindOf(U.kind, runner), 'runner');
  // 다른 사용자: 내 앱 기기로 남의 기기를 폐기할 수 없다(없는 것과 같은 42501), 남의 기기 행 그대로
  const oa = session(U.other); reg(U.other, oa);
  fails(asRaw(U.other, oa, `select public.msgr2_device_revoke('${rid}')`), /42501: msgr2_device_not_found/, '남의 기기 폐기 → 42501');
  assert.equal(sql(`select coalesce(revoked_at::text, 'null') from public.msgr2_devices where id = '${rid}'`), 'null');
  assert.equal(ok(U.kind, runner), true);
  // 남의 기기는 목록에도 없다. 목록에는 세션 id·푸시 토큰 열이 없다
  assert.equal(as(U.other, oa, `select count(*) from public.msgr2_devices_list() where id = '${rid}'`), '0');
  const cols = sql(`select string_agg(p, ',') from (select unnest(proargnames) p from pg_proc where proname = 'msgr2_devices_list') x`);
  assert.doesNotMatch(cols, /session_id|push_token/);
});

test('경우 12: 새 기기 로그인 = 새 행, 옛 기기 영향 없음 · 세션 없는 요청·표 직접 접근 거부', { skip }, () => {
  const old = session(U.keep); reg(U.keep, old, { push: 'old-phone' });
  const x = row(old);
  const fresh = session(U.keep); const r = reg(U.keep, fresh, { push: 'new-phone' });
  assert.equal(r.wrote, true);
  assert.equal(ok(U.keep, old), true, '옛 기기 그대로 유효');
  assert.equal(row(old), x, '옛 기기 행 쓰기 0');
  assert.equal(as(U.keep, fresh, 'select count(*) from public.msgr2_devices_list()'), '2');
  // JWT에 session_id가 없으면 등록 거부, 판정 거짓
  fails(regRaw(U.keep, null), /msgr2_session_required/, 'session_id 없는 JWT');
  assert.equal(ok(U.keep, null), false);
  // 클라이언트가 표를 직접 읽고 쓰지 못한다 — 세대 표도
  for (const q of [`select * from public.msgr2_devices`, `update public.msgr2_devices set revoked_at = null`, `insert into public.msgr2_user_gen (user_id, gen) values ('${U.keep}', 0)`]) {
    assert.notEqual(asRaw(U.keep, fresh, q).status, 0, q);
  }
  // anon은 등록 함수를 부를 수 없다
  const anon = psqlRaw(['-A', '-t', '-c', `set role anon; ${regQ()}`]);
  fails(anon, /permission denied/, 'anon 등록');
});

test('보존 규칙 — 새 기기를 만들 때 60일 넘게 등록이 없고 세션도 사라진 내 행만 지운다', { skip }, () => {
  const u = randomUUID(); sql(`insert into auth.users (id) values ('${u}')`);
  const gone = session(u); const alive = session(u); const recentGone = session(u);
  for (const s of [gone, alive, recentGone]) reg(u, s);
  sql(`update public.msgr2_devices set registered_at = now() - interval '61 days', expires_at = now() - interval '31 days' where session_id in ('${gone}', '${alive}')`);
  sql(`delete from auth.sessions where id in ('${gone}', '${recentGone}')`);
  const other = session(U.keep); // 다른 사용자의 오래된 행은 건드리지 않는다
  sql(`update public.msgr2_devices set registered_at = now() - interval '61 days' where user_id = '${U.keep}'`);
  sql(`delete from auth.sessions where user_id = '${U.keep}' and id <> '${other}'`);
  const keepRows = sql(`select count(*) from public.msgr2_devices where user_id = '${U.keep}'`);
  reg(u, session(u));
  assert.equal(row(gone, 'count(*)'), '0', '60일 + 세션 없음 = 지움');
  assert.equal(row(alive, 'count(*)'), '1', '세션이 살아 있으면 남긴다(폐기·만료 표시 보존)');
  assert.equal(row(recentGone, 'count(*)'), '1', '60일 안이면 남긴다');
  assert.equal(sql(`select count(*) from public.msgr2_devices where user_id = '${U.keep}'`), keepRows, '남의 행 그대로');
  // 지운 세션으로 다시 등록해도 auth.sessions가 없으면 실서비스에서는 토큰을 받을 수 없다 — 여기서는 규칙만 본다
});
