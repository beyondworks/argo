// 무료 계정 클라우드 차단 + Pro 5GiB 할당량(20261019130000·20261019130100·20261019130200) — **실제 Postgres**에 적용해 돌린다.
// ARGO_PG_TEST_URL 미설정이면 skip(일반 npm test 무영향). 실행: `npm run test:pg`(scripts/billing-pg-drill.sh).
// Storage 흉내: storage-api는 사용자 권한으로 행 넣기를 시험해 정책을 판정한다(판정 행 metadata.contentLength = 신고 크기). 시험 트랜잭션은
// 되돌려지고 실제 행은 따로 기록된다(supabase/storage pg.ts testPermission) — 여기서는 asUser insert = 판정, sql insert = 기록된 객체로 흉내 낸다.
// is_pro()는 시험용 표(test_pro)를 보는 대역이다 — 자격 판정 자체는 billing-pg 시험이 잠근다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Pro
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; // 무료
const Q = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // Pro — 한도 시험 전용
const BIG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // Pro — 객체 2.5만 개(비용 측정)
const LIMIT = 5368709120;

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asUser = (uid, q) => { const r = asUserRaw(uid, q); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout.trim(); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const meta = (declared) => (declared == null ? 'null' : `'{"contentLength": ${declared}}'`);
// 업로드 판정(사용자 권한) — 통과하면 행이 남는다(흉내에서는 판정 = 기록)
const upload = (uid, path, declared = 1) => asUserRaw(uid, `insert into storage.objects (bucket_id, name, owner, metadata) values ('companies', '${uid}/${path}', '${uid}', ${meta(declared)})`);
// 기록된 객체(서비스가 실제 크기를 채운 상태)
const stored = (uid, path, size, extra = '') => sql(`insert into storage.objects (bucket_id, name, owner, metadata${extra ? ', ' + extra.split('=')[0] : ''}) values ('companies', '${uid}/${path}', '${uid}', '{"size": ${size}}'${extra ? ', ' + extra.split('=')[1] : ''})`);

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
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create table public.test_pro (uid uuid primary key);
    create or replace function public.is_pro() returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.test_pro where uid = auth.uid()) $$;
    grant execute on function public.is_pro() to authenticated;
    insert into public.test_pro values ('${P}'), ('${Q}'), ('${BIG}');
    create schema if not exists storage;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb,
      archived_at timestamptz, is_delete_marker boolean default false);
    create unique index on storage.objects (bucket_id, name) where archived_at is null;
    create index idx_objects_bucket_id_name on storage.objects (bucket_id, name collate "C");
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, update, delete on storage.objects to authenticated;
    grant execute on function storage.foldername(text) to authenticated;
    -- 메신저 흉내(20261019130200이 보는 것만)
    create table public.msgr_settings (key text primary key, value text);
    create or replace function public._msgr_app_ver(v text) returns int[] language sql immutable as $$
      select case when v ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$' then string_to_array(v, '.')::int[] end $$;
  `]);
  for (const f of ['20260714090000_companies_storage_rls.sql', '20260903122559_tg_claims_pro_gate_exception.sql',
    '20260912010000_storage_companies_policy_sargable.sql', '20260910120000_sync_index_rpc.sql', '20261008210000_sync_index_skip_scan.sql']) psql(['-f', mig(f)]);
  // 기준 색인 함수 = 건너뛰기 판 본문(이름만 _ref) — 130100을 적용해도 Pro 반환이 같아야 한다
  const v = readFileSync(mig('20261008210000_sync_index_skip_scan.sql'), 'utf8');
  const fn = v.slice(v.indexOf('create or replace function public.argo_sync_index()'));
  psql(['-c', `${fn.slice(0, fn.indexOf('$$;', fn.indexOf('as $$') + 5) + 3).replace('public.argo_sync_index()', 'public.argo_sync_index_ref()')}
    grant execute on function public.argo_sync_index_ref() to authenticated;`]);
  // 130100은 그 시험 앞에서 적용한다 — 앞의 시험은 130000·130200만 적용된 상태(적용 도중)를 본다
  for (const f of ['20261019130000_companies_free_no_write_pro_quota.sql', '20261019130200_msgr_free_agent_zero.sql']) psql(['-f', mig(f)]);
  stored(P, 'co-1/company.json', 100);
  stored(F, 'co-f/company.json', 100);
  stored(F, '.tombstones/co-g.json', 10);
});

test('무료 계정은 companies에 아무것도 못 쓴다 — 회사 파일·리스·텔레그램 클레임 예외가 없어졌다', { skip }, () => {
  for (const path of ['co-f/vault/a.md', '_device-lease.json', '.tg-claims/0123456789abcdef01234567.json']) {
    const r = upload(F, path, 10);
    assert.notEqual(r.status, 0, `무료 업로드가 통과했다: ${path}`);
    assert.match(r.stderr, /row-level security/i, path);
  }
  const u = asUserRaw(F, `update storage.objects set metadata = '{"contentLength": 5}' where name = '${F}/co-f/company.json'`);
  assert.notEqual(u.status, 0, '무료 계정의 덮어쓰기가 통과했다'); // 읽기 차단(130100) 전이라 행이 보이고, with check(is_pro)가 막는다
  assert.match(u.stderr, /row-level security/i);
  assert.equal(sql(`select metadata->>'size' from storage.objects where name = '${F}/co-f/company.json'`), '100', '무료 계정이 자기 객체를 고쳤다');
});

test('무료 계정도 자기 사본은 지울 수 있다(delete는 플랜 무관), 남의 것은 못 지운다', { skip }, () => {
  stored(F, 'co-f/old.md', 5);
  asUser(F, `delete from storage.objects where name = '${F}/co-f/old.md'`);
  assert.equal(sql(`select count(*) from storage.objects where name = '${F}/co-f/old.md'`), '0');
  asUser(F, `delete from storage.objects where name = '${P}/co-1/company.json'`);
  assert.equal(sql(`select count(*) from storage.objects where name = '${P}/co-1/company.json'`), '1', '무료 계정이 남의 객체를 지웠다');
});

test('Pro는 한도 안에서 올리고 덮어쓴다, 남의 경로는 여전히 못 쓴다', { skip }, () => {
  assert.equal(upload(P, 'co-1/vault/memo.md', 2000).status, 0);
  assert.equal(upload(P, '_device-lease.json', 300).status, 0);
  asUser(P, `update storage.objects set metadata = '{"contentLength": 500}' where name = '${P}/co-1/vault/memo.md'`);
  assert.notEqual(asUserRaw(P, `insert into storage.objects (bucket_id, name, owner, metadata) values ('companies', '${F}/co-f/evil.md', '${P}', ${meta(1)})`).status, 0, 'Pro가 남의 경로에 썼다');
});

test('5GiB 경계: 합 + 신고 크기가 한도와 같으면 받고, 1바이트라도 넘으면 PT402 quota_exceeded', { skip }, () => {
  stored(Q, 'co-q/big.bin', LIMIT - 1000);
  assert.equal(upload(Q, 'co-q/a.md', 1000).status, 0, '정확히 한도까지는 받아야 한다');
  sql(`update storage.objects set metadata = '{"size": 1000}' where name = '${Q}/co-q/a.md'`); // 서비스가 실제 크기를 채운다
  const r = upload(Q, 'co-q/b.md', 1);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /quota_exceeded/);
  const st = asUserRaw(Q, `do $$ begin perform public.argo_companies_quota_check('{"name": "${Q}/co-q/c.md", "metadata": {"contentLength": 7}}'::jsonb); exception when others then raise exception 'state=%', sqlstate; end $$`);
  assert.match(st.stderr, /state=PT402/, '앱은 SQLSTATE PT402로 할당량 초과를 알아본다');
  // 신고 크기가 없으면(옛 storage-api) 1바이트로 본다 — 0으로 통과시키지 않는다
  const n = upload(Q, 'co-q/d.md', null);
  assert.notEqual(n.status, 0, '신고 크기 없는 업로드가 한도를 넘어 통과했다');
  // 기존 파일은 그대로(지우지 않는다)
  assert.equal(sql(`select count(*) from storage.objects where name like '${Q}/%'`), '2');
});

test('한도 근처의 덮어쓰기는 옛 크기를 빼고 본다 — 같은 이름을 같은 크기로 다시 올리면 받는다', { skip }, () => {
  // Q는 지금 정확히 한도(LIMIT). a.md(1000)를 1000바이트로 덮어쓰면 합은 그대로다.
  const up = asUserRaw(Q, `update storage.objects set metadata = '{"contentLength": 1000}' where name = '${Q}/co-q/a.md'`);
  assert.equal(up.status, 0, up.stderr);
  assert.equal(sql(`select metadata->>'contentLength' from storage.objects where name = '${Q}/co-q/a.md'`), '1000', '정상 덮어쓰기가 거절됐다(옛 크기를 함께 셌다)');
  const over = asUserRaw(Q, `update storage.objects set metadata = '{"contentLength": 1001}' where name = '${Q}/co-q/a.md'`);
  assert.notEqual(over.status, 0, '덮어쓰기로 한도를 넘겼다');
  assert.match(over.stderr, /quota_exceeded/);
  // upsert 흉내(insert … on conflict do update) — 같은 이름 같은 크기
  const ups = asUserRaw(Q, `insert into storage.objects (bucket_id, name, owner, metadata) values ('companies', '${Q}/co-q/a.md', '${Q}', '{"contentLength": 1000}')
    on conflict (bucket_id, name) where archived_at is null do update set metadata = excluded.metadata`);
  assert.equal(ups.status, 0, ups.stderr);
});

test('보관본(archived_at)·삭제 표시·다른 사람·다른 버킷은 사용량에 안 들어간다', { skip }, () => {
  const R = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  sql(`insert into public.test_pro values ('${R}')`);
  stored(R, 'co-r/live.md', 100);
  stored(R, 'co-r/old.md', LIMIT, `archived_at=now()`);
  stored(R, 'co-r/gone.md', LIMIT, `is_delete_marker=true`);
  sql(`insert into storage.objects (bucket_id, name, owner, metadata) values ('msgr', '${R}/x', '${R}', '{"size": ${LIMIT}}')`);
  stored(`${R.slice(0, -1)}f`, 'co/x.md', LIMIT); // uid가 R로 시작하는 다른 사람 — 범위 [R/, R0)에 안 들어간다
  assert.deepEqual(JSON.parse(last(asUser(R, 'select public.argo_storage_quota()'))), { used: 100, limit: LIMIT, pro: true });
  assert.equal(upload(R, 'co-r/new.md', 1000).status, 0);
});

test('argo_storage_quota: 무료는 0/0, 미로그인은 null, anon은 권한 없음', { skip }, () => {
  assert.deepEqual(JSON.parse(last(asUser(F, 'select public.argo_storage_quota()'))), { used: 0, limit: 0, pro: false });
  assert.equal(last(asUser('', `select coalesce(public.argo_storage_quota()::text, 'NULL')`)), 'NULL');
  const r = psqlRaw(['-c', 'set role anon; select public.argo_storage_quota()']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /permission denied/i);
  const g = psqlRaw(['-c', `set role authenticated; select public._argo_companies_used('${P}')`]);
  assert.notEqual(g.status, 0, '남의 사용량을 묻는 내부 함수가 열려 있다'); assert.match(g.stderr, /permission denied/i);
});

test('판정은 쓰기 0 — 업로드 판정·사용량 조회 뒤에도 트랜잭션 id가 배정되지 않는다', { skip }, () => {
  const out = asUser(P, `select public.argo_companies_quota_check('{"name": "${P}/co-1/z.md", "metadata": {"contentLength": 10}}'::jsonb)::text
    || ',' || public.argo_storage_quota()::text || ',' || coalesce(txid_current_if_assigned()::text, 'none')`);
  assert.match(last(out), /,none$/, `판정이 무언가를 썼다: ${out}`);
});

// ─── 20261019130100: 무료 읽기 차단 ───
test('[읽기 차단 130100] 무료 계정은 자기 사본을 select로 못 본다(그래서 지우지도 못한다), Pro는 본다', { skip }, () => {
  psql(['-f', mig('20261019130100_companies_free_no_read.sql')]);
  assert.equal(last(asUser(F, `select count(*) from storage.objects where bucket_id = 'companies'`)), '0');
  assert.ok(Number(last(asUser(P, `select count(*) from storage.objects where bucket_id = 'companies'`))) >= 1);
  // 알려진 결과: delete의 where가 행을 읽으므로 select 차단이 무료 계정의 자기 사본 삭제도 막는다(storage-api remove도 먼저 읽는다)
  asUser(F, `delete from storage.objects where name = '${F}/co-f/company.json'`);
  assert.equal(sql(`select count(*) from storage.objects where name = '${F}/co-f/company.json'`), '1');
});

test('[읽기 차단 130100] argo_sync_index: 무료는 빈 목록(null 아님), Pro는 기준 함수와 같다', { skip }, () => {
  assert.deepEqual(JSON.parse(last(asUser(F, 'select public.argo_sync_index()'))), { owner: F, companies: [], tombstones: [] });
  const [a, b] = last(asUser(P, `select public.argo_sync_index_ref()::text || chr(9) || public.argo_sync_index()::text`)).split('\t');
  assert.deepEqual(JSON.parse(b), JSON.parse(a));
  assert.ok(JSON.parse(b).companies.includes('co-1'));
});

// ─── 메신저(20261019130200) ───
test('메신저 무료 에이전트 한도: 기본 0명, 설정 free_agent_limit으로 되돌린다(0~4 숫자만)', { skip }, () => {
  const lim = () => sql('select agent_limit from public._msgr_free_agent_policy()');
  assert.equal(lim(), '0');
  sql(`insert into public.msgr_settings values ('free_agent_limit', '4')`); assert.equal(lim(), '4');
  sql(`update public.msgr_settings set value = '9' where key = 'free_agent_limit'`); assert.equal(lim(), '0', '범위 밖 값은 0(차단)으로 본다');
  sql(`update public.msgr_settings set value = 'x' where key = 'free_agent_limit'`); assert.equal(lim(), '0');
  sql(`delete from public.msgr_settings where key = 'free_agent_limit'`);
  assert.equal(sql('select min_app || \',\' || window_s from public._msgr_free_agent_policy()'), '0.1.102,1800', '최소 버전·창은 그대로');
});

// ─── 비용: 객체 2.5만 개 계정의 업로드 판정 1건 ───
test('비용: 객체 25,000개 Pro 계정의 업로드 판정 1건(데운 캐시) — 측정값을 출력한다', { skip }, () => {
  sql(`insert into storage.objects (bucket_id, name, owner, metadata)
       select 'companies', '${BIG}/co-' || (i % 40) || '/f' || i || '.md', '${BIG}', jsonb_build_object('size', 2000, 'mimetype', 'text/markdown')
         from generate_series(1, 25000) i;
       insert into storage.objects (bucket_id, name, owner, metadata)
       select 'companies', md5(i::text) || '/co/x' || i, null, '{"size": 1}' from generate_series(1, 300000) i; -- 다른 계정들(운영처럼 한 계정은 표의 일부)
       analyze storage.objects;`);
  const q = `select public.argo_companies_quota_check('{"name": "${BIG}/co-1/new.md", "metadata": {"contentLength": 10}}'::jsonb)`;
  asUser(BIG, q); // 데우기
  const ms = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint(); asUser(BIG, q); ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const inner = sql(`explain (analyze, buffers, format text) select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o
    where o.bucket_id = 'companies' and (o.name collate "C") >= '${BIG}/' and (o.name collate "C") < '${BIG}0' and o.archived_at is null and not coalesce(o.is_delete_marker, false)`);
  console.log(`# [비용] psql 왕복 포함 판정 1건(ms): ${ms.map((x) => x.toFixed(1)).join(', ')}`);
  console.log(`# [비용] 합계 질의 계획:\n${inner.split('\n').map((l) => '#   ' + l).join('\n')}`);
  assert.match(inner, /Index Scan|Bitmap/, '합계가 (bucket_id, name) 색인을 타지 않는다');
  assert.deepEqual(JSON.parse(last(asUser(BIG, 'select public.argo_storage_quota()'))), { used: 25000 * 2000, limit: LIMIT, pro: true });
});
