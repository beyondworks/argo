// 옛 메신저(0.1.63 이하, v1 화면) 사용 중지(…_argo_old_msgr_cutoff.sql)를 실제 Postgres에서 본다.
// #1107(…_argo_old_app_cutoff.sql)·#1113·오피스 예외(…_argo_office_exempt.sql) 위에 얹고, 본체 판정이 그대로인지도 같이 본다.
// PostgREST 요청 하나 = 트랜잭션 하나(요청 역할 + request.* 설정 + 요청 전 함수)로 흉내 낸다. auth.sessions·refresh_tokens는 같은 모양의 대역.
// 실행: bash scripts/billing-pg-drill.sh test/argo-old-msgr-cutoff-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/argo-old-msgr-cutoff-pg.test.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIG_DIR = ROOT + 'supabase/migrations/';
const migByTail = (tail) => { const f = readdirSync(MIG_DIR).filter((n) => n.endsWith(tail)); assert.equal(f.length, 1, `${tail} 하나 (${f})`); return readFileSync(MIG_DIR + f[0], 'utf8'); };
function psql(args) { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const lit = (s) => (s === null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

// 클라이언트별 X-Client-Info(supabase-js DEFAULT_HEADERS = 'supabase-js/<판>; runtime=<환경>')
const WEB = 'supabase-js/2.114.0; runtime=web'; // 메신저 앱·웹(0.1.39 옛 판과 0.1.64+ 새 판이 같은 값 — 구분은 경로로)
const BODY_OLD = 'supabase-js/2.110.2; runtime=node; runtime-version=22.23.2'; // 0.1.106 이하 본체
const BODY_NEW = `${BODY_OLD} argo/0.1.118`;
const OFFICE = 'supabase-js/2.117.2; runtime=node; runtime-version=22.21.1, argo-office/1';
const CLI = 'supabase-js/2.110.2; runtime=node; runtime-version=22.23.2 argo/0.1.118'; // argo CLI는 본체 코드(꼬리 있음)
const PING = '/rpc/msgr_presence_ping', BADGE = '/rpc/msgr_push_badge_resync';

// 요청 하나. 결과 = 같은 트랜잭션에서 쓰기가 있었는지('none' = 쓰기 0)
function request({ sid, uid, xci = WEB, method = 'POST', path = PING, role = 'authenticated', claimsExtra = {}, rawClaims = null }) {
  const claims = rawClaims ?? JSON.stringify({ role, ...(uid ? { sub: uid } : {}), ...(sid ? { session_id: sid } : {}), ...claimsExtra });
  const hdr = JSON.stringify({ 'user-agent': 'Mozilla/5.0', ...(xci === null ? {} : { 'x-client-info': xci }) });
  return last(sql(`set local role ${role};
    select set_config('request.method', ${lit(method)}, true), set_config('request.path', ${lit(path)}, true), set_config('request.jwt.claims', ${lit(claims)}, true), set_config('request.headers', ${lit(hdr)}, true);
    select public.argo_old_app_check(); select coalesce(txid_current_if_assigned()::text, 'none')`));
}
function session({ uid = randomUUID(), ageMin = 600 } = {}) {
  const sid = randomUUID();
  sql(`insert into auth.sessions (id, user_id, created_at) values (${lit(sid)}, ${lit(uid)}, now() - interval '${ageMin} minutes');
       insert into auth.refresh_tokens (session_id, token) values (${lit(sid)}, 'rt-' || ${lit(sid)});`);
  return { sid, uid };
}
const alive = (sid) => sql(`select count(*) from auth.sessions where id = ${lit(sid)}`) === '1';
const tokens = (sid) => Number(sql(`select count(*) from auth.refresh_tokens where session_id = ${lit(sid)}`));
const rec = (sid) => sql(`select coalesce(cut_at is not null, false)::text || '|' || coalesce(client_info, '') from public.argo_old_app_sessions where session_id = ${lit(sid)}`);
const set = (key, on) => sql(on ? `insert into public.msgr_settings (key, value) values (${lit(key)}, 'on') on conflict (key) do update set value = excluded.value` : `delete from public.msgr_settings where key = ${lit(key)}`);
const msgrOn = (v = true) => set('old_msgr_cutoff', v);
const bodyOn = (v = true) => set('old_app_cutoff', v);
const reset = () => sql('delete from auth.sessions; delete from public.argo_gate_sessions; delete from public.argo_old_app_sessions; delete from public.msgr_settings');
const counts = () => sql('select (select count(*) from auth.sessions) || \'/\' || (select count(*) from public.argo_old_app_sessions)');

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
    create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now(),
      updated_at timestamptz, refreshed_at timestamp, user_agent text, ip inet, oauth_client_id uuid);
    create table if not exists auth.refresh_tokens (id bigserial primary key, session_id uuid references auth.sessions(id) on delete cascade, token text);
    create table if not exists public.msgr_settings (key text primary key, value text not null); alter table public.msgr_settings enable row level security;
  `]);
  psql(['-c', migByTail('_msgr_app_min_version.sql')]);
  psql(['-c', migByTail('_argo_old_app_cutoff.sql')]);
  psql(['-c', migByTail('_argo_old_desktop_session_purge.sql')]);
  psql(['-c', migByTail('_argo_office_exempt.sql')]);
  psql(['-c', migByTail('_argo_old_msgr_cutoff.sql')]);
});

test('옛 메신저: 웹 클라이언트의 심박·배지 POST에서 바로 폐기(refresh 토큰도 함께), 기록은 msgr| 표지 — 요청은 실패하지 않는다', { skip }, () => {
  reset(); msgrOn();
  for (const path of [PING, BADGE]) {
    const s = session();
    assert.notEqual(request({ ...s, path }), 'none', `${path}: 폐기 쓰기`);
    assert.ok(!alive(s.sid), `${path}: 세션 폐기`);
    assert.equal(tokens(s.sid), 0, `${path}: refresh 토큰도 FK로 함께`);
    assert.equal(rec(s.sid), `true|msgr|${WEB}`, `${path}: 기록`);
  }
});

test('옛 메신저로 다시 로그인한 새 세션도 첫 심박·배지 POST에서 다시 폐기된다 — 같은 계정의 다른 세션(새 판 기기)은 그대로', { skip }, () => {
  reset(); msgrOn();
  const uid = randomUUID();
  const first = session({ uid }); request(first);
  const relogin = session({ uid, ageMin: 1 }); // 방금 로그인(본체 장치의 2시간 유예와 달리 메신저 지문은 확정이라 기다리지 않는다)
  const v2 = session({ uid });
  request({ ...v2, path: '/rpc/msgr2_device_register' });
  request({ ...relogin, path: BADGE });
  assert.ok(!alive(first.sid) && !alive(relogin.sid), '옛 세션 둘 다 폐기');
  assert.ok(alive(v2.sid), '같은 계정의 v2 기기 세션은 살아 있다');
});

test('스위치: old_msgr_cutoff가 없으면 폐기 0·쓰기 0, 본체 스위치(old_app_cutoff)만 켜도 메신저는 폐기하지 않는다, 끄면 그 뒤로 0', { skip }, () => {
  reset();
  const a = session();
  assert.equal(request(a), 'none'); assert.ok(alive(a.sid), '스위치 없음');
  bodyOn();
  assert.equal(request(a), 'none'); assert.ok(alive(a.sid), '본체 스위치만 켬 — 메신저 갈래는 따로');
  msgrOn(); request(a); assert.ok(!alive(a.sid), '켜면 폐기');
  msgrOn(false);
  const b = session();
  assert.equal(request(b), 'none'); assert.ok(alive(b.sid), '끈 뒤 새 폐기 0');
  set('old_msgr_cutoff', false); sql(`insert into public.msgr_settings (key, value) values ('old_msgr_cutoff', 'ON')`);
  assert.equal(request(b), 'none'); assert.ok(alive(b.sid), "값은 소문자 'on'만 켜짐");
});

test('지금 메신저 v2(0.1.64+)가 실제로 보내는 요청은 같은 웹 값이어도 대상이 아니다 — 쓰기 0', { skip }, () => {
  reset(); msgrOn(); bodyOn();
  const s = session();
  const v2Requests = [ // v2 셸·연결 상태 기계·어댑터가 원래 클라이언트로 보내는 것(apps/messenger/src/v2/source.mjs RPCS.keep·msgr2_*, link/policy.mjs)
    ['POST', '/rpc/argo_min_app_version'], ['POST', '/rpc/msgr2_device_register'], ['POST', '/rpc/msgr2_catch_up'], ['POST', '/rpc/msgr2_service_pause'],
    ['POST', '/rpc/msgr_people_names'], ['POST', '/rpc/msgr_my_friends'], ['POST', '/rpc/my_plan'], ['POST', '/rpc/msgr_service_pause'],
    ['POST', '/rpc/msgr_friend_request'], ['POST', '/msgr2_reads'], ['GET', '/msgr2_messages'], ['GET', '/msgr_profiles'],
    ['GET', PING], ['HEAD', BADGE], // GET·HEAD는 읽기 전용 — 경로가 같아도 손대지 않는다
  ];
  for (const [method, path] of v2Requests) assert.equal(request({ ...s, method, path }), 'none', `${method} ${path}`);
  assert.ok(alive(s.sid)); assert.equal(counts(), '1/0');
});

test('본체(node)·CLI·오피스·VPS 봇·원격 MCP·익명·service_role은 메신저 갈래에 걸리지 않는다 — 본체 판정은 종전 그대로', { skip }, () => {
  reset(); msgrOn();
  const cases = [
    ['새 본체(꼬리)', { xci: BODY_NEW }], ['CLI(꼬리)', { xci: CLI }], ['오피스', { xci: OFFICE }], ['X-Client-Info 없음(plain fetch)', { xci: null }],
    ['웹이지만 supabase-js가 아닌 값', { xci: 'custom-web-client/1; runtime=web' }],
    ['원격 MCP(client_id)', { claimsExtra: { client_id: 'mcp' } }], ['익명', { role: 'anon' }], ['service_role(VPS 봇 서버 함수)', { role: 'service_role' }],
  ];
  for (const [name, opt] of cases) {
    const s = session();
    for (const path of [PING, BADGE]) assert.equal(request({ ...s, path, ...opt }), 'none', `${name} ${path}`);
    assert.ok(alive(s.sid), name);
  }
  // 옛 본체(node 2.110.2)가 같은 경로를 불러도 메신저 갈래가 아니라 본체 판정(스위치 꺼짐 → 0)으로 간다
  const ob = session();
  assert.equal(request({ ...ob, xci: BODY_OLD }), 'none', '본체 스위치 꺼짐: 옛 본체도 0');
  bodyOn();
  request({ ...ob, xci: BODY_OLD });
  assert.equal(rec(ob.sid), `false|${BODY_OLD}`, '본체 판정 = 종전(첫 POST는 의심 표시만, 메신저 표지 없음)');
  assert.ok(alive(ob.sid), '35분 전에는 끊지 않는다(종전)');
});

test('어떤 입력에도 요청을 실패시키지 않는다 — 깨진 claims·세션 id 형식 오류·auth.sessions에 없는 세션', { skip }, () => {
  reset(); msgrOn();
  assert.doesNotThrow(() => request({ rawClaims: '{깨진' }));
  assert.doesNotThrow(() => request({ uid: randomUUID(), sid: 'not-a-uuid' }));
  const ghost = { sid: randomUUID(), uid: randomUUID() };
  assert.doesNotThrow(() => request(ghost));
  assert.equal(sql(`select count(*) from public.argo_old_app_sessions where session_id = ${lit(ghost.sid)}`), '0', '없는 세션은 기록도 0');
});

test('다시 적용해도 같다(멱등) — 등록(pgrst.db_pre_request)은 그대로 이 함수', { skip }, () => {
  psql(['-c', migByTail('_argo_old_msgr_cutoff.sql')]);
  assert.match(sql(`select array_to_string(rolconfig, ',') from pg_roles where rolname = 'authenticator'`), /pgrst\.db_pre_request=public\.argo_old_app_check/);
  reset(); msgrOn();
  const s = session(); request(s); assert.ok(!alive(s.sid));
});

test('되돌림 파일 — 함수가 오피스 예외 본문(20261020201800)으로 돌아가 옛 메신저를 끊지 않고, 등록은 그대로', { skip }, () => {
  const down = readFileSync(ROOT + 'scripts/rollback/20261027220000_argo_old_msgr_cutoff.down.sql', 'utf8');
  psql(['-c', down]);
  const def = sql(`select prosrc from pg_proc where proname = 'argo_old_app_check'`);
  const office = migByTail('_argo_office_exempt.sql'); const i = office.indexOf('create or replace function public.argo_old_app_check('); const a = office.indexOf('$$', i) + 2;
  assert.equal(def.trim(), office.slice(a, office.indexOf('$$', a)).trim(), '오피스 예외 본문 그대로');
  assert.ok(!def.includes('old_msgr_cutoff'), '메신저 갈래 없음');
  assert.match(sql(`select array_to_string(rolconfig, ',') from pg_roles where rolname = 'authenticator'`), /pgrst\.db_pre_request=public\.argo_old_app_check/);
  reset(); msgrOn();
  const s = session(); assert.equal(request(s), 'none'); assert.ok(alive(s.sid), '되돌린 뒤 옛 메신저 폐기 0');
  psql(['-c', migByTail('_argo_old_msgr_cutoff.sql')]); // 끝 상태를 맞춘다
});
