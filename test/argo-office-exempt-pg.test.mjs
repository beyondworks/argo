// 오피스 안전장치(…_argo_office_exempt.sql)를 실제 Postgres에서 본다 — #1107 요청 전 함수와 #1113 일괄 폐기 판정에서 오피스 에이전트를 뺀다.
// #1107(…_argo_old_app_cutoff.sql)·#1113(…_argo_old_desktop_session_purge.sql) 위에 이 파일을 얹고, 기존 판정이 그대로인지도 같이 본다.
// 실행: bash scripts/billing-pg-drill.sh test/argo-office-exempt-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/argo-office-exempt-pg.test.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIG_DIR = ROOT + 'supabase/migrations/';
const migByTail = (tail) => { const f = readdirSync(MIG_DIR).filter((n) => n.endsWith(tail)); assert.equal(f.length, 1, `${tail} 하나 (${f})`); return readFileSync(MIG_DIR + f[0], 'utf8'); };
function psql(args) { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const lit = (s) => (s === null ? 'null' : `'${String(s).replace(/'/g, "''")}'`);

// 실측·관례 값
const OLD = 'supabase-js/2.110.2; runtime=node; runtime-version=22.23.2'; // 0.1.106 실측 헤더(옛 본체)
const OFFICE_XCI = 'supabase-js/2.117.2; runtime=node; runtime-version=22.21.1, argo-office/1'; // 오피스 에이전트(2026-10-20)
const OFFICE_XCI_PINNED = `${OLD}, argo-office/1`; // 오피스가 supabase-js를 옛 본체와 같은 판으로 고정한 경우 — 수정 전에는 옛 앱으로 잡힌다
const OFFICE_UA = 'argo-office-agent/1';
const WEBVIEW_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

// 요청 하나 = 트랜잭션 하나(요청 역할 + request.* 설정 + 요청 전 함수). 결과 = 쓰기가 있었는지
function request({ sid, uid, xci = OLD, ua = 'node', method = 'POST', path = '/rpc/msgr_notification_claim' }) {
  const claims = JSON.stringify({ role: 'authenticated', sub: uid, session_id: sid });
  const hdr = JSON.stringify({ 'user-agent': ua, ...(xci === null ? {} : { 'x-client-info': xci }) });
  return last(sql(`set local role authenticated;
    select set_config('request.method', ${lit(method)}, true), set_config('request.path', ${lit(path)}, true), set_config('request.jwt.claims', ${lit(claims)}, true), set_config('request.headers', ${lit(hdr)}, true);
    select public.argo_old_app_check(); select coalesce(txid_current_if_assigned()::text, 'none')`));
}
// 세션 하나. gate: undefined(관문 기록 없음) | null(버전 없는 관문) | '0.1.114'(꼬리 있는 관문)
function session({ uid = randomUUID(), ua = 'node', ageMin = 600, gate } = {}) {
  const sid = randomUUID();
  sql(`insert into auth.sessions (id, user_id, created_at, refreshed_at, user_agent, ip, oauth_client_id)
         values (${lit(sid)}, ${lit(uid)}, now() - interval '${ageMin} minutes', now() - interval '5 minutes', ${lit(ua)}, '203.0.113.7', null);
       insert into auth.refresh_tokens (session_id, token) values (${lit(sid)}, 'rt-' || ${lit(sid)});
       ${gate === undefined ? '' : `insert into public.argo_gate_sessions (session_id, user_id, app_version) values (${lit(sid)}, ${lit(uid)}, ${lit(gate)});`}`);
  return { sid, uid };
}
const alive = (sid) => sql(`select count(*) from auth.sessions where id = ${lit(sid)}`) === '1';
const marked = (sid) => sql(`select count(*) from public.argo_old_app_sessions where session_id = ${lit(sid)}`) === '1';
const makeDue = (sid) => sql(`update public.argo_old_app_sessions set due_at = now() - interval '1 second' where session_id = ${lit(sid)}`);
const on = () => sql(`insert into public.msgr_settings (key, value) values ('old_app_cutoff', 'on') on conflict (key) do update set value = excluded.value`);
const off = () => sql(`delete from public.msgr_settings where key = 'old_app_cutoff'`);
const reset = () => sql('delete from auth.sessions; delete from public.argo_gate_sessions; delete from public.argo_old_app_sessions');
const reasonOf = (sid) => sql(`select coalesce(reason, 'TARGET') from public._argo_old_desktop_classify() where session_id = ${lit(sid)}`);
// 요청 세 번(표시 → 35분 지남 → 다음 요청) 뒤 살아 있는지
function survives(opt) { const s = session(); request({ ...s, ...opt }); makeDue(s.sid); request({ ...s, ...opt }); return { alive: alive(s.sid), marked: marked(s.sid) }; }

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
});

test('요청 전 함수 — 오피스(X-Client-Info에 argo-office/)는 스위치를 켜도 표시·폐기 0, 쓰기 0', { skip }, () => {
  reset(); on();
  for (const [name, xci] of [['오피스 실측값(2.117.2)', OFFICE_XCI], ['오피스가 옛 본체와 같은 supabase-js 판(2.110.2)', OFFICE_XCI_PINNED]]) {
    const s = session();
    assert.equal(request({ ...s, xci, ua: OFFICE_UA }), 'none', `${name} 첫 요청 쓰기 0`);
    makeDue(s.sid);
    assert.equal(request({ ...s, xci, ua: OFFICE_UA }), 'none', `${name} 둘째 요청 쓰기 0`);
    assert.ok(alive(s.sid), `${name} 세션 살아 있음`); assert.ok(!marked(s.sid), `${name} 표시 없음`);
  }
  off();
});

test('요청 전 함수 — 기존 판정 그대로: 옛 본체(2.110.2)는 표시 → 35분 뒤 폐기, 꼬리(argo/)·웹·GET은 제외', { skip }, () => {
  reset(); on();
  const s = session();
  assert.notEqual(request(s), 'none', '옛 본체 첫 POST는 표시(쓰기 있음)');
  assert.ok(marked(s.sid) && alive(s.sid), '표시만, 아직 살아 있음');
  makeDue(s.sid); request(s);
  assert.ok(!alive(s.sid), '35분 뒤 POST에서 폐기');
  assert.deepEqual(survives({ xci: `${OLD} argo/0.1.114` }), { alive: true, marked: false }, '꼬리 있는 새 앱');
  assert.deepEqual(survives({ xci: 'supabase-js/2.114.0; runtime=web' }), { alive: true, marked: false }, '메신저·웹');
  assert.deepEqual(survives({ method: 'GET' }), { alive: true, marked: false }, 'GET');
  // 'argo-office'라는 글자만 있고 '/'가 없으면(오피스 형식 아님) 종전대로 옛 앱으로 본다
  assert.deepEqual(survives({ xci: `${OLD}, argo-office` }), { alive: false, marked: true }, "'argo-office/' 형식만 통과");
  off();
});

test('스위치가 꺼져 있으면 오피스·옛 본체 모두 쓰기 0(종전과 같다)', { skip }, () => {
  reset(); off();
  const a = session(); const b = session();
  assert.equal(request({ ...a, xci: OFFICE_XCI_PINNED }), 'none');
  assert.equal(request(b), 'none');
  assert.ok(alive(a.sid) && alive(b.sid));
});

test('일괄 폐기 판정 — user_agent가 argo-office로 시작하면 제외 사유 office, 나머지 판정은 그대로', { skip }, () => {
  reset();
  const cases = [
    ['오피스 에이전트(관문 기록 없음)', { ua: OFFICE_UA }, 'office'],
    ['오피스 에이전트(버전 없는 관문 기록이 있어도)', { ua: OFFICE_UA, gate: null }, 'office'],
    ['오피스 다른 판(argo-office-agent/2)', { ua: 'argo-office-agent/2' }, 'office'],
    ['옛 앱 0.1.106 이하(node, 관문 없음)', {}, 'TARGET'],
    ['옛 앱 0.1.107~0.1.113(node, 버전 없는 관문)', { gate: null }, 'TARGET'],
    ['새 앱 0.1.114(꼬리 있는 관문)', { gate: '0.1.114' }, 'gate_versioned'],
    ['메신저 데스크톱 웹뷰', { ua: WEBVIEW_UA }, 'ua_other'],
    ['user_agent 비어 있음', { ua: '' }, 'ua_missing'],
    ['35분 안 새 로그인(node)', { ageMin: 10 }, 'recent_login'],
    ["대소문자 다른 'Argo-Office'(오피스 형식 아님)", { ua: 'Argo-Office-agent/1' }, 'ua_other'],
  ];
  for (const [name, opt, want] of cases) assert.equal(reasonOf(session(opt).sid), want, name);
  const p = JSON.parse(sql('select public.argo_old_desktop_purge_preview()'));
  assert.equal(p.excluded_by_reason.office, 3, '미리보기에 office 3');
  assert.equal(p.target_sessions, 2, '대상은 옛 앱 둘');
  assert.ok(!p.other_user_agents.some((x) => x.ua.startsWith('argo-office')), "other_user_agents에 오피스가 섞이지 않는다");
});

test('일괄 폐기 실행 — 오피스 세션은 지워지지 않고 옛 앱만 지워진다', { skip }, () => {
  reset();
  session({ ua: WEBVIEW_UA, gate: '0.1.114' }); // 실행 전제(최근 버전 있는 관문 기록 ≥ 1)
  const office = session({ ua: OFFICE_UA, gate: null });
  const old = session();
  const p = JSON.parse(sql('select public.argo_old_desktop_purge_preview()'));
  const r = JSON.parse(sql(`select public.argo_old_desktop_purge_run(${p.target_sessions}, ${lit(p.digest)})`));
  assert.equal(r.deleted_sessions, 1);
  assert.ok(alive(office.sid), '오피스 살아 있음'); assert.ok(!alive(old.sid), '옛 앱 폐기');
});

test('다시 적용해도 같다(멱등) — 등록(pgrst.db_pre_request)은 그대로 이 함수', { skip }, () => {
  psql(['-c', migByTail('_argo_office_exempt.sql')]);
  assert.match(sql(`select array_to_string(rolconfig, ',') from pg_roles where rolname = 'authenticator'`), /pgrst\.db_pre_request=public\.argo_old_app_check/);
  reset();
  assert.equal(reasonOf(session({ ua: OFFICE_UA }).sid), 'office');
});

test('되돌림 파일 — 두 함수가 이전 본문으로 돌아가고(오피스 → ua_other, 고정 판 오피스는 옛 앱으로), 등록은 그대로', { skip }, () => {
  const down = readFileSync(ROOT + 'scripts/rollback/20261020201800_argo_office_exempt.down.sql', 'utf8');
  psql(['-c', down]);
  assert.match(sql(`select array_to_string(rolconfig, ',') from pg_roles where rolname = 'authenticator'`), /pgrst\.db_pre_request=public\.argo_old_app_check/);
  const def = (name) => sql(`select prosrc from pg_proc where proname = ${lit(name)}`);
  const body = (tail, name) => { const s = migByTail(tail); const i = s.indexOf(`create or replace function public.${name}(`); const a = s.indexOf('$$', i) + 2; return s.slice(a, s.indexOf('$$', a)).trim(); };
  assert.equal(def('argo_old_app_check'), body('_argo_old_app_cutoff.sql', 'argo_old_app_check'), '요청 전 함수 = #1107 본문 그대로');
  assert.equal(def('_argo_old_desktop_classify'), body('_argo_old_desktop_session_purge.sql', '_argo_old_desktop_classify'), '판정 = #1113 본문 그대로');
  reset(); on();
  assert.equal(reasonOf(session({ ua: OFFICE_UA }).sid), 'ua_other');
  assert.deepEqual(survives({ xci: OFFICE_XCI_PINNED }), { alive: false, marked: true }, '되돌리면 고정 판 오피스는 다시 옛 앱으로 잡힌다(수정 전 동작)');
  assert.deepEqual(survives({ xci: OFFICE_XCI }), { alive: true, marked: false }, '오피스 실측값은 되돌려도 대상 아님(2.117.2)');
  off();
  psql(['-c', migByTail('_argo_office_exempt.sql')]); // 다른 시험 순서와 무관하게 끝 상태를 맞춘다
});
