// 모바일 푸시 서버 부분(20260912150000_msgr_push.sql + 20260912160000 수정) 실행 검증 — 실제 Postgres에서만 잡히는 결함을 위해.
// 실사고 2026-09-12 15:49: msgr_push_register 의 매개변수 `token` 이 열 `token` 과 겹쳐 42702 → PostgREST 400 → iPhone 토큰 미등록.
// 하네스는 msgr-channel-scope-pg.test.mjs 와 같다(auth.uid() 스텁 + set role). ARGO_PG_TEST_URL 미설정이면 skip. 실행: `npm run test:pg`.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const migDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', member: '33333333-3333-4333-8333-333333333333' };

function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

before(() => {
  if (!DB) return;
  // 다른 pg 드릴과 같은 스텁: auth.uid() = argo.uid, 역할·스키마. 이미 있으면 그대로.
  sql(`create schema if not exists auth; create schema if not exists net; create schema if not exists extensions;
    do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;
    create table if not exists auth.users (id uuid primary key, email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    grant usage on schema public to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;`);
  // pg_net 이 없는 임시 DB — 트리거가 부르는 net.http_post 를 기록용 가짜로
  sql(`create table if not exists net.calls (url text, body jsonb, at timestamptz default now());
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language plpgsql as $$ begin insert into net.calls(url, body) values (url, body); return 1; end $$;`);
  for (const f of readdirSync(migDir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    psqlRaw(['-v', 'ON_ERROR_STOP=0', '-f', `${migDir}${f}`]); // 무관한 마이그레이션(스토리지 정책·extension 등)은 임시 DB에서 실패해도 넘어간다 — 푸시 표·함수만 있으면 된다
  }
  assert.equal(sql(`select count(*) from pg_proc where proname = 'msgr_push_register'`), '1', '푸시 등록 함수가 적용됐다');
  sql(`insert into auth.users(id, email) values ('${U.owner}', 'o@x.test'), ('${U.member}', 'm@x.test') on conflict do nothing;`);
});

test('msgr_push_register — 매개변수 이름이 열 이름과 같아도 등록·갱신된다(42702 회귀)', { skip }, () => {
  const tok = 'ab'.repeat(32);
  assert.equal(last(asUser(U.owner, `select public.msgr_push_register('ios', '${tok}', 'iPhone 18_7');`)), '');
  assert.equal(last(asUser(U.owner, `select public.msgr_push_register('ios', '${tok}', 'again', 'wood-knock');`)), '', '같은 토큰 재등록 = 갱신(소리 포함)');
  assert.equal(sql(`select platform || '|' || device || '|' || user_id || '|' || sound from public.msgr_push_tokens where token = '${tok}'`), `ios|again|${U.owner}|wood-knock`);
  assert.equal(last(asUser(U.owner, `select public.msgr_push_register('ios', '${tok}', 'x', '../evil; drop');`)), '');
  assert.equal(sql(`select sound from public.msgr_push_tokens where token = '${tok}'`), 'evildrop', '소리 이름은 [a-z0-9-]만 남긴다');
  const bad = asUserRaw(U.owner, `select public.msgr_push_register('web', '${tok}', '');`);
  assert.match(bad.stderr, /msgr_bad_push_token/, '지원 안 하는 플랫폼 거절');
  const anon = psqlRaw(['-A', '-t', '-c', `set role authenticated; select public.msgr_push_register('ios', '${tok}', '');`]);
  assert.match(anon.stderr, /msgr_unauthorized/, '로그인 없이는 거절');
  assert.equal(last(asUser(U.owner, `select public.msgr_push_unregister('${tok}');`)), '');
  assert.equal(sql(`select count(*) from public.msgr_push_tokens where token = '${tok}'`), '0');
});
