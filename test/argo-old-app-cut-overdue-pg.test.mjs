// 기한 지난 옛 앱 표시를 5분 cron이 끊는다(…_argo_old_app_cut_overdue.sql)를 실제 Postgres에서 본다.
// 2026-11-15 운영 실측: 표시(04:11Z)·기한(04:46Z) 뒤로 POST 없이 GET·Storage·토큰 갱신만 하던 옛 판 세션이 4시간 넘게 끊기지 않았다.
// auth.sessions·refresh_tokens는 Supabase와 같은 모양의 대역(updated_at timestamptz, refreshed_at timestamp, FK on delete cascade)이다.
// 실행: bash scripts/billing-pg-drill.sh test/argo-old-app-cut-overdue-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/argo-old-app-cut-overdue-pg.test.mjs';
const MIG_DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const ROLLBACK = fileURLToPath(new URL('../scripts/rollback/20261115190000_argo_old_app_cut_overdue.down.sql', import.meta.url));
const migByTail = (tail) => { const f = readdirSync(MIG_DIR).filter((n) => n.endsWith(tail)); assert.equal(f.length, 1, `${tail} 하나 (${f})`); return readFileSync(MIG_DIR + f[0], 'utf8'); };
function psql(args) { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const OLD = 'supabase-js/2.110.2; runtime=node; runtime-version=22.23.2'; // 0.1.106 실측 헤더
const NEW = `${OLD} argo/0.1.125`;

// PostgREST 요청 하나 = 트랜잭션 하나(요청 전 함수 → 본 쿼리). 결과 = 마지막 문장
function request({ sid, uid, xci = OLD, method = 'POST', path = '/rpc/msgr_notification_claim', body = 'select public.argo_old_app_check()' }) {
  const claims = JSON.stringify({ role: 'authenticated', sub: uid, session_id: sid });
  const hdr = JSON.stringify({ 'user-agent': 'node', 'x-client-info': xci });
  return last(sql(`set local role authenticated;
    select set_config('request.method', ${lit(method)}, true), set_config('request.path', ${lit(path)}, true), set_config('request.jwt.claims', ${lit(claims)}, true), set_config('request.headers', ${lit(hdr)}, true);
    ${body}`));
}
const gate = (s, xci) => request({ ...s, xci, path: '/rpc/argo_min_app_version', body: `select public.argo_old_app_check(); select public.argo_min_app_version('desktop')` });
function session({ ageMin = 180, uid = randomUUID() } = {}) {
  const sid = randomUUID();
  sql(`insert into auth.sessions (id, user_id, created_at, updated_at) values (${lit(sid)}, ${lit(uid)}, now() - interval '${ageMin} minutes', now() - interval '${ageMin} minutes');
       insert into auth.refresh_tokens (session_id, token) values (${lit(sid)}, 'rt-' || ${lit(sid)})`);
  return { sid, uid };
}
const alive = (sid) => sql(`select count(*) from auth.sessions where id = ${lit(sid)}`) === '1';
const tokens = (sid) => Number(sql(`select count(*) from auth.refresh_tokens where session_id = ${lit(sid)}`));
const cutAt = (sid) => sql(`select coalesce(cut_at::text, '-') from public.argo_old_app_sessions where session_id = ${lit(sid)}`);
const marked = (sid) => sql(`select count(*) from public.argo_old_app_sessions where session_id = ${lit(sid)}`) === '1';
const makeDue = (sid) => sql(`update public.argo_old_app_sessions set due_at = now() - interval '15 minutes' where session_id = ${lit(sid)}`);
// GoTrue 토큰 갱신 흉내 — refresh grant는 sessions.refreshed_at(timestamp, UTC)·updated_at을 바꾼다(PostgREST 요청이 아니라 요청 전 함수가 돌지 않는다)
// agoMin: 갱신이 몇 분 전이었나(기본 10분 — 6분 유예를 넘긴 상태. 기한은 makeDue가 15분 전으로 둔다)
const refreshVia = (sid, col, agoMin = 10) => sql(col === 'refreshed_at'
  ? `update auth.sessions set refreshed_at = ((now() - interval '${agoMin} minutes') at time zone 'UTC') where id = ${lit(sid)}`
  : `update auth.sessions set updated_at = now() - interval '${agoMin} minutes' where id = ${lit(sid)}`);
// 시간대를 KST로 고정해 refreshed_at(UTC 벽시계, timestamp)을 시간대 없이 읽는 실수를 어느 맥·CI에서나 잡는다(운영 DB는 UTC)
const sweep = () => Number(sql(`set timezone = 'Asia/Seoul'; set role service_role; select public.argo_old_app_cut_overdue()`).split('\n').pop());
const on = () => sql(`insert into public.msgr_settings (key, value) values ('old_app_cutoff', 'on') on conflict (key) do update set value = excluded.value;
  insert into public.msgr_settings (key, value) values ('old_app_cutoff_max', '0.1.113') on conflict (key) do update set value = excluded.value`);
const off = () => sql(`delete from public.msgr_settings where key = 'old_app_cutoff'`);
// 옛 세션 하나를 "표시 → 기한 지남 → 그 뒤 갱신"까지(POST는 표시 때 한 번뿐 — 운영 실측 모양)
function overdueOld(opts) { const s = session(opts); request(s); assert.ok(marked(s.sid), '표시됨'); makeDue(s.sid); refreshVia(s.sid, 'refreshed_at'); return s; }

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
    alter table auth.sessions add column if not exists updated_at timestamptz;
    alter table auth.sessions add column if not exists refreshed_at timestamp without time zone;
    create table if not exists auth.refresh_tokens (id bigserial primary key, session_id uuid references auth.sessions(id) on delete cascade, token text);
    create table if not exists public.msgr_settings (key text primary key, value text not null); alter table public.msgr_settings enable row level security;
  `]);
  psql(['-c', migByTail('_msgr_app_min_version.sql')]);
  // 운영과 같은 끝 상태 위에 이 마이그레이션
  psql(['-c', migByTail('_argo_old_app_cutoff.sql')]);
  for (const tail of ['_argo_office_exempt.sql', '_argo_old_msgr_cutoff.sql', '_argo_old_app_cutoff_reused_session.sql', '_argo_old_app_cut_overdue.sql']) psql(['-c', migByTail(tail)]);
});

test('운영 실측 모양: 표시 뒤 POST 없이 갱신만 하는 옛 세션 — 종전 장치는 못 끊고, cron 한 번이 끊는다', { skip }, () => {
  on();
  const s = overdueOld();
  // 종전 경로: GET 요청(조회)은 요청 전 함수가 바로 돌아가 끊지 못한다
  request({ ...s, method: 'GET', path: '/msgr_messages' });
  assert.ok(alive(s.sid), 'GET으로는 안 끊긴다(종전 결함)');
  assert.equal(sweep(), 1);
  assert.ok(!alive(s.sid), '세션 삭제');
  assert.equal(tokens(s.sid), 0, 'refresh 토큰도 함께(FK)');
  assert.notEqual(cutAt(s.sid), '-', 'cut_at 기록');
  assert.equal(sweep(), 0, '두 번째 실행은 할 일 없음');
});

test('updated_at으로만 갱신이 보여도 끊는다(refreshed_at 비어 있음)', { skip }, () => {
  on();
  const s = session(); request(s); makeDue(s.sid); refreshVia(s.sid, 'updated_at');
  assert.equal(sweep(), 1);
  assert.ok(!alive(s.sid));
});

test('기한 전 표시는 끊지 않는다', { skip }, () => {
  on();
  const s = session(); request(s); refreshVia(s.sid, 'refreshed_at');
  assert.equal(sweep(), 0);
  assert.ok(alive(s.sid));
  assert.equal(cutAt(s.sid), '-');
});

test('기한 뒤로 아무도 쓰지 않은 세션은 끊지 않는다(옛 판이 꺼졌거나 같은 세션의 새 판이 잠듦)', { skip }, () => {
  on();
  const s = session(); request(s); makeDue(s.sid); // 갱신 없음 — updated_at은 세션 생성 시각(기한 전)
  assert.equal(sweep(), 0);
  assert.ok(alive(s.sid));
});

test('새 판: 꼬리 있는 관문이 기한 안에 표시를 지우면 cron은 건드릴 것이 없다', { skip }, () => {
  on();
  const s = session(); request(s); // 같은 세션을 쓰는 옛 판 POST로 표시
  gate(s, NEW); // 새 판 관문(30분 주기) — 표시를 지운다
  assert.ok(!marked(s.sid), '관문이 표시 삭제');
  refreshVia(s.sid, 'refreshed_at');
  assert.equal(sweep(), 0);
  assert.ok(alive(s.sid));
});

test('꼬리 있는 요청만 하는 새 판 세션은 표시되지 않아 끊기지 않는다', { skip }, () => {
  on();
  const s = session();
  request({ ...s, xci: NEW });
  assert.ok(!marked(s.sid));
  refreshVia(s.sid, 'refreshed_at');
  assert.equal(sweep(), 0);
  assert.ok(alive(s.sid));
});

test('스위치가 꺼져 있으면 기한 지난 표시도 끊지 않는다(쓰기 0)', { skip }, () => {
  on();
  const s = overdueOld();
  off();
  const tx = last(sql(`set local role service_role; select public.argo_old_app_cut_overdue(); select coalesce(txid_current_if_assigned()::text, 'none')`));
  assert.equal(tx, 'none', '쓰기 없음');
  assert.ok(alive(s.sid));
  on();
  assert.equal(sweep(), 1, '다시 켜면 다음 실행에서 끊는다');
});

test('이미 끊긴 표시(cut_at 있음)·세션이 없는 표시는 건너뛴다', { skip }, () => {
  on();
  const a = overdueOld();
  sql(`update public.argo_old_app_sessions set cut_at = now() where session_id = ${lit(a.sid)}`);
  const b = overdueOld();
  sql(`delete from auth.sessions where id = ${lit(b.sid)}`); // 사용자가 스스로 로그아웃
  assert.equal(sweep(), 0);
  assert.ok(alive(a.sid), 'cut_at만 있고 세션이 남은 경우도 다시 지우지 않는다(종전 기록 존중)');
});

test('유휴: 할 일이 없으면 쓰기 0(트랜잭션 번호 미할당)', { skip }, () => {
  on();
  sweep(); // 남은 것 정리
  const tx = last(sql(`set local role service_role; select public.argo_old_app_cut_overdue(); select coalesce(txid_current_if_assigned()::text, 'none')`));
  assert.equal(tx, 'none');
});

test('같은 사용자의 다른 세션(새 판)은 그대로 둔다', { skip }, () => {
  on();
  const uid = randomUUID();
  const old = overdueOld({ uid });
  const fresh = session({ uid });
  request({ ...fresh, xci: NEW }); refreshVia(fresh.sid, 'refreshed_at');
  assert.equal(sweep(), 1);
  assert.ok(!alive(old.sid));
  assert.ok(alive(fresh.sid));
});

test('6분 유예: 기한 뒤 방금 갱신한 세션은 기다렸다가, 6분이 지나면 끊는다(새 판 관문 재시도 한 번을 기다린다)', { skip }, () => {
  on();
  const s = session(); request(s); makeDue(s.sid);
  refreshVia(s.sid, 'refreshed_at', 1); // 깨어나 방금 갱신 — 관문은 아직(실패해 5분 뒤 재시도 중)
  assert.equal(sweep(), 0, '유예 안에서는 끊지 않는다');
  assert.ok(alive(s.sid));
  gate(s, NEW); // 재시도한 꼬리 있는 관문이 표시를 지운다
  refreshVia(s.sid, 'refreshed_at', 10);
  assert.equal(sweep(), 0, '표시가 지워져 끊을 것이 없다');
  assert.ok(alive(s.sid), '새 판은 살아남는다');
  // 관문이 끝내 오지 않은 옛 판이면 유예 뒤에 끊긴다
  const o = session(); request(o); makeDue(o.sid); refreshVia(o.sid, 'refreshed_at', 1);
  assert.equal(sweep(), 0);
  refreshVia(o.sid, 'refreshed_at', 7);
  assert.equal(sweep(), 1);
  assert.ok(!alive(o.sid));
});

test('한 번 실행에 여러 건을 끊는다', { skip }, () => {
  on();
  sweep();
  const list = [overdueOld(), overdueOld(), overdueOld()];
  assert.equal(sweep(), 3);
  for (const s of list) assert.ok(!alive(s.sid));
});

test('권한: 클라이언트(anon·authenticated)는 이 함수를 부를 수 없다', { skip }, () => {
  for (const role of ['anon', 'authenticated']) {
    const r = psqlSpawn(DB, ['-A', '-t', '-c', `set role ${role}; select public.argo_old_app_cut_overdue()`]);
    assert.notEqual(r.status, 0, `${role} 거절`);
    assert.match(r.stderr, /permission denied/);
  }
});

test('되돌리기 파일: 함수·색인을 지우고, 다시 적용할 수 있다', { skip }, () => {
  psql(['-v', 'ON_ERROR_STOP=1', '-f', ROLLBACK]);
  assert.equal(sql(`select count(*) from pg_proc where proname = 'argo_old_app_cut_overdue'`), '0');
  assert.equal(sql(`select count(*) from pg_indexes where indexname = 'argo_old_app_sessions_open_due'`), '0');
  psql(['-c', migByTail('_argo_old_app_cut_overdue.sql')]);
  assert.equal(sql(`select count(*) from pg_proc where proname = 'argo_old_app_cut_overdue'`), '1');
});
