// apply_ls_event 실행 검증(분리 검수 F6) — SQL 논리를 **실제 Postgres**에 적용해 돌린다.
// 경계표는 test/helpers/ls-apply-cases.mjs(단일 정본)를 JS 거울 테스트와 공유한다.
// ARGO_PG_TEST_URL 미설정이면 전부 skip — CI/일반 `npm test`를 깨지 않는다.
// 실행: `npm run test:pg` (scripts/billing-pg-drill.sh — initdb 기반 임시 인스턴스, Docker 불필요)
// 또는 supabase start 후 ARGO_PG_TEST_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APPLY_CASES, T_OLD, T_NEW } from './helpers/ls-apply-cases.mjs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));

function psqlRaw(args) {
  return psqlSpawn(DB, args);
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

let T = null; // R1 기준 시각(T) — 20260929110000 적용 순간에 함수 본문에 리터럴로 굳는다. 정확한 값을 함수 정의에서 역추출.

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
    -- created_at: is_pro(trial_14d·ends_at)의 language sql 본문이 CREATE 시점에 파싱된다 — 없으면 적용 자체가 실패
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now());
    create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
    -- msgr 스키마 스텁(20260929110000의 entitled_pro_for가 join) — 900줄짜리 20260903120000_msgr.sql 전체를
    -- 로드하지 않고, is_pro()가 실제로 참조하는 3표만 auth.users와 같은 방식으로 최소 재현한다.
    create table if not exists public.msgr_orgs (id uuid primary key, deleted_at timestamptz);
    create table if not exists public.msgr_org_members (org_id uuid, user_id uuid, removed_at timestamptz, role text);
    create table if not exists public.msgr_org_entitlements (org_id uuid primary key, paid_until timestamptz);
  `]);
  // 실 마이그레이션 파일을 그대로 적용 — 테스트용 사본 SQL이 아니라 배포될 그 파일이 검증 대상이다.
  psql(['-f', mig('20260714150000_entitlements.sql')]);
  psql(['-f', mig('20260724000100_trial_14d.sql')]);
  psql(['-f', mig('20260728100000_entitlements_ls.sql')]);
  psql(['-f', mig('20260728113000_billing_hardening.sql')]);
  psql(['-f', mig('20260728150000_ls_reconcile_cooldown.sql')]);
  psql(['-f', mig('20260730050000_is_pro_ends_at.sql')]);
  psql(['-f', mig('20260929110000_plan_no_trial.sql')]);
  psql(['-c', `insert into auth.users (id) values ('${UID}') on conflict do nothing`]);
  // T를 trial_end_for의 CREATE 문 텍스트에서 역추출 — 이 테스트가 만든 값이 아니라 마이그레이션이
  // 실제로 굳힌 리터럴이라는 근거(재현: 코드가 아니라 DB에 실제로 박힌 값을 본다).
  T = sql(`select (regexp_match(pg_get_functiondef('public.trial_end_for(uuid)'::regprocedure), '''([^'']+)''::timestamptz'))[1]`);
  if (!T) throw new Error('T 추출 실패 — trial_end_for 정의에서 리터럴을 못 찾음');
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

test('경계표: is_pro() ends_at 집행(20260730050000) — 만료 pro=false·해지 예약=true·null=true, R1 체험 OR은 T 이전 가입자만', { skip }, () => {
  // 유료 접근을 회수하는 집행 권위 — JS 거울(fetchPlan/proRowActive)만으론 SQL 논리 회귀를 못 잡는다(F6).
  psql(['-c', `create or replace function auth.uid() returns uuid language sql stable as $$ select '${UID}'::uuid $$`]);
  try {
    sql(`update auth.users set created_at = '${T}'::timestamptz - interval '30 days' where id = '${UID}'`); // T 이전 가입 + 체험 창 밖
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
    // R1: T 이전(마이그레이션 적용 전) 가입자는 남은 체험 기간을 보장받는다 — pro 행이 만료여도 체험 OR로 통과.
    sql(`update auth.users set created_at = '${T}'::timestamptz - interval '5 days' where id = '${UID}'`);
    setRow(`now() - interval '1 day'`);
    assert.equal(sql('select public.is_pro()'), 't', 'R1: T 이전 가입자는 남은 체험이 보장된다(pro 만료여도 체험 OR로 통과)');
  } finally {
    // 복원은 비throw(psqlRaw) — finally에서 throw하면 원래 단언 실패를 대체해 가린다(재검수 HIGH-B 부수).
    psqlRaw(['-c', `create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid'`]);
    psqlRaw(['-A', '-t', '-c', `update auth.users set created_at = now() where id = '${UID}'`]);
    psqlRaw(['-A', '-t', '-c', `delete from public.entitlements where user_id = '${UID}'`]);
  }
});

test('R1: T 이후 가입자는 체험이 없다 — 가입 직후라도 free', { skip }, () => {
  // 이유: 14일 무료 체험 폐지(2026-09-29). T 이전 가입자만 남은 체험을 보장받고, T 이후 가입자는 처음부터 free.
  psql(['-c', `create or replace function auth.uid() returns uuid language sql stable as $$ select '${UID}'::uuid $$`]);
  try {
    sql(`delete from public.entitlements where user_id = '${UID}'`);
    sql(`update auth.users set created_at = now() where id = '${UID}'`); // now() > T(before()에서 먼저 고정) — T 이후 가입
    assert.equal(sql('select public.is_pro()'), 'f', 'T 이후 가입자는 가입 즉시라도 체험이 없다');
    assert.equal(sql(`select public.trial_end_for('${UID}') is null`), 't', 'trial_end_for는 T 이후 가입자에게 null');
  } finally {
    psqlRaw(['-A', '-t', '-c', `update auth.users set created_at = now() where id = '${UID}'`]);
    psqlRaw(['-A', '-t', '-c', `delete from public.entitlements where user_id = '${UID}'`]);
  }
});

test('R2: entitlements.granted=true는 plan 값과 무관하게 pro이고, 결제 웹훅이 plan을 못 내린다', { skip }, () => {
  psql(['-c', `create or replace function auth.uid() returns uuid language sql stable as $$ select '${UID}'::uuid $$`]);
  try {
    sql(`update auth.users set created_at = now() where id = '${UID}'`); // T 이후 가입 — 체험 OR을 배제하고 granted만 본다
    sql(`delete from public.entitlements where user_id = '${UID}'`);
    sql(`insert into public.entitlements (user_id, plan, granted) values ('${UID}', 'free', true)`);
    assert.equal(sql('select public.is_pro()'), 't', 'granted=true면 plan=free여도 pro');
    // 결제 웹훅(cancelled → plan='free') 도착 — apply_ls_event가 plan을 못 내려야 한다.
    sql(`update public.entitlements set plan = 'pro', granted = true, ls_subscription_id = 'sub_g' where user_id = '${UID}'`);
    const verdict = sql(`select public.apply_ls_event('${UID}'::uuid, 'free', 'sub_g', 'cust_g', 'expired', now(), now(), null)`);
    assert.equal(verdict, 'applied', 'WHERE 판정 자체는 통과(신원 일치 — 그래야 ls_status가 갱신된다)');
    const row = sql(`select plan || '|' || ls_status from public.entitlements where user_id = '${UID}'`);
    assert.equal(row, 'pro|expired', 'plan은 granted가 지켜 pro로 남고, ls_status(결제 상태)는 그대로 기록된다');
  } finally {
    psqlRaw(['-c', `create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid'`]);
    psqlRaw(['-A', '-t', '-c', `update auth.users set created_at = now() where id = '${UID}'`]);
    psqlRaw(['-A', '-t', '-c', `delete from public.entitlements where user_id = '${UID}'`]);
  }
});

test('R2: Team OR는 msgr_org_entitlements.paid_until 기준 — plan 텍스트가 아니라 결제 기간, guest는 제외', { skip }, () => {
  const ORG = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  psql(['-c', `create or replace function auth.uid() returns uuid language sql stable as $$ select '${UID}'::uuid $$`]);
  try {
    sql(`update auth.users set created_at = now() where id = '${UID}'`); // T 이후 — 체험 OR 배제
    sql(`delete from public.entitlements where user_id = '${UID}'`);
    sql(`delete from public.msgr_org_members where user_id = '${UID}'`);
    sql(`delete from public.msgr_org_entitlements where org_id = '${ORG}'`);
    sql(`delete from public.msgr_orgs where id = '${ORG}'`);
    sql(`insert into public.msgr_orgs (id) values ('${ORG}')`);
    sql(`insert into public.msgr_org_entitlements (org_id, paid_until) values ('${ORG}', now() + interval '10 days')`);
    sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${UID}', 'member')`);
    assert.equal(sql('select public.is_pro()'), 't', '결제 중인 조직의 non-guest 멤버는 pro');
    sql(`update public.msgr_org_members set role = 'guest' where org_id = '${ORG}' and user_id = '${UID}'`);
    assert.equal(sql('select public.is_pro()'), 'f', 'guest는 조직 결제로 pro가 되지 않는다');
    sql(`update public.msgr_org_members set role = 'member', removed_at = now() where org_id = '${ORG}' and user_id = '${UID}'`);
    assert.equal(sql('select public.is_pro()'), 'f', '탈퇴(removed_at)한 멤버는 제외');
    sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}' and user_id = '${UID}'`);
    sql(`update public.msgr_org_entitlements set paid_until = now() - interval '1 day' where org_id = '${ORG}'`);
    assert.equal(sql('select public.is_pro()'), 'f', 'paid_until이 지난 조직은 더 이상 자격을 주지 않는다(plan 텍스트와 무관)');
  } finally {
    psqlRaw(['-c', `create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid'`]);
    psqlRaw(['-A', '-t', '-c', `update auth.users set created_at = now() where id = '${UID}'`]);
    psqlRaw(['-A', '-t', '-c', `delete from public.msgr_org_members where user_id = '${UID}'`]);
    psqlRaw(['-A', '-t', '-c', `delete from public.msgr_org_entitlements where org_id = '${ORG}'`]);
    psqlRaw(['-A', '-t', '-c', `delete from public.msgr_orgs where id = '${ORG}'`]);
  }
});

test('R4: purge_after 경계 — pro=null, T 이후 가입자·만료된 체험=T+30일, ends_at 경과=ends_at+30일', { skip }, () => {
  try {
    sql(`delete from public.entitlements where user_id = '${UID}'`);
    // pro(granted) → null
    sql(`insert into public.entitlements (user_id, plan, granted) values ('${UID}', 'free', true)`);
    assert.equal(sql(`select public.purge_after('${UID}') is null`), 't', 'Pro는 삭제 예정일이 없다');
    // T 이후 가입 + 결제 이력 없음 → 해당 없음 → T+30일
    sql(`update public.entitlements set granted = false where user_id = '${UID}'`);
    sql(`update auth.users set created_at = now() where id = '${UID}'`);
    assert.equal(sql(`select public.purge_after('${UID}') = '${T}'::timestamptz + interval '30 days'`), 't',
      'T 이후 가입자(체험도 결제도 없음)는 T+30일 — "해당 없으면 T"');
    // T 이전 가입 + 체험 이미 만료(트라이얼 종료가 T보다 이전) → greatest(T, 만료시각)=T → T+30일
    sql(`update auth.users set created_at = '${T}'::timestamptz - interval '20 days' where id = '${UID}'`);
    assert.equal(sql(`select public.purge_after('${UID}') = '${T}'::timestamptz + interval '30 days'`), 't',
      '체험 종료가 T보다 과거면 greatest(T, 종료시각)=T');
    // ends_at이 T보다 뒤(그리고 지금은 이미 지남) → greatest(T, ends_at)=ends_at → ends_at+30일
    sql(`update public.entitlements set ends_at = '${T}'::timestamptz + interval '1 millisecond' where user_id = '${UID}'`);
    assert.equal(sql(`select public.purge_after('${UID}') = ('${T}'::timestamptz + interval '1 millisecond' + interval '30 days')`), 't',
      'ends_at이 T보다 늦고 이미 지났으면 그 시각+30일(체험 종료보다 늦은 값을 쓴다)');
  } finally {
    psqlRaw(['-A', '-t', '-c', `update auth.users set created_at = now() where id = '${UID}'`]);
    psqlRaw(['-A', '-t', '-c', `delete from public.entitlements where user_id = '${UID}'`]);
  }
});
