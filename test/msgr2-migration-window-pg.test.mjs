// 메신저 v2 U8 — 이전 작업 창 표지(msgr_settings 'msgr2_migration_window') 동안 옛 계정 삭제·보관 조직 영구 삭제를 막는다(20261018052000).
// 표지 없음 = 배포본과 같음(원래 함수 본문이 20261012160000 정의와 같고 결과가 같다), 표지 있음 = 거부(데이터 불변), 표지 끈 뒤 다시 정상, 되돌림.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-migration-window-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setupFull } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-migration-window-pg.test.mjs';
const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const DOWN = read('scripts/rollback/20261018052000_msgr2_migration_window.down.sql');
const ORIG = read('supabase/migrations/20261012160000_msgr_account_delete_storage_sweep.sql');
// 20261012160000의 함수 본문($$ … $$ 사이) — 이름을 바꾼 원래 함수의 prosrc와 같아야 한다
const bodyOf = (src, name) => { const i = src.indexOf(`create or replace function public.${name}(`); const a = src.indexOf('$$', i) + 2; return src.slice(a, src.indexOf('$$;', a)); };
const id = (n) => `d8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), C = id(3), OA = id(100), OB = id(101), OC = id(102);

let db;
const one = (q) => db.sql(q);
const asUser = (uid, q) => db.raw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const lastLine = (r) => r.stdout.trim().split('\n').pop();
const snapshot = () => ['auth.users', 'public.msgr_orgs', 'public.msgr_org_members', 'public.msgr_channels', 'public.msgr_channel_members']
  .map((t) => one(`select '${t}:' || count(*) || ':' || coalesce(md5(string_agg(md5(x::text), ',' order by md5(x::text))), '-') from ${t} x`)).join(' ');
const setFlag = (on) => db.sql(on ? "insert into public.msgr_settings (key, value) values ('msgr2_migration_window', now()::text) on conflict (key) do nothing"
                                  : "delete from public.msgr_settings where key = 'msgr2_migration_window'");

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  // 사람 셋이 각자 혼자인 조직을 하나씩 가진다(계정 삭제 = 그 조직도 지운다). C의 조직은 31일 전에 보관 — 영구 삭제 대상.
  for (const u of [A, B, C]) db.sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test') on conflict do nothing`);
  for (const [u, o, slug] of [[A, OA, 'win-a'], [B, OB, 'win-b'], [C, OC, 'win-c']]) {
    const r = asUser(u, `insert into public.msgr_orgs (id, name, slug, owner_user_id) values ('${o}', '${slug}', '${slug}', '${u}') returning id`);
    assert.equal(r.status, 0, r.stderr);
  }
  db.sql(`update public.msgr_orgs set deleted_at = now() - interval '31 days' where id = '${OC}'`);
});

test('1) 원래 함수는 이름만 바뀌었다: 본문이 20261012160000 정의와 같고, 사람은 원래 함수를 직접 못 부른다', { skip }, () => {
  for (const [body, name] of [['_msgr_delete_me_body', 'msgr_delete_me'], ['_msgr_purge_orgs_body', 'msgr_purge_orgs']]) {
    assert.equal(one(`select md5(prosrc) from pg_proc where proname = '${body}'`), one(`select md5($b$${bodyOf(ORIG, name)}$b$)`), body);
    assert.equal(one(`select prosecdef from pg_proc where proname = '${body}'`), 't');
  }
  assert.match(asUser(A, 'select public._msgr_delete_me_body()').stderr, /permission denied/);
  assert.match(asUser(A, 'select public._msgr_purge_orgs_body()').stderr, /permission denied/);
  assert.match(asUser(A, 'select public.msgr_purge_orgs()').stderr, /permission denied/, '영구 삭제는 지금처럼 서비스만');
  assert.match(asUser(A, 'select public._msgr2_migration_window()').stderr, /permission denied/);
});

test('2) 표지 없음 = 배포본과 같다: 계정 삭제가 되고(조직도 함께) 결과 모양이 같다', { skip }, () => {
  const r = asUser(A, 'select public.msgr_delete_me()');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(lastLine(r)), { deleted_orgs: 1 });
  assert.equal(one(`select count(*) from auth.users where id = '${A}'`), '0');
  assert.equal(one(`select count(*) from public.msgr_orgs where id = '${OA}'`), '0');
  assert.match(db.raw(['-A', '-t', '-c', 'set role authenticated; select public.msgr_delete_me()']).stderr, /msgr_unauthenticated/, '로그인 없음은 원래 함수의 거부 그대로');
});

test('3) 표지 있음 = 거부(데이터 불변): 계정 삭제 · 보관 조직 영구 삭제', { skip }, () => {
  setFlag(true);
  const before1 = snapshot();
  const r = asUser(B, 'select public.msgr_delete_me()');
  assert.match(r.stderr, /msgr2_migration_in_progress/);
  const p = db.raw(['-A', '-t', '-c', 'select public.msgr_purge_orgs()']);
  assert.match(p.stderr, /msgr2_migration_in_progress/);
  assert.equal(snapshot(), before1, '사람·조직·멤버·방 그대로');
  assert.equal(one(`select count(*) from public.msgr_orgs where id = '${OC}'`), '1', '보관 조직이 남는다');
});

test('4) 표지 끈 뒤 다시 정상', { skip }, () => {
  setFlag(false);
  const r = asUser(B, 'select public.msgr_delete_me()');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(lastLine(r)), { deleted_orgs: 1 });
  assert.equal(one('select public.msgr_purge_orgs()'), '1', '서비스 문맥 영구 삭제 1건');
  assert.equal(one(`select count(*) from public.msgr_orgs where id = '${OC}'`), '0');
});

test('5) 되돌림: 표지가 있으면 멈추고, 없으면 원래 이름·원래 권한·원래 본문으로', { skip }, () => {
  setFlag(true);
  assert.match(db.raw(['-c', DOWN]).stderr, /msgr2_rollback_window_open/);
  assert.equal(one("select count(*) from pg_proc where proname = '_msgr_delete_me_body'"), '1', '멈추면 아무것도 바꾸지 않는다');
  setFlag(false);
  const r = db.raw(['-c', DOWN]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(one("select count(*) from pg_proc where proname in ('_msgr_delete_me_body', '_msgr_purge_orgs_body', '_msgr2_migration_window')"), '0');
  for (const name of ['msgr_delete_me', 'msgr_purge_orgs']) assert.equal(one(`select md5(prosrc) from pg_proc where proname = '${name}'`), one(`select md5($b$${bodyOf(ORIG, name)}$b$)`), name);
  assert.equal(one("select has_function_privilege('authenticated', 'public.msgr_delete_me()', 'execute')"), 't');
  assert.equal(one("select has_function_privilege('authenticated', 'public.msgr_purge_orgs()', 'execute')"), 'f');
  assert.equal(one("select has_function_privilege('anon', 'public.msgr_delete_me()', 'execute')"), 'f');
  // 되돌린 뒤에도 계정 삭제가 돈다(표지 개념이 없다)
  setFlag(true);
  const c = asUser(C, 'select public.msgr_delete_me()');
  assert.equal(c.status, 0, c.stderr);
  setFlag(false);
});
