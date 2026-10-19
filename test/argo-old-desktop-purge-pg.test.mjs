// 데스크톱 옛 세션 일괄 폐기(…_argo_old_desktop_session_purge.sql + scripts/old-desktop-session-purge.sh)를 실제 Postgres에서 본다.
// auth.sessions는 Supabase GoTrue와 같은 열(user_agent·ip·refreshed_at·oauth_client_id)을 가진 대역, refresh_tokens는 FK on delete cascade.
// #1107(…_argo_old_app_cutoff.sql)이 main에 없으면 origin/feat/old-app-cutoff에서 읽는다(병합 전 의존).
// 실행: bash scripts/billing-pg-drill.sh test/argo-old-desktop-purge-pg.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, mkdtempSync, statSync, rmSync, readdirSync as ls } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/argo-old-desktop-purge-pg.test.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIG_DIR = join(ROOT, 'supabase/migrations/');
function migByTail(tail, fallbackRef) {
  const f = readdirSync(MIG_DIR).filter((n) => n.endsWith(tail));
  if (f.length === 1) return readFileSync(MIG_DIR + f[0], 'utf8');
  assert.ok(fallbackRef, `${tail} 없음`);
  const r = spawnSync('git', ['show', `${fallbackRef}:supabase/migrations/20261018130000${tail}`], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${tail}을 main에도 ${fallbackRef}에도 못 찾음 — git fetch origin feat/old-app-cutoff`);
  return r.stdout;
}
function psql(args) { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const lit = (s) => (s === null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

// 실측·관례 User-Agent
const UA = {
  node: 'node', // 본체 사이드카 Node(undici fetch) — 로그인·refresh 모두
  macWebview: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)', // 메신저 데스크톱 WKWebView
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  nodeFetch: 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
};

// 세션 하나. gate: undefined(관문 기록 없음) | null(버전 없는 관문 = 0.1.107~0.1.113) | '0.1.114' 등(꼬리 있는 관문)
function session({ uid = randomUUID(), ua = UA.node, ageMin = 600, gate, oauth = null } = {}) {
  const sid = randomUUID();
  sql(`insert into auth.sessions (id, user_id, created_at, refreshed_at, user_agent, ip, oauth_client_id)
         values (${lit(sid)}, ${lit(uid)}, now() - interval '${ageMin} minutes', now() - interval '5 minutes', ${lit(ua)}, '203.0.113.7', ${lit(oauth)});
       insert into auth.refresh_tokens (session_id, token) values (${lit(sid)}, 'rt-' || ${lit(sid)});
       ${gate === undefined ? '' : `insert into public.argo_gate_sessions (session_id, user_id, app_version) values (${lit(sid)}, ${lit(uid)}, ${lit(gate)});`}`);
  return { sid, uid };
}
const alive = (sid) => sql(`select count(*) from auth.sessions where id = ${lit(sid)}`) === '1';
const tokens = (sid) => Number(sql(`select count(*) from auth.refresh_tokens where session_id = ${lit(sid)}`));
const reasonOf = (sid) => sql(`select coalesce(reason, 'TARGET') from public._argo_old_desktop_classify() where session_id = ${lit(sid)}`);
const preview = () => JSON.parse(sql('select public.argo_old_desktop_purge_preview()'));
const run = (n, d) => JSON.parse(sql(`select public.argo_old_desktop_purge_run(${n}, ${lit(d)})`));
const runErr = (n, d) => { const r = psqlSpawn(DB, ['-A', '-t', '-c', `select public.argo_old_desktop_purge_run(${n}, ${lit(d)})`]); assert.notEqual(r.status, 0, '오류여야 한다'); return r.stderr; };
// 시험끼리 섞이지 않게: 세션·관문 기록·폐기 기록을 비운다(대역 표만)
const reset = () => sql('delete from auth.sessions; delete from public.argo_gate_sessions; delete from public.argo_old_app_sessions');
// 실행 전제(최근 6시간 버전 있는 관문 기록 ≥ 1)를 채우는 0.1.114 세션 하나 — 다른 사용자의 브라우저 UA로 둬 대상과 섞이지 않게
const newAppPresent = () => session({ gate: '0.1.114' });

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
  psql(['-c', migByTail('_argo_old_app_cutoff.sql', 'origin/feat/old-app-cutoff')]);
  psql(['-c', migByTail('_argo_old_desktop_session_purge.sql')]);
});

test('경우 표 — 세션마다 판정(대상/제외 사유)', { skip }, () => {
  reset();
  const cases = [
    ['옛 앱 0.1.106 이하(관문 기록 없음)', {}, 'TARGET'],
    ['옛 앱 0.1.107~0.1.113(버전 없는 관문)', { gate: null }, 'TARGET'],
    ['옛 앱 0.1.96(관문 기록 없음, 오래된 로그인)', { ageMin: 60 * 24 * 60 }, 'TARGET'],
    ['새 앱 0.1.114(꼬리 있는 관문)', { gate: '0.1.114' }, 'gate_versioned'],
    ['개발 빌드·상주(main 코드, argo/0.1.113 꼬리)', { gate: '0.1.113' }, 'gate_versioned'],
    ['메신저 데스크톱 맥(WKWebView)', { ua: UA.macWebview }, 'ua_other'],
    ['메신저 데스크톱 윈도우(WebView2)', { ua: UA.win }, 'ua_other'],
    ['메신저 iOS', { ua: UA.ios }, 'ua_other'],
    ['메신저 Android', { ua: UA.android }, 'ua_other'],
    ['웹 브라우저', { ua: UA.chrome }, 'ua_other'],
    ['오피스 웹뷰', { ua: UA.macWebview }, 'ua_other'],
    ['다른 Node 라이브러리(node-fetch)', { ua: UA.nodeFetch }, 'ua_other'],
    ['user_agent 없음(null)', { ua: null }, 'ua_missing'],
    ['user_agent 빈 값', { ua: '' }, 'ua_missing'],
    ['원격 MCP(OAuth 클라이언트)', { oauth: randomUUID() }, 'oauth_client'],
    ['원격 MCP + 버전 있는 관문(사유는 하나)', { oauth: randomUUID(), gate: '0.1.114' }, 'oauth_client'],
    ['35분 안 새 로그인(관문 첫 호출 전)', { ageMin: 10 }, 'recent_login'],
    ['35분 안 새 로그인 + 버전 없는 관문', { ageMin: 10, gate: null }, 'recent_login'],
    ['메신저 + 버전 없는 관문 기록(같은 세션일 수 없지만 UA가 우선)', { ua: UA.ios, gate: null }, 'ua_other'],
  ];
  for (const [name, opt, want] of cases) {
    const s = session(opt);
    assert.equal(reasonOf(s.sid), want, name);
  }
});

test('미리보기: 쓰기 0, 수·계정 수·버전 분포·제외 사유·다른 UA·digest를 돌려준다', { skip }, () => {
  reset();
  const u = randomUUID();
  session({ uid: u }); session({ uid: u, gate: null }); session({ gate: null });
  session({ gate: '0.1.114' }); session({ gate: '0.1.113' }); session({ ua: UA.ios }); session({ ua: UA.ios }); session({ ua: null }); session({ ageMin: 5 });
  const tx = last(sql(`select public.argo_old_desktop_purge_preview(); select coalesce(txid_current_if_assigned()::text, 'none')`));
  assert.equal(tx, 'none', '미리보기는 쓰기 0');
  const p = preview();
  assert.equal(p.total_sessions, 9);
  assert.equal(p.target_sessions, 3);
  assert.equal(p.target_accounts, 2);
  assert.deepEqual(p.target_by_version, { no_gate: 1, gate_unversioned: 2 });
  assert.deepEqual(p.excluded_by_reason, { gate_versioned: 2, ua_other: 2, ua_missing: 1, recent_login: 1 });
  assert.deepEqual(p.excluded_versions, { '0.1.114': 1, '0.1.113': 1 });
  assert.deepEqual(p.other_user_agents, [{ ua: UA.ios.slice(0, 60), n: 2 }]);
  assert.equal(p.versioned_gate_6h, 2);
  assert.match(p.digest, /^[0-9a-f]{32}$/);
  assert.equal(alive(sql('select id from auth.sessions limit 1')), true);
  assert.equal(Number(sql('select count(*) from auth.sessions')), 9, '아무것도 지우지 않는다');
});

test('실행: 같은 수·digest면 대상만 지운다(refresh 토큰도), 같은 계정의 새 앱·메신저는 그대로, 폐기 기록이 남는다', { skip }, () => {
  reset();
  const uid = randomUUID();
  const oldA = session({ uid }), oldB = session({ uid, gate: null });
  const fresh = session({ uid, gate: '0.1.114' }), msgr = session({ uid, ua: UA.macWebview }), phone = session({ uid, ua: UA.ios });
  const other = session({ ua: UA.chrome });
  const p = preview();
  assert.equal(p.target_sessions, 2); assert.equal(p.target_accounts, 1);
  const r = run(p.target_sessions, p.digest);
  assert.equal(r.deleted_sessions, 2); assert.equal(r.accounts, 1);
  for (const s of [oldA, oldB]) { assert.equal(alive(s.sid), false); assert.equal(tokens(s.sid), 0, 'refresh → "Refresh Token Not Found"'); }
  for (const s of [fresh, msgr, phone, other]) { assert.ok(alive(s.sid)); assert.equal(tokens(s.sid), 1); }
  assert.equal(sql(`select string_agg(client_info, ',' order by client_info) from public.argo_old_app_sessions where cut_at is not null and user_id = ${lit(uid)}`),
    'bulk-purge gate_unversioned,bulk-purge no_gate');
  assert.equal(preview().target_sessions, 0, '다시 보면 대상 0');
});

test('실행: 수가 다르면 0건 삭제 + 오류(미리보기 뒤 옛 세션이 늘어도·줄어도)', { skip }, () => {
  reset(); newAppPresent();
  const a = session(), b = session();
  const p = preview();
  assert.match(runErr(p.target_sessions + 1, p.digest), /미리보기와 대상이 다르다/);
  assert.match(runErr(p.target_sessions - 1, p.digest), /미리보기와 대상이 다르다/);
  const c = session(); // 미리보기 뒤에 생긴 옛 세션
  assert.match(runErr(p.target_sessions, p.digest), /미리보기와 대상이 다르다/);
  for (const s of [a, b, c]) assert.ok(alive(s.sid), '0건 삭제');
  assert.equal(Number(sql('select count(*) from public.argo_old_app_sessions')), 0, '폐기 기록도 0');
});

test('실행: 수가 같아도 집합이 다르면(하나 빠지고 하나 생김) 0건 삭제', { skip }, () => {
  reset(); newAppPresent();
  const a = session(), b = session();
  const p = preview();
  sql(`delete from auth.sessions where id = ${lit(a.sid)}`); // 사용자가 스스로 로그아웃
  const c = session();
  assert.match(runErr(p.target_sessions, p.digest), /미리보기와 대상이 다르다/);
  assert.ok(alive(b.sid)); assert.ok(alive(c.sid));
});

test('미리보기 뒤 옛 세션이 0.1.114로 업데이트해 꼬리 있는 관문을 부르면 — 수가 달라 0건 삭제(새 앱을 지우지 않는다)', { skip }, () => {
  reset(); newAppPresent();
  const upd = session({ gate: null }), old = session();
  const p = preview();
  assert.equal(p.target_sessions, 2);
  // 0.1.114의 관문 호출(#1107 argo_min_app_version, 꼬리 argo/0.1.114) — 요청 하나를 흉내 낸다
  const claims = JSON.stringify({ role: 'authenticated', sub: upd.uid, session_id: upd.sid });
  const hdr = JSON.stringify({ 'x-client-info': 'supabase-js/2.110.2; runtime=node; runtime-version=22.23.2 argo/0.1.114' });
  sql(`set local role authenticated; select set_config('request.jwt.claims', ${lit(claims)}, true), set_config('request.headers', ${lit(hdr)}, true); select public.argo_min_app_version('desktop')`);
  assert.equal(reasonOf(upd.sid), 'gate_versioned');
  assert.match(runErr(p.target_sessions, p.digest), /미리보기와 대상이 다르다/);
  assert.ok(alive(upd.sid)); assert.ok(alive(old.sid));
  const q = preview();
  assert.equal(q.target_sessions, 1);
  assert.equal(run(q.target_sessions, q.digest).deleted_sessions, 1);
  assert.ok(alive(upd.sid), '업데이트한 새 앱 그대로'); assert.equal(alive(old.sid), false);
});

test('실행 중에는 관문 기록 표를 잠근다 — 계산과 삭제 사이에 관문 쓰기가 끼지 못한다', { skip }, () => {
  reset(); newAppPresent(); session();
  const p = preview();
  // 실행과 같은 트랜잭션 안에서 잠금 모드를 읽는다
  const mode = last(sql(`select public.argo_old_desktop_purge_run(${p.target_sessions}, ${lit(p.digest)});
    select count(*) from pg_locks where relation = 'public.argo_gate_sessions'::regclass and pid = pg_backend_pid() and granted and mode = 'ShareLock'`));
  assert.equal(mode, '1');
});

test('전제: 최근 6시간 버전 있는 관문 기록이 0이면 실행하지 않는다(0.1.114 기록이 확인되지 않음)', { skip }, () => {
  reset();
  const a = session();
  session({ gate: '0.1.114' });
  sql(`update public.argo_gate_sessions set seen_at = now() - interval '7 hours'`);
  const p = preview();
  assert.equal(p.versioned_gate_6h, 0);
  assert.match(runErr(p.target_sessions, p.digest), /버전 있는 관문 기록 0/);
  assert.ok(alive(a.sid));
});

test('전제: #1107이 되돌려져 관문 함수가 기록하지 않으면 미리보기·실행 모두 멈춘다', { skip }, () => {
  reset(); newAppPresent(); session();
  const body = readFileSync(readdirSync(MIG_DIR).filter((n) => n.endsWith('_msgr_app_min_version.sql')).map((n) => MIG_DIR + n)[0], 'utf8');
  for (const call of ['select public.argo_old_desktop_purge_preview()', `select public.argo_old_desktop_purge_run(1, '${'0'.repeat(32)}')`]) {
    const r = psqlSpawn(DB, ['-c', `${body}; ${call}`]); // 한 트랜잭션 — 실패로 옛 본문도 되돌려진다
    assert.notEqual(r.status, 0); assert.match(r.stderr, /관문 함수가 세션을 기록하지 않는다/);
  }
  assert.ok(preview().target_sessions >= 1, '되돌려진 뒤 다시 동작');
});

test('API 역할(anon·authenticated·service_role)은 미리보기·목록·실행을 부르지 못한다', { skip }, () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const call of ['public.argo_old_desktop_purge_preview()', 'public.argo_old_desktop_purge_list()', `public.argo_old_desktop_purge_run(0, '${'0'.repeat(32)}')`, 'public._argo_old_desktop_classify()']) {
      const r = psqlSpawn(DB, ['-c', `set local role ${role}; select ${call}`]);
      assert.notEqual(r.status, 0, `${role} ${call}`); assert.match(r.stderr, new RegExp(`permission denied for function ${call.match(/public\.(\w+)\(/)[1]}\\b`)); // 부른 함수 자체에서 막힌다(안쪽 함수·표 권한이 아니라)
    }
  }
});

test('되돌림 파일: 함수만 지우고 세션·기록 표는 그대로, 다시 적용할 수 있다', { skip }, () => {
  reset(); const s = session();
  psql(['-f', join(ROOT, 'scripts/rollback/20261019150000_argo_old_desktop_session_purge.down.sql')]);
  assert.equal(sql(`select count(*) from pg_proc where proname like '%argo_old_desktop%'`), '0');
  assert.ok(alive(s.sid)); assert.equal(sql(`select to_regclass('public.argo_gate_sessions') is not null`), 't');
  psql(['-c', migByTail('_argo_old_desktop_session_purge.sql')]);
  assert.equal(preview().target_sessions, 1);
});

// 스크립트 — 로컬 접속 문자열(ARGO_PURGE_PG)로 끝까지. 만든 임시 폴더는 정확한 경로만 지운다
const temps = [];
const tempOut = () => { const d = mkdtempSync(join(tmpdir(), 'odp-')); temps.push(d); return join(d, 'ops'); };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
function script(args, env = {}) {
  return spawnSync('bash', [join(ROOT, 'scripts/old-desktop-session-purge.sh'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ARGO_PURGE_PG: DB, ...env } });
}

test('스크립트: preview → run이 대상 id를 0600 파일(0700 폴더)로 남긴 뒤 지운다', { skip }, () => {
  reset(); newAppPresent();
  const a = session(), b = session({ gate: null }), keep = session({ ua: UA.ios });
  const out = tempOut();
  const pv = script(['preview'], { ARGO_PURGE_OUT: out });
  assert.equal(pv.status, 0, pv.stderr);
  const p = JSON.parse(pv.stdout.slice(pv.stdout.indexOf('{'), pv.stdout.lastIndexOf('}') + 1));
  assert.equal(p.target_sessions, 2);
  const r = script(['run', String(p.target_sessions), p.digest], { ARGO_PURGE_OUT: out });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /"deleted_sessions": 2/);
  const files = ls(out);
  assert.equal(files.length, 1);
  const f = join(out, files[0]);
  assert.equal(statSync(f).mode & 0o777, 0o600, '파일 0600');
  assert.equal(statSync(out).mode & 0o777, 0o700, '폴더 0700');
  const ids = readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split('\t')[0]).sort();
  assert.deepEqual(ids, [a.sid, b.sid].sort());
  assert.equal(alive(a.sid), false); assert.equal(alive(b.sid), false); assert.ok(alive(keep.sid));
});

test('스크립트: 수나 digest가 미리보기와 다르면 목록만 남기고 0건 삭제(종료 3)', { skip }, () => {
  reset(); newAppPresent();
  const a = session();
  const p = preview();
  const out = tempOut();
  const bad = script(['run', String(p.target_sessions + 1), p.digest], { ARGO_PURGE_OUT: out });
  assert.equal(bad.status, 3, bad.stdout + bad.stderr); assert.match(bad.stdout, /0건 삭제/);
  const bad2 = script(['run', String(p.target_sessions), 'f'.repeat(32)], { ARGO_PURGE_OUT: out });
  assert.equal(bad2.status, 3);
  assert.ok(alive(a.sid));
  assert.equal(script(['run', 'x', 'y']).status, 2, '형식이 틀리면 접속 전에 거부');
});

test('스크립트: 운영 접속은 맥 two에서 거부(종료 5), ARGO_PURGE_PG는 로컬만 받는다', () => {
  const env = { ...process.env, HOME: '/Users/leankim' }; delete env.ARGO_PURGE_PG;
  const r = spawnSync('bash', [join(ROOT, 'scripts/old-desktop-session-purge.sh'), 'preview'], { cwd: ROOT, encoding: 'utf8', env });
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).stdout;
  if (/github\.com/.test(remote)) { assert.equal(r.status, 5, r.stdout + r.stderr); assert.match(r.stdout, /맥 one에서만/); }
  const far = spawnSync('bash', [join(ROOT, 'scripts/old-desktop-session-purge.sh'), 'preview'], { cwd: ROOT, encoding: 'utf8', env: { ...env, ARGO_PURGE_PG: 'postgresql://postgres@db.example.com:5432/postgres' } });
  assert.equal(far.status, 2); assert.match(far.stdout, /로컬 시험용/);
});
