// 동기화 색인 RPC(20260910120000_sync_index_rpc.sql) 실행 검증 — **실제 Postgres**에 적용해 돌린다.
// ARGO_PG_TEST_URL 미설정이면 전부 skip(일반 npm test 무영향). 실행: `npm run test:pg`(scripts/billing-pg-drill.sh).
// 잠그는 계약: security definer지만 오너 경계는 함수 안 auth.uid()로 강제 — 남의 접두사는 절대 안 나온다.
// 판정은 discoverRemote(점 접두 폴더·최상위 파일 제외)·syncTombstones(uid/.tombstones/<wsId>.json 직계만)와 동일.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // 고정 uuid(주입 표면 없음)

function psqlRaw(args) { return psqlSpawn(DB, args); }
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
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, archived_at timestamptz, is_delete_marker boolean default false);
    create index if not exists idx_objects_bucket_id_name on storage.objects (bucket_id, name collate "C");
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select on storage.objects to authenticated;
  `]);
  psql(['-f', mig('20260910120000_sync_index_rpc.sql')]);
  // 기준 함수 = 첫 판 본문 그대로(이름만 _ref) — 건너뛰기 판(20261008210000)의 반환이 이것과 같아야 한다
  const v1 = readFileSync(mig('20260910120000_sync_index_rpc.sql'), 'utf8');
  const fn = v1.slice(v1.indexOf('create or replace function public.argo_sync_index()'));
  psql(['-c', `${fn.slice(0, fn.indexOf('$$;', fn.indexOf('as $$') + 5) + 3).replace('public.argo_sync_index()', 'public.argo_sync_index_ref()')}
    grant execute on function public.argo_sync_index_ref() to authenticated;`]);
  psql(['-f', mig('20261008210000_sync_index_skip_scan.sql')]);
  const rows = [
    [A, 'co-1/company.json'], [A, 'co-1/vault/memo.md'], [A, 'co-2/company.json'],
    [A, '_device-lease.json'],                 // 최상위 파일 — 회사 아님
    [A, '.tg-claims/0123456789abcdef01234567.json'], // 점 접두 폴더 — 회사 아님
    [A, '.tombstones/co-9.json'], [A, '.tombstones/co-8.json'],
    [A, '.tombstones/co-7.json/inner.json'],   // 직계가 아니다(.json 이름의 폴더 아래) — 제외. 변이 I: 직계 조건을 빼면 co-7이 새어 나온다
    [A, '.tombstones/readme.txt'],             // .json이 아니다 — 제외
    [B, 'co-3/company.json'], [B, '.tombstones/co-6.json'],
  ];
  // 버전 관리 열 — 옛 버전(archived_at)·삭제 마커는 색인에서 제외(검수 MEDIUM-4)
  sql(`insert into storage.objects (bucket_id, name, archived_at) values ('companies', '${A}/co-old/company.json', now())`);
  sql(`insert into storage.objects (bucket_id, name, is_delete_marker) values ('companies', '${A}/co-gone/company.json', true), ('companies', '${A}/.tombstones/co-5.json', true)`);
  sql(`insert into storage.objects (bucket_id, name) values ${rows.map(([u, p]) => `('companies', '${u}/${p}')`).join(',')}, ('other-bucket', '${A}/co-x/company.json')`);
});

test('오너 A는 자기 회사·직계 tombstone만 받는다(다른 버킷·최상위 파일·점 접두·중첩·비json 제외)', { skip }, () => {
  const r = parse(asUser(A, 'select public.argo_sync_index()'));
  assert.equal(r.owner, A, '색인은 호출자 uid를 실어야 클라이언트가 세션과 대조한다');
  assert.deepEqual(r.companies.sort(), ['co-1', 'co-2']);
  assert.deepEqual(r.tombstones.sort(), ['co-8', 'co-9']);
});

test('인덱스 범위 조회의 핵심 장치 collate "C"가 SQL에 남아 있다(검수 MEDIUM-2: 지워도 판정 테스트는 초록이었다)', () => {
  const text = readFileSync(mig('20260910120000_sync_index_rpc.sql'), 'utf8');
  const mine = text.slice(text.indexOf('mine as ('), text.indexOf('select case when'));
  assert.equal((mine.match(/collate "C"/g) || []).length, 2, '범위 상·하한 둘 다 collate "C"여야 (bucket_id, name COLLATE "C") 인덱스를 타고, glibc 로케일 정렬에서도 [uid/, uid0) 범위가 성립한다');
  assert.match(text, /rolbypassrls or rolsuper/, '적용 역할 게이트가 빠졌다 — RLS를 못 우회하는 역할로 적용되면 색인이 조용히 빈다(HIGH-1)');
});

test('오너 B는 A의 것을 한 줄도 못 본다(definer지만 경계는 auth.uid())', { skip }, () => {
  const r = parse(asUser(B, 'select public.argo_sync_index()'));
  assert.deepEqual(r, { owner: B, companies: ['co-3'], tombstones: ['co-6'] });
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
  assert.deepEqual(parse(asUser(C, 'select public.argo_sync_index()')), { owner: C, companies: [], tombstones: [] });
});

// ─── 건너뛰기 판(20261008210000) — 반환은 첫 판과 같고, 비용은 객체 수가 아니라 최상위 항목 수에 비례 ───
// 운영 실측(2026-10-08): 객체 24,864개 오너가 힙 페이지 24,711개를 읽어 차가운 캐시 12.4초 → statement_timeout(8초) 초과·list 폴백.
const both = (uid) => {
  const [a, b] = last(asUser(uid, `select public.argo_sync_index_ref()::text || chr(9) || public.argo_sync_index()::text`)).split('\t');
  return { ref: JSON.parse(a), now: JSON.parse(b) };
};
const insertNames = (uid, names) => sql(`insert into storage.objects (bucket_id, name) values ${names.map((n) => `('companies', '${uid}/${n}')`).join(',')}`);

test('경계 이름에서 첫 판과 같은 반환 — 최상위 파일과 같은 이름의 폴더, S로 시작하는 이웃 항목, 빈 세그먼트, 옛 버전·삭제 마커', { skip }, () => {
  const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  insertNames(E, [
    'co', 'co-x/company.json', 'co/company.json', 'co.y/a.md', 'co0/a', // 'co' 파일 뒤 'co-x/'·'co/' 사이에 끼는 이웃 — 파일에서 건너뛰면 co-x를 놓친다
    'yy/',                       // 빈 하위 이름뿐 — 회사 아님
    'zz//x',                     // 셋째 세그먼트가 빈 문자열뿐 — 회사 아님
    'ww/', 'ww/f',               // 빈 이름 + 실제 파일 — 회사
    '회사/company.json', 'émoji😀/a.json', 'a%b/c.json', 'a_b/c.json', '_device-lease.json',
    '.tombstones', '.tombstones/t1.json', '.tombstones/x/y.json', '.tombstones-a/t3.json', '.tombstonesX/t2.json', '.tombstones/t4.txt',
  ]);
  sql(`insert into storage.objects (bucket_id, name, archived_at) values ('companies', '${E}/aa/0.json', now()), ('companies', '${E}/bb/x', now()), ('companies', '${E}/.tombstones/t5.json', now())`);
  sql(`insert into storage.objects (bucket_id, name, is_delete_marker) values ('companies', '${E}/aa/00.json', true), ('companies', '${E}/bc/0', true)`);
  insertNames(E, ['aa/1.json', 'bc/1']); // 옛 버전·삭제 마커 뒤의 살아 있는 객체
  const { ref, now } = both(E);
  assert.deepEqual(now, ref);
  assert.deepEqual([...now.companies].sort(), ['a%b', 'a_b', 'aa', 'bc', 'co', 'co-x', 'co.y', 'co0', 'émoji😀', 'ww', '회사'].sort(), '기준 함수 자체가 기대와 다르면 비교가 무의미하다');
  assert.deepEqual(now.tombstones, ['t1']);
});

test('무작위 이름 60명 × 40개에서 첫 판과 반환이 같다(정렬 순서 포함)', { skip }, () => {
  let s = 20261008; // 고정 시드 — 실패가 재현돼야 한다
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const alpha = ['a', 'b', '-', '.', '0', '/', '/', '_', '%', 'é', '.tombstones/', '.json'];
  const owners = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const vals = [];
  for (const u of owners) {
    for (let k = 0; k < 40; k++) {
      const n = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pick(alpha)).join('');
      const r = rnd();
      vals.push(`('${pick(['companies', 'companies', 'companies', 'other'])}', '${u}/${n}', ${r < 0.1 ? 'now()' : 'null'}, ${r > 0.9})`);
    }
  }
  sql(`insert into storage.objects (bucket_id, name, archived_at, is_delete_marker) values ${vals.join(',')}`);
  const diff = owners.filter((u) => { const { ref, now } = both(u); return JSON.stringify(ref) !== JSON.stringify(now); });
  assert.deepEqual(diff, []);
});

test('객체 2만 개 오너도 읽는 버퍼가 최상위 항목 수에 비례하고, 첫 판보다 10배 이상 빠르다', { skip }, () => {
  const P = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  // 무작위 삽입 순서 = 운영처럼 같은 오너의 객체가 힙 여러 페이지에 흩어진다
  sql(`insert into storage.objects (bucket_id, name)
       select 'companies', '${P}/' || (array['co-a','co-b','co-c','co-d'])[1 + i % 4] || '/vault/' || i || '.md' from generate_series(1, 20000) i order by random()`);
  insertNames(P, ['_device-lease.json', '.tombstones/co-z.json', '.tg-claims/1.json', '.tg-claims/2.json']);
  sql('analyze storage.objects');
  // 같은 세션에서 한 번 부른 뒤 잰다 — 세션 첫 호출은 함수 계획용 카탈로그 적재(버퍼 약 500)가 섞인다. PostgREST는 연결을 재사용한다.
  const plan = (f) => { const j = JSON.parse(asUser(P, `select public.${f}(); explain (analyze, buffers, format json) select public.${f}()`))[0]; return { buf: j.Plan['Shared Hit Blocks'] + j.Plan['Shared Read Blocks'], ms: j['Execution Time'] }; };
  const now = plan('argo_sync_index'), ref = plan('argo_sync_index_ref');
  console.log(`# 객체 20,004개 오너: 건너뛰기 판 버퍼 ${now.buf}·${now.ms.toFixed(1)}ms / 첫 판 버퍼 ${ref.buf}·${ref.ms.toFixed(1)}ms`);
  assert.ok(now.buf < 100, `읽는 버퍼가 최상위 항목 수(7)에 비례해야 한다 — ${now.buf}`);
  assert.ok(now.ms * 10 < ref.ms, `건너뛰기 판이 첫 판보다 10배 이상 빨라야 한다 — ${now.ms}ms vs ${ref.ms}ms`);
  assert.deepEqual(both(P).now, both(P).ref);
});

test('색인 호출은 쓰기 0 — 호출 트랜잭션에 xid가 배정되지 않는다(STABLE)', { skip }, () => {
  // 탐지 장치 확인: 쓰기가 있으면 xid가 배정된다
  assert.equal(sql(`insert into storage.objects (bucket_id, name) values ('probe', 'x'); select pg_current_xact_id_if_assigned() is not null`), 't');
  assert.equal(last(asUser(A, 'select public.argo_sync_index(); select public.argo_sync_index(); select pg_current_xact_id_if_assigned() is null')), 't');
  assert.equal(sql(`select provolatile from pg_proc where oid = 'public.argo_sync_index()'::regprocedure`), 's');
});

test('건너뛰기 판의 이름 비교·정렬이 전부 collate "C"다(운영 기본 정렬 ICU en-US에서는 [uid/, uid0) 범위가 성립하지 않는다)', () => {
  const text = readFileSync(mig('20261008210000_sync_index_skip_scan.sql'), 'utf8');
  const body = text.slice(text.indexOf('as $$'), text.lastIndexOf('$$;'));
  assert.doesNotMatch(body, /\bo\.name\s*[<>]/, 'collate 없는 이름 비교가 있다');
  assert.doesNotMatch(body, /order by (?!o\.name collate "C" limit 1)/, '첫 객체를 찾는 정렬이 인덱스 정렬(collate "C")과 달라졌다');
});
