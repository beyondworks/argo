// 동기화 색인 RPC(20260910120000_sync_index_rpc.sql) 실행 검증 — **실제 Postgres**에 적용해 돌린다.
// ARGO_PG_TEST_URL 미설정이면 전부 skip(일반 npm test 무영향). 실행: `npm run test:pg`(scripts/billing-pg-drill.sh).
// 잠그는 계약: security definer지만 오너 경계는 함수 안 auth.uid()로 강제 — 남의 접두사는 절대 안 나온다.
// 판정은 discoverRemote(점 접두 폴더·최상위 파일 제외)·syncTombstones(uid/.tombstones/<wsId>.json 직계만)와 동일.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // 고정 uuid(주입 표면 없음)

function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const parse = (s) => JSON.parse(last(s));

before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated;
    create schema if not exists auth;
    grant usage on schema auth to anon, authenticated;
    -- auth.uid() 스텁: 세션 변수 argo.uid(비면 null = 미로그인)
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    -- storage.objects 스텁 — 실 Supabase와 같은 열 이름. RLS를 켜고 정책은 두지 않는다: 직접 select는 0행,
    -- definer 함수만 행을 본다(우회 경로가 함수뿐임을 함께 증명).
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select on storage.objects to authenticated;
  `]);
  psql(['-f', mig('20260910120000_sync_index_rpc.sql')]);
  const rows = [
    [A, 'co-1/company.json'], [A, 'co-1/vault/memo.md'], [A, 'co-2/company.json'],
    [A, '_device-lease.json'],                 // 최상위 파일 — 회사 아님
    [A, '.tg-claims/0123456789abcdef01234567.json'], // 점 접두 폴더 — 회사 아님
    [A, '.tombstones/co-9.json'], [A, '.tombstones/co-8.json'],
    [A, '.tombstones/co-7.json/inner.json'],   // 직계가 아니다(.json 이름의 폴더 아래) — 제외. 변이 I: 직계 조건을 빼면 co-7이 새어 나온다
    [A, '.tombstones/readme.txt'],             // .json이 아니다 — 제외
    [B, 'co-3/company.json'], [B, '.tombstones/co-6.json'],
  ];
  sql(`insert into storage.objects (bucket_id, name) values ${rows.map(([u, p]) => `('companies', '${u}/${p}')`).join(',')}, ('other-bucket', '${A}/co-x/company.json')`);
});

test('오너 A는 자기 회사·직계 tombstone만 받는다(다른 버킷·최상위 파일·점 접두·중첩·비json 제외)', { skip }, () => {
  const r = parse(asUser(A, 'select public.argo_sync_index()'));
  assert.deepEqual(r.companies.sort(), ['co-1', 'co-2']);
  assert.deepEqual(r.tombstones.sort(), ['co-8', 'co-9']);
});

test('오너 B는 A의 것을 한 줄도 못 본다(definer지만 경계는 auth.uid())', { skip }, () => {
  const r = parse(asUser(B, 'select public.argo_sync_index()'));
  assert.deepEqual(r, { companies: ['co-3'], tombstones: ['co-6'] });
  // 직접 select는 RLS(정책 없음)로 0행 — 행을 보는 경로는 함수뿐
  assert.equal(last(asUser(B, `select count(*) from storage.objects`)), '0');
});

test('uid 없음(미로그인 authenticated)·anon은 색인을 받지 못한다', { skip }, () => {
  assert.equal(last(asUser('', 'select coalesce(public.argo_sync_index()::text, \'NULL\')')), 'NULL');
  const r = psqlRaw(['-c', 'set role anon; select public.argo_sync_index()']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /permission denied/i);
});

test('회사 0개 오너는 빈 배열(null 아님) — 클라이언트 형태 검증을 통과해야 폴백 list를 안 탄다', { skip }, () => {
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  assert.deepEqual(parse(asUser(C, 'select public.argo_sync_index()')), { companies: [], tombstones: [] });
});
