// 0.1.106 이하 본체 앱 사용 중지 장치(…_argo_old_app_cutoff.sql — 번호는 이름 끝으로 찾는다)를 실제 Postgres에서 본다.
// PostgREST 요청 하나 = 트랜잭션 하나(요청 역할 + request.method·request.jwt.claims·request.headers 설정 + 요청 전 함수)로 흉내 낸다.
// auth.sessions·refresh_tokens는 Supabase와 같은 모양의 대역(FK on delete cascade)이다.
// 실행: bash scripts/billing-pg-drill.sh test/argo-old-app-cutoff-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { psqlSpawn } from './helpers/pg.mjs';
import * as childProcess from 'node:child_process';
const require_child = () => childProcess;

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/argo-old-app-cutoff-pg.test.mjs';
const MIG_DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const migByTail = (tail) => { const f = readdirSync(MIG_DIR).filter((n) => n.endsWith(tail)); assert.equal(f.length, 1, `${tail} 하나 (${f})`); return readFileSync(MIG_DIR + f[0], 'utf8'); };
function psql(args) { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const OLD = 'supabase-js/2.110.2; runtime=node; runtime-version=22.23.2'; // 0.1.106 실측 헤더
const NEW113 = `${OLD} argo/0.1.113`;
const WEB = 'supabase-js/2.114.0; runtime=web';
const OFFICE_SERVER = 'supabase-js/2.117.2; runtime=node; runtime-version=22.21.1'; // argo-office server/agent/auth.js(Vercel Node)

// 요청 하나. 결과 = 같은 트랜잭션 끝의 txid_current_if_assigned()(쓰기가 있었는지)
function request({ sid, uid, xci = OLD, method = 'POST', role = 'authenticated', headers = {}, claimsExtra = {}, path = '/rpc/msgr_notification_claim', body = 'select public.argo_old_app_check()' }) {
  const claims = JSON.stringify({ role, ...(uid ? { sub: uid } : {}), ...(sid ? { session_id: sid } : {}), ...claimsExtra });
  const hdr = JSON.stringify({ 'user-agent': 'node', ...(xci === null ? {} : { 'x-client-info': xci }), ...headers });
  return last(sql(`set local role ${role};
    select set_config('request.method', ${lit(method)}, true), set_config('request.path', ${lit(path)}, true), set_config('request.jwt.claims', ${lit(claims)}, true), set_config('request.headers', ${lit(hdr)}, true);
    ${body}; select coalesce(txid_current_if_assigned()::text, 'none')`)); // -c 한 번 = 암묵 트랜잭션 하나(마지막 문장 결과만 읽는다)
}
// 관문 요청: PostgREST처럼 요청 전 함수 → 본 쿼리 순서
const gate = (sid, uid, xci = OLD) => request({ sid, uid, xci, path: '/rpc/argo_min_app_version', body: `select public.argo_old_app_check(); select public.argo_min_app_version('desktop')` });
function session({ ageMin = 180, uid = randomUUID() } = {}) {
  const sid = randomUUID();
  sql(`insert into auth.sessions (id, user_id, created_at) values (${lit(sid)}, ${lit(uid)}, now() - interval '${ageMin} minutes');
       insert into auth.refresh_tokens (session_id, token) values (${lit(sid)}, 'rt-' || ${lit(sid)})`);
  return { sid, uid };
}
const alive = (sid) => sql(`select count(*) from auth.sessions where id = ${lit(sid)}`) === '1';
const tokens = (sid) => Number(sql(`select count(*) from auth.refresh_tokens where session_id = ${lit(sid)}`));
const row = (sid) => { const r = sql(`select coalesce(cut_at::text, '-') || '|' || (due_at <= now())::text from public.argo_old_app_sessions where session_id = ${lit(sid)}`); return r ? { cut: r.split('|')[0] !== '-', due: r.split('|')[1] === 'true' } : null; };
const makeDue = (sid) => sql(`update public.argo_old_app_sessions set due_at = now() - interval '1 second' where session_id = ${lit(sid)}`);
const on = () => sql(`insert into public.msgr_settings (key, value) values ('old_app_cutoff', 'on') on conflict (key) do update set value = excluded.value`);
const off = () => sql(`delete from public.msgr_settings where key = 'old_app_cutoff'`);
// 옛 세션을 끝까지(표시 → 35분 뒤 → 폐기)
function cutThrough(s) { request(s); makeDue(s.sid); request(s); }

before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ declare r text; begin
      foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator'] loop
        if not exists (select from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
      end loop;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth;
    create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now());
    create table if not exists auth.refresh_tokens (id bigserial primary key, session_id uuid references auth.sessions(id) on delete cascade, token text);
    create table if not exists public.msgr_settings (key text primary key, value text not null); alter table public.msgr_settings enable row level security;
  `]);
  psql(['-c', migByTail('_msgr_app_min_version.sql')]);
  psql(['-c', migByTail('_argo_old_app_cutoff.sql')]);
});

test('등록 — authenticator의 PostgREST 요청 전 함수가 이 장치다', { skip }, () => {
  assert.match(sql(`select array_to_string(rolconfig, ',') from pg_roles where rolname = 'authenticator'`), /pgrst\.db_pre_request=public\.argo_old_app_check/);
});

test('스위치가 꺼져 있으면 옛 세션도 쓰기 0·폐기 0 (요청마다 설정 행 하나만 읽는다)', { skip }, () => {
  off();
  const s = session();
  for (let i = 0; i < 3; i++) assert.equal(request(s), 'none', '쓰기 없음');
  assert.equal(row(s.sid), null); assert.ok(alive(s.sid));
});

test('옛 앱 세션: 첫 POST는 표시만, 35분 전엔 그대로, 35분 뒤 POST에서 폐기(refresh 토큰도 함께) — 요청은 실패하지 않는다', { skip }, () => {
  on();
  const s = session();
  assert.notEqual(request(s), 'none', '표시 쓰기');
  assert.deepEqual(row(s.sid), { cut: false, due: false }); assert.ok(alive(s.sid));
  assert.equal(last(sql(`select (due_at between now() + interval '34 minutes' and now() + interval '36 minutes')::text from public.argo_old_app_sessions where session_id = ${lit(s.sid)}`)), 'true', '35분 뒤 확인');
  assert.equal(request(s), 'none', '35분 전 재요청은 쓰기 0'); assert.ok(alive(s.sid));
  makeDue(s.sid);
  request(s);
  assert.equal(alive(s.sid), false, '세션 폐기'); assert.equal(tokens(s.sid), 0, 'refresh 토큰도 사라져 "Refresh Token Not Found"가 된다');
  assert.equal(row(s.sid).cut, true);
  assert.equal(request(s), 'none', '이미 폐기된 세션의 남은 접근 토큰 요청은 쓰기 0');
  off();
});

test('새 앱(관문을 부른 세션)은 끊지 않는다 — 같은 계정의 옛 세션만 끊긴다', { skip }, () => {
  on();
  const uid = randomUUID();
  const fresh = session({ uid }), old = session({ uid });
  gate(fresh.sid, uid);
  cutThrough(fresh); cutThrough(old);
  assert.ok(alive(fresh.sid), '새 앱 그대로'); assert.equal(row(fresh.sid), null);
  assert.equal(alive(old.sid), false, '옛 앱 폐기');
  off();
});

test('메신저·웹(runtime=web), 오피스(plain fetch·서버 supabase-js 2.117.2), 원격 MCP(client_id), 0.1.113+(argo/·x-argo-app-version), anon·service_role, GET은 대상이 아니다', { skip }, () => {
  on();
  const cases = [
    ['web', { xci: WEB }], ['office plain fetch', { xci: null }], ['office server 2.117.2', { xci: OFFICE_SERVER }],
    ['mcp client_id', { claimsExtra: { client_id: 'mcp-client' } }], ['other node supabase-js', { xci: 'supabase-js/2.120.0; runtime=node; runtime-version=24.1.0' }], ['argo/0.1.113', { xci: NEW113 }],
    ['x-argo-app-version', { headers: { 'x-argo-app-version': '0.1.112' } }], ['GET', { method: 'GET' }], ['HEAD', { method: 'HEAD' }],
  ];
  for (const [name, opt] of cases) {
    const s = session();
    for (let i = 0; i < 2; i++) { assert.equal(request({ ...s, ...opt }), 'none', `${name} 쓰기 0`); makeDue(s.sid); }
    assert.ok(alive(s.sid), name); assert.equal(row(s.sid), null, name);
  }
  for (const role of ['anon', 'service_role']) {
    const s = session();
    assert.equal(request({ ...s, role }), 'none', role); assert.ok(alive(s.sid), role);
  }
  off();
});

test('생긴 지 2시간이 안 된 세션은 표시하지 않는다(새 앱이 첫 관문을 부르기 전 여유)', { skip }, () => {
  on();
  const s = session({ ageMin: 100 });
  assert.equal(request(s), 'none'); assert.equal(row(s.sid), null); assert.ok(alive(s.sid));
  off();
});

test('같은 계정이 이미 한 번 끊겼으면 다시 로그인한 세션은 바로 표시한다(재로그인 반복 비용 줄이기) — 35분 대기는 그대로', { skip }, () => {
  on();
  const uid = randomUUID();
  cutThrough(session({ uid }));
  const relog = session({ uid, ageMin: 1 });
  assert.notEqual(request(relog), 'none', '1분 된 세션도 표시'); assert.deepEqual(row(relog.sid), { cut: false, due: false });
  request(relog); assert.ok(alive(relog.sid), '35분 전엔 그대로');
  makeDue(relog.sid); request(relog);
  assert.equal(alive(relog.sid), false, '35분 뒤 폐기');
  const other = session({ ageMin: 45 }); // 끊긴 적 없는 다른 계정은 2시간 기준 그대로
  assert.equal(request(other), 'none'); assert.equal(row(other.sid), null);
  off();
});

test('관문 요청은 표시가 대기 시간을 넘긴 뒤에 와도 폐기를 일으키지 않고, 기록 뒤로는 끊기지 않는다(관문 실패 뒤 5분 재시도)', { skip }, () => {
  on();
  const s = session();
  request(s); makeDue(s.sid); // 관문이 시간 초과로 실패하는 동안 동기화 POST가 표시를 남기고 대기 시간이 지남
  gate(s.sid, s.uid);         // 늦게 성공한 관문 — 요청 전 함수가 먼저 돌아도 이 요청에서는 끊지 않는다
  assert.ok(alive(s.sid), '관문 요청이 끊지 않음'); assert.equal(row(s.sid), null, '표시 지움');
  request(s); assert.ok(alive(s.sid), '그 뒤 POST도 그대로');
  off();
});

test('본 요청이 실패해 롤백되면 표시도 남지 않는다(다음 성공 요청에서 다시)', { skip }, () => {
  on();
  const s = session();
  const claims = JSON.stringify({ role: 'authenticated', sub: s.uid, session_id: s.sid });
  const r = psqlSpawn(DB, ['-A', '-t', '-c', `set local role authenticated; select set_config('request.method', 'POST', true), set_config('request.jwt.claims', ${lit(claims)}, true), set_config('request.headers', ${lit(JSON.stringify({ 'x-client-info': OLD }))}, true); select public.argo_old_app_check(); select 1/0`]);
  assert.notEqual(r.status, 0, '본 요청 실패');
  assert.equal(row(s.sid), null, '롤백으로 표시 없음');
  request(s); assert.ok(row(s.sid), '다음 요청에서 표시');
  off();
});

test('설정 표가 잠겨 있어도 요청은 200ms 안에 그대로 진행한다(lock_timeout을 삼킨다)', { skip }, () => {
  on();
  const s = session();
  const { spawn } = require_child();
  const holder = spawn('psql', [DB, '-X', '-q', '-c', 'begin; lock table public.msgr_settings in access exclusive mode; select pg_sleep(3); commit;']);
  try {
    sql(`select pg_sleep(0.5)`);
    const t0 = Date.now();
    assert.equal(request(s), 'none', '잠금 중: 요청 성공·쓰기 0');
    assert.ok(Date.now() - t0 < 2500, `기다리지 않음(${Date.now() - t0}ms)`);
  } finally { holder.kill(); }
  off();
});

test('업데이트 직후 경합: 의심 표시가 붙은 뒤 관문을 부르면 표시가 지워지고 끊기지 않는다', { skip }, () => {
  on();
  const s = session();
  request(s); // 옛 판 마지막 요청 또는 새 판의 관문보다 먼저 도착한 요청
  assert.ok(row(s.sid));
  gate(s.sid, s.uid); // 새 판이 켜지며 부른 관문
  assert.equal(row(s.sid), null, '의심 표시 지움');
  makeDue(s.sid); request(s);
  assert.ok(alive(s.sid), '끊기지 않음');
  off();
});

test('스위치를 끄면 그 뒤로 새로 표시·폐기하는 세션 0 — 이미 표시된 세션도 폐기되지 않는다', { skip }, () => {
  on();
  const marked = session();
  request(marked); makeDue(marked.sid);
  off();
  const fresh = session();
  assert.equal(request(marked), 'none'); assert.equal(request(fresh), 'none');
  assert.ok(alive(marked.sid), '표시돼 있어도 끄면 폐기 안 함'); assert.equal(row(fresh.sid), null);
});

test('관문 기록은 세션당 6시간에 한 번만 쓴다 — 30분마다 불러도 그 사이엔 쓰기 0(DB 위생 5)', { skip }, () => {
  const s = session();
  assert.notEqual(gate(s.sid, s.uid), 'none', '첫 기록');
  for (let i = 0; i < 3; i++) assert.equal(gate(s.sid, s.uid), 'none', '6시간 안 재호출 쓰기 0');
  sql(`update public.argo_gate_sessions set seen_at = now() - interval '7 hours' where session_id = ${lit(s.sid)}`);
  assert.notEqual(gate(s.sid, s.uid), 'none', '6시간 지나면 갱신');
  assert.equal(last(sql(`select (seen_at > now() - interval '1 minute')::text from public.argo_gate_sessions where session_id = ${lit(s.sid)}`)), 'true');
});

test('관문 값은 그대로 — 기록 여부와 상관없이 같은 값을 돌려준다(anon·로그인 전 포함)', { skip }, () => {
  sql(`insert into public.msgr_settings (key, value) values ('min_app_version', '0.1.107') on conflict (key) do update set value = excluded.value`);
  const s = session();
  assert.equal(request({ ...s, body: `select public.argo_min_app_version('desktop')` }).length > 0, true);
  assert.equal(last(sql(`set local role authenticated; select set_config('request.jwt.claims', ${lit(JSON.stringify({ role: 'authenticated', sub: s.uid, session_id: s.sid }))}, true); select public.argo_min_app_version('desktop')`)), '0.1.107');
  assert.equal(last(sql(`set local role anon; select public.argo_min_app_version('desktop')`)), '0.1.107', 'anon(청구 없음)');
  assert.equal(last(sql(`set local role authenticated; select set_config('request.jwt.claims', 'not json', true); select public.argo_min_app_version('desktop')`)), '0.1.107', '깨진 claims여도 값');
  sql(`delete from public.msgr_settings where key = 'min_app_version'`);
});

test('어떤 입력에도 요청을 실패시키지 않는다 — 깨진 헤더·claims, 세션 id 형식 오류, auth.sessions에 없는 세션', { skip }, () => {
  on();
  const bad = [
    `select set_config('request.method', 'POST', true), set_config('request.jwt.claims', 'not json', true); select public.argo_old_app_check()`,
    `select set_config('request.method', 'POST', true), set_config('request.jwt.claims', '{"role":"authenticated","sub":"x","session_id":"y"}', true); select public.argo_old_app_check()`,
    `select set_config('request.method', 'POST', true), set_config('request.jwt.claims', ${lit(JSON.stringify({ role: 'authenticated', sub: randomUUID(), session_id: randomUUID() }))}, true), set_config('request.headers', '{{', true); select public.argo_old_app_check()`,
  ];
  for (const b of bad) sql(`set local role authenticated; ${b}`);
  const ghost = { sid: randomUUID(), uid: randomUUID() }; // 이미 지워진(없는) 세션
  assert.equal(request(ghost), 'none'); assert.equal(row(ghost.sid), null);
  off();
});

test('다른 요청 전 함수가 이미 등록돼 있으면 마이그레이션이 덮어쓰지 않고 멈춘다 — 이 함수면 다시 적용해도 된다', { skip }, () => {
  psql(['-c', migByTail('_argo_old_app_cutoff.sql')]); // 같은 값 재적용
  sql(`alter role authenticator set pgrst.db_pre_request to 'public.someone_else'`);
  const r = psqlSpawn(DB, ['-c', migByTail('_argo_old_app_cutoff.sql')]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /덮어쓰지 않고 멈춘다/);
  assert.match(sql(`select array_to_string(rolconfig, ',') from pg_roles where rolname = 'authenticator'`), /someone_else/, '남의 값 그대로');
  sql(`alter role authenticator set pgrst.db_pre_request to 'public.argo_old_app_check'`);
});

// ── 폐기 기준 버전(old_app_cutoff_max, 2026-10-19) — 0.1.114 발행 뒤 마이그레이션 없이 "0.1.113 이하"로 넓힌다 ──
const setMax = (v) => (v == null ? sql(`delete from public.msgr_settings where key = 'old_app_cutoff_max'`)
  : sql(`insert into public.msgr_settings (key, value) values ('old_app_cutoff_max', ${lit(v)}) on conflict (key) do update set value = excluded.value`));
const H112 = { 'x-argo-app-version': '0.1.112' }; // 0.1.112·0.1.113 메신저 요청(#1050) — X-Client-Info 꼬리 없음
const TAIL114 = `${OLD} argo/0.1.114`;
const TAIL113DEV = `${OLD} argo/0.1.113`; // main 코드로 도는 개발 빌드·상주 :3001(package.json이 직전 발행 번호)
const gateVer = (sid) => sql(`select coalesce(app_version, '-') from public.argo_gate_sessions where session_id = ${lit(sid)}`);

test('기준 0.1.106(설정 없음 — 기본): 0.1.112 버전 헤더·관문 기록만 있는 세션(0.1.107~0.1.113)은 폐기하지 않는다(종전 그대로)', { skip }, () => {
  on(); setMax(null);
  const a = session(); for (let i = 0; i < 2; i++) request({ ...a, headers: H112 });
  assert.ok(alive(a.sid), '0.1.112 버전 헤더'); assert.equal(row(a.sid), null);
  const b = session(); gate(b.sid, b.uid); request(b); makeDue(b.sid); request(b);
  assert.ok(alive(b.sid), '관문만 부른 0.1.107~0.1.113');
  const c = session(); cutThrough(c); assert.ok(!alive(c.sid), '0.1.106 이하는 종전처럼 35분 뒤 폐기');
});

test('기준 0.1.113: 버전 헤더 0.1.112 → 바로 폐기, 관문 기록만(버전 없음) → 의심 → 35분 → 폐기(꼬리 없는 관문은 표시를 지우지 않음), #1065 이전 설치본 → 35분 뒤 폐기', { skip }, () => {
  on(); setMax('0.1.113');
  const a = session(); request({ ...a, headers: H112 });
  assert.ok(!alive(a.sid), '0.1.112 버전 헤더 ≤ 기준 — 대기 없이 폐기'); assert.equal(tokens(a.sid), 0); assert.deepEqual(row(a.sid), { cut: true, due: true });
  const a3 = session(); request({ ...a3, headers: { 'x-argo-app-version': '0.1.113' } });
  assert.ok(!alive(a3.sid), '0.1.113 버전 헤더도 바로 폐기');
  const b = session(); gate(b.sid, b.uid); assert.equal(gateVer(b.sid), '-', '0.1.107~0.1.113 관문 요청은 꼬리가 없다');
  request(b); assert.ok(alive(b.sid), '버전 없이 관문만 부른 세션은 바로 끊지 않는다(엄격 검수 H1)'); assert.deepEqual(row(b.sid), { cut: false, due: false });
  gate(b.sid, b.uid); assert.deepEqual(row(b.sid), { cut: false, due: false }, '꼬리 없는 관문 호출은 이 모드에서 표시를 지우지 않는다');
  makeDue(b.sid); request(b); assert.ok(!alive(b.sid), '35분 뒤에도 꼬리 있는 관문이 없으면 폐기(0.1.107~0.1.113)');
  const c = session(); request(c); assert.ok(alive(c.sid), '꼬리·헤더·관문 없는 첫 요청은 표시만'); makeDue(c.sid); request(c);
  assert.ok(!alive(c.sid), '#1065 이전 설치본 — 35분 뒤 폐기');
  setMax(null);
});

test('R1(엄격 검수 H1) 0.1.113에서 같은 로그인으로 0.1.114에 업데이트한 직후 — 꼬리 없는 POST가 꼬리 있는 관문보다 먼저 와도 살아남는다', { skip }, () => {
  on(); setMax('0.1.113');
  const s = session(); gate(s.sid, s.uid); // 업데이트 전 0.1.113이 남긴 관문 기록(버전 없음)
  for (const path of ['/rpc/my_plan', '/rest/v1/rpc/msgr_notification_claim']) request({ ...s, path }); // 0.1.114의 꼬리 없는 POST(결제 화면 등 — 0.1.114부터는 꼬리가 붙지만 서버도 막는다)
  assert.ok(alive(s.sid), '바로 폐기되지 않는다');
  gate(s.sid, s.uid, TAIL114); // 35분 안의 꼬리 있는 관문
  assert.equal(gateVer(s.sid), '0.1.114'); assert.equal(row(s.sid), null, '꼬리 있는 관문이 의심 표시를 지운다');
  for (let i = 0; i < 2; i++) request(s);
  assert.ok(alive(s.sid), '그 뒤 꼬리 없는 요청도 지킨다');
  setMax(null);
});

test('새 앱 0.1.114는 어떤 기준에서도 폐기되지 않는다 — 꼬리 있는 요청, 꼬리 있는 관문을 부른 세션의 꼬리 없는 요청, 개발 빌드(argo/0.1.113), 기준 값이 0.1.114 이상이어도', { skip }, () => {
  on();
  for (const v of ['0.1.113', '0.1.114', '9.9.9']) {
    setMax(v);
    const a = session(); for (let i = 0; i < 2; i++) request({ ...a, xci: TAIL114 }); makeDue(a.sid); request({ ...a, xci: TAIL114 });
    assert.ok(alive(a.sid), `${v}: 꼬리 있는 요청`); assert.equal(row(a.sid), null);
    const b = session(); gate(b.sid, b.uid, TAIL114); assert.equal(gateVer(b.sid), '0.1.114', '관문 기록에 버전');
    for (let i = 0; i < 2; i++) request(b); // 같은 세션의 꼬리 없는 요청(결제 화면·프로필 조회 등)
    assert.ok(alive(b.sid), `${v}: 0.1.114 세션의 꼬리 없는 요청`);
    const c = session(); gate(c.sid, c.uid, TAIL113DEV); request({ ...c, xci: TAIL113DEV }); request(c);
    assert.ok(alive(c.sid), `${v}: 개발 빌드(argo/0.1.113 꼬리)`);
    const d = session(); request({ ...d, headers: { 'x-argo-app-version': '0.1.114' } });
    assert.ok(alive(d.sid), `${v}: 버전 헤더 0.1.114(기준은 0.1.113으로 낮춰 읽는다)`);
  }
  setMax(null);
});

test('기준이 0.1.107~0.1.112 사이면 버전을 모르는 관문 세션은 건너뛰고(폐기하지 않는 쪽), 버전 헤더는 정확히 비교한다 / 틀린 값은 기본(0.1.106)', { skip }, () => {
  on(); setMax('0.1.111');
  const a = session(); gate(a.sid, a.uid); request(a); assert.ok(alive(a.sid), '관문만 부른 세션 — 0.1.112·0.1.113일 수 있어 건너뜀');
  const b = session(); request({ ...b, headers: H112 }); assert.ok(alive(b.sid), '버전 헤더 0.1.112 > 기준 0.1.111');
  setMax('0.1.112');
  const c = session(); request({ ...c, headers: H112 }); assert.ok(!alive(c.sid), '버전 헤더 0.1.112 ≤ 기준 0.1.112');
  setMax('abc');
  const d = session(); request({ ...d, headers: H112 }); assert.ok(alive(d.sid), '틀린 값 = 기본 0.1.106');
  setMax(null);
});

test('관문 기록: 꼬리 버전을 남기고, 6시간 안의 같은 버전 재호출은 쓰기 0, 꼬리가 새로 생기면(업데이트) 버전을 채운다', { skip }, () => {
  off();
  const s = session();
  gate(s.sid, s.uid); assert.equal(gateVer(s.sid), '-');
  assert.notEqual(gate(s.sid, s.uid, TAIL114), 'none', '꼬리가 새로 생기면 버전을 쓴다'); assert.equal(gateVer(s.sid), '0.1.114');
  assert.equal(gate(s.sid, s.uid, TAIL114), 'none', '같은 버전 재호출은 쓰기 0');
  assert.equal(gate(s.sid, s.uid), 'none', '꼬리 없는 재호출도 쓰기 0(버전을 지우지 않는다)'); assert.equal(gateVer(s.sid), '0.1.114');
});


test('되돌림 파일(scripts/rollback/…down.sql) — 등록이 풀리고, 관문은 옛 본문(쓰기 0), 요청 전 함수는 빈 본문으로 남는다', { skip }, () => {
  const down = readFileSync(fileURLToPath(new URL('../scripts/rollback/20261018130000_argo_old_app_cutoff.down.sql', import.meta.url)), 'utf8');
  psql(['-c', down]);
  assert.doesNotMatch(sql(`select coalesce(array_to_string(rolconfig, ','), '') from pg_roles where rolname = 'authenticator'`), /db_pre_request/);
  assert.equal(sql(`select prolang = (select oid from pg_language where lanname = 'sql') from pg_proc where proname = 'argo_old_app_check'`), 't', '빈 본문으로 남는다(지우지 않음)');
  const s0 = session(); on();
  assert.equal(request(s0), 'none', '되돌린 뒤 켜도 쓰기 0'); makeDue(s0.sid); request(s0); assert.ok(alive(s0.sid));
  off();
  assert.equal(sql(`select provolatile from pg_proc where proname = 'argo_min_app_version'`), 's', '옛 본문(stable)');
  const s = session();
  assert.equal(gate(s.sid, s.uid), 'none', '관문 호출 쓰기 0(옛 동작)');
});
