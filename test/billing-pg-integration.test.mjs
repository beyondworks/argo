// apply_ls_event 실행 검증(분리 검수 F6) — SQL 논리를 **실제 Postgres**에 적용해 돌린다.
// 경계표는 test/helpers/ls-apply-cases.mjs(단일 정본)를 JS 거울 테스트와 공유한다.
// ARGO_PG_TEST_URL 미설정이면 전부 skip — CI/일반 `npm test`를 깨지 않는다.
// 실행: `npm run test:pg` (scripts/billing-pg-drill.sh — initdb 기반 임시 인스턴스, Docker 불필요)
// 또는 supabase start 후 ARGO_PG_TEST_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APPLY_CASES, T_OLD, T_NEW } from './helpers/ls-apply-cases.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));

function psqlRaw(args) {
  return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' });
}
function psql(args) {
  const r = psqlRaw(args);
  if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const lit = (v) => (v === null || v === undefined ? 'null' : `'${v}'`); // 값은 전부 이 파일의 상수 — 주입 표면 없음

const callApply = (inc, userId = UID) =>
  `select public.apply_ls_event('${userId}'::uuid, ${lit(inc.plan)}, ${lit(inc.sub)}, 'cust_x', ${lit(inc.status)}, ${lit(inc.ts)}::timestamptz, null, null)`;

before(() => {
  if (!DB) return;
  // 실 Supabase에만 있는 전제(roles·auth 스키마)를 스텁으로 — 마이그레이션이 그대로 적용되게 한다.
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key);
    create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
  `]);
  // 실 마이그레이션 파일을 그대로 적용 — 테스트용 사본 SQL이 아니라 배포될 그 파일이 검증 대상이다.
  psql(['-f', mig('20260714150000_entitlements.sql')]);
  psql(['-f', mig('20260728100000_entitlements_ls.sql')]);
  psql(['-f', mig('20260728113000_billing_hardening.sql')]);
  psql(['-f', mig('20260728150000_ls_reconcile_cooldown.sql')]);
  psql(['-c', `insert into auth.users (id) values ('${UID}') on conflict do nothing`]);
});

test('경계표: 실제 apply_ls_event의 판정 문자열·최종 행 상태가 표와 일치', { skip }, () => {
  for (const c of APPLY_CASES) {
    sql(`delete from public.entitlements where user_id = '${UID}'`);
    if (c.stored) {
      sql(`insert into public.entitlements (user_id, plan, ls_subscription_id, ls_status, ls_updated_at)
           values ('${UID}', ${lit(c.stored.plan)}, ${lit(c.stored.sub)}, ${lit(c.stored.status)}, ${lit(c.stored.ts)}::timestamptz)`);
    }
    assert.equal(sql(callApply(c.incoming)), c.expect, `판정: ${c.name}`);
    // 최종 행 = applied면 incoming 스냅샷, 차단이면 stored 그대로 — "과거 상태가 최종으로 남지 않는다" 검증
    const want = c.expect === 'applied' ? c.incoming : c.stored;
    const row = sql(`select plan || '|' || ls_subscription_id || '|' || ls_status from public.entitlements where user_id = '${UID}'`);
    assert.equal(row, `${want.plan}|${want.sub}|${want.status}`, `최종 행: ${c.name}`);
  }
});

test('권한: anon·authenticated는 실행 불가(자기 승격 차단), service_role은 실행 가능', { skip }, () => {
  for (const role of ['anon', 'authenticated']) {
    const r = psqlRaw(['-c', `set role ${role}; ${callApply({ plan: 'pro', sub: 'S1', ts: null, status: 'active' })}`]);
    assert.notEqual(r.status, 0, `${role}이 실행됨 — 자기 승격 구멍`);
    assert.match(r.stderr, /permission denied/i, role);
  }
  sql(`delete from public.entitlements where user_id = '${UID}'`);
  const out = psql(['-A', '-t', '-c', `set role service_role; ${callApply({ plan: 'pro', sub: 'S1', ts: null, status: 'active' })}`]).trim();
  assert.equal(out, 'applied');
});

test('대사 쿨다운(F7): default epoch=즉시 선점, 시도·부정확정 게이트가 WHERE에서 작동, intent 해제로 재선점', { skip }, () => {
  // claimReconcile(src/lsreconcile.mjs)이 PostgREST lte 필터 2개로 생성하는 것과 같은 WHERE를
  // 실제 스키마에 대고 실행 — "행 갱신 = 선점"의 SQL 의미를 잠근다(2차 검수 MEDIUM: or 그룹
  // 결합 의미에 기대지 않는 설계의 실행 검증).
  const claim = () => sql(`update public.entitlements set ls_reconciled_at = now()
    where user_id = '${UID}' and ls_reconciled_at <= now() - interval '10 minutes'
      and ls_reconcile_empty_at <= now() - interval '24 hours'
    returning user_id`);
  sql(`delete from public.entitlements where user_id = '${UID}'`);
  sql(callApply({ plan: 'pro', sub: 'S1', ts: null, status: 'active' })); // 웹훅 경로 insert — 신규 컬럼 미지정
  assert.equal(sql(`select ls_reconciled_at = 'epoch' and ls_reconcile_empty_at = 'epoch' from public.entitlements where user_id = '${UID}'`), 't'); // default = 항상 due
  assert.equal(claim(), UID);      // 첫 선점 통과
  assert.equal(claim(), '');       // 방금 선점 — 시도 10분 게이트가 차단
  sql(`update public.entitlements set ls_reconciled_at = now() - interval '11 minutes', ls_reconcile_empty_at = now() - interval '1 hour' where user_id = '${UID}'`);
  assert.equal(claim(), '');       // 시도 게이트는 지났지만 부정 확정 24시간 게이트가 차단
  sql(`update public.entitlements set ls_reconcile_empty_at = 'epoch' where user_id = '${UID}'`); // 결제 의사 신호(intent)와 동일한 해제
  assert.equal(claim(), UID);      // 해제 후 재선점 — 복구 지연이 24시간→10분으로 복원되는 근거
});

test('동시성: 두 트랜잭션이 행 잠금으로 직렬화 — 늦은 과거 이벤트는 커밋된 새 상태 기준으로 stale', { skip }, async () => {
  sql(`delete from public.entitlements where user_id = '${UID}'`);
  // A: 최신 이벤트(cancelled, T_NEW)를 넣고 1.5초 잠금 유지. B: 그 사이 과거 이벤트(active, T_OLD) 시도.
  // A 커밋 전 스냅샷으로 판정했다면 B는 행이 없어 'applied'가 됐을 것 — 'stale'은 잠금 해제 후
  // 갱신된 행으로 WHERE를 **재평가**했다는 직접 증거다(select→비교→쓰기 3단계였다면 불가능).
  const aSql = `begin; ${callApply({ plan: 'pro', sub: 'S1', ts: T_NEW, status: 'cancelled' })}; select pg_sleep(1.5); commit;`;
  const a = spawn('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-c', aSql]);
  const aDone = new Promise((res, rej) => {
    a.on('error', rej);
    a.on('close', (code) => (code === 0 ? res() : rej(new Error(`동시성 A 트랜잭션 실패(exit ${code})`))));
  });
  await new Promise((r) => setTimeout(r, 400)); // A가 BEGIN+잠금을 먼저 잡도록
  const t0 = Date.now();
  const rB = sql(callApply({ plan: 'pro', sub: 'S1', ts: T_OLD, status: 'active' }));
  const elapsed = Date.now() - t0;
  await aDone;
  assert.equal(rB, 'stale');
  assert.ok(elapsed >= 500, `B가 행 잠금에 블록되지 않았다 (${elapsed}ms) — 직렬화 깨짐 의심`);
  assert.equal(sql(`select ls_status from public.entitlements where user_id = '${UID}'`), 'cancelled'); // 과거가 최종으로 남지 않음
});

test('경계표: is_pro() ends_at 집행(20260730050000) — 만료 pro=false·해지 예약=true·null=true·체험 OR 유지', { skip }, () => {
  // 유료 접근을 회수하는 집행 권위 — JS 거울(fetchPlan/proRowActive)만으론 SQL 논리 회귀를 못 잡는다(F6).
  psql(['-c', `create or replace function auth.uid() returns uuid language sql stable as $$ select '${UID}'::uuid $$`]);
  try {
    sql(`update auth.users set created_at = now() - interval '30 days' where id = '${UID}'`); // 체험 창 밖
    const setRow = (endsAt) => {
      sql(`delete from public.entitlements where user_id = '${UID}'`);
      sql(`insert into public.entitlements (user_id, plan, ends_at) values ('${UID}', 'pro', ${endsAt})`);
    };
    setRow(`now() - interval '1 day'`);
    assert.equal(sql('select public.is_pro()'), 'f', '만료 웹훅 유실 = 영구 무료 Pro 종결');
    setRow(`now() + interval '1 day'`);
    assert.equal(sql('select public.is_pro()'), 't', '해지 예약은 말일까지 접근 유지(LS 계약)');
    setRow('null');
    assert.equal(sql('select public.is_pro()'), 't', '활성·그랜드파더링(ends_at null) 불변');
    sql(`update auth.users set created_at = now() where id = '${UID}'`);
    setRow(`now() - interval '1 day'`);
    assert.equal(sql('select public.is_pro()'), 't', '가입 14일 체험 OR — pro 만료여도 체험 창이면 통과');
  } finally {
    psql(['-c', `create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid'`]); // 원복
    sql(`update auth.users set created_at = now() where id = '${UID}'`);
    sql(`delete from public.entitlements where user_id = '${UID}'`);
  }
});
