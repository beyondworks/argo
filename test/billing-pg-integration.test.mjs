// apply_ls_event 실행 검증(분리 검수 F6) — SQL 논리를 **실제 Postgres**에 적용해 돌린다.
// 경계표는 test/helpers/ls-apply-cases.mjs(단일 정본)를 JS 거울 테스트와 공유한다.
// ARGO_PG_TEST_URL 미설정이면 전부 skip — CI/일반 `npm test`를 깨지 않는다.
// 실행: `npm run test:pg` (scripts/billing-pg-drill.sh — initdb 기반 임시 인스턴스, Docker 불필요)
// 또는 supabase start 후 ARGO_PG_TEST_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APPLY_CASES, T_OLD, T_NEW } from './helpers/ls-apply-cases.mjs';
import { psqlSpawn } from './helpers/pg.mjs';
import { loadLsWebhook } from './helpers/ls-webhook-edge.mjs';

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
    -- Supabase는 public의 새 함수에 anon·authenticated 실행권을 기본으로 준다 — 같게 걸어야 마이그레이션의
    -- "revoke ... from anon, authenticated" 줄이 실제로 효과가 있는지 아래 권한 테스트가 가려낸다(없으면 지워도 초록).
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    -- created_at: is_pro(trial_14d·ends_at)의 language sql 본문이 CREATE 시점에 파싱된다 — 없으면 적용 자체가 실패
    -- email·email_confirmed_at: ls_user_by_email(20261003231000)이 같은 이유로 필요하다(Supabase auth.users와 같은 이름·타입)
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text, email_confirmed_at timestamptz);
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
  psql(['-f', mig('20261003231000_ls_user_by_email.sql')]);
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

// 검수 #753 H1: my_plan(p_uid)는 "sub 클레임이 없으면 서비스 경로"로 보고 남의 플랜·삭제 예정일을 돌려줬다 —
// 경계는 클레임 부재가 아니라 역할(service_role)로 판정한다. 역할 클레임이 service_role일 때만 p_uid를 쓴다.
test('my_plan 권한: authenticated인데 sub가 없으면 남의 uid를 조회하지 못한다, service_role만 p_uid 사용', { skip }, () => {
  psql(['-c', `create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid'`]);
  sql(`delete from public.entitlements where user_id = '${UID}'`);
  sql(`insert into public.entitlements (user_id, plan, granted) values ('${UID}', 'pro', true)`);
  try {
    const asRole = (role) => psql(['-A', '-t', '-c', `set role ${role}; select set_config('request.jwt.claims', '{"role":"${role}"}', false); select public.my_plan('${UID}'::uuid)->>'plan'`]).trim().split('\n').pop();
    const r = psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('request.jwt.claims', '{"role":"authenticated"}', false); select public.my_plan('${UID}'::uuid)`]);
    assert.notEqual(r.status, 0, 'sub 없는 authenticated가 남의 uid를 넘기면 거부된다');
    assert.match(r.stderr, /my_plan_forbidden/);
    assert.equal(asRole('service_role'), 'pro', '서비스 롤은 넘긴 uid의 판정을 받는다(서버 /api/me/billing 경로)');
  } finally { sql(`delete from public.entitlements where user_id = '${UID}'`); }
});

// ── 레몬스퀴지 웹훅 이메일 연결(20261003231000, 2026-10-03) ──
// 랜딩 결제 링크에는 custom user_id가 없다. 운영 수신자(ls-webhook)가 400으로 끝나 실결제 2건이 Pro에 연결되지 않았던 사고의 수정.
// 이 블록 전용 계정 — 위 UID와 겹치지 않는다. 구독 번호는 'LS-'로 시작한다(after()가 이 값으로 정리한다).
const ACC = {
  buyer: 'c1000000-0000-4000-8000-000000000001',      // buyer@example.test, 인증됨
  other: 'c1000000-0000-4000-8000-000000000002',      // other@example.test, 인증됨 — 이미 구독을 가진 다른 계정
  unverified: 'c1000000-0000-4000-8000-000000000003', // unverified@example.test, 인증 안 됨
  twinA: 'c1000000-0000-4000-8000-000000000004',      // Twin@example.test, 인증됨
  twinB: 'c1000000-0000-4000-8000-000000000005',      // twin@example.test, 인증됨 — 대소문자만 다른 두 계정
  granted: 'c1000000-0000-4000-8000-000000000006',    // granted@example.test, 운영자 부여 Pro
  byId: 'c1000000-0000-4000-8000-000000000007',       // user_id 경로 — 결제 이메일과 계정 이메일이 다르다
  buyerUnv: 'c1000000-0000-4000-8000-000000000008',   // BUYER@example.test, 인증 안 됨 — buyer와 같은 주소의 미인증 계정
  manual: 'c1000000-0000-4000-8000-000000000009',     // manual@example.test — 결제 이메일과 달라 운영자가 손으로 연결한 계정
  manual2: 'c1000000-0000-4000-8000-00000000000a',    // manual2@example.test — 같은 경우, 결제 이메일이 다른 인증 계정(buyer)과 맞는다
  dupA: 'c1000000-0000-4000-8000-00000000000b',       // dupa@example.test ┐ 같은 구독이 두 계정에 연결된 비정상 상태
  dupB: 'c1000000-0000-4000-8000-00000000000c',       // dupb@example.test ┘
  victim: 'c1000000-0000-4000-8000-00000000000d',     // victim@example.test — 유효한 구독을 가진 사람(남이 이 이메일로 결제)
  switcher: 'c1000000-0000-4000-8000-00000000000e',   // switcher@example.test — 새 구독으로 갈아탄 사람(옛 구독 이벤트가 늦게 온다)
  lapsed: 'c1000000-0000-4000-8000-00000000000f',     // lapsed@example.test — 만료된 옛 구독(plan free)만 있는 사람
  lapsed2: 'c1000000-0000-4000-8000-000000000010',    // lapsed2@example.test — 해지 기간이 끝난 옛 구독(plan pro, ends_at 지남)만 있는 사람
};
function seedAccounts() {
  sql(`insert into auth.users (id, email, email_confirmed_at) values
    ('${ACC.buyer}', 'buyer@example.test', now()), ('${ACC.other}', 'other@example.test', now()),
    ('${ACC.unverified}', 'unverified@example.test', null), ('${ACC.twinA}', 'Twin@example.test', now()),
    ('${ACC.twinB}', 'twin@example.test', now()), ('${ACC.granted}', 'granted@example.test', now()),
    ('${ACC.byId}', 'byid@example.test', now()), ('${ACC.buyerUnv}', 'BUYER@example.test', null),
    ('${ACC.manual}', 'manual@example.test', now()), ('${ACC.manual2}', 'manual2@example.test', now()),
    ('${ACC.dupA}', 'dupa@example.test', now()), ('${ACC.dupB}', 'dupb@example.test', now()),
    ('${ACC.victim}', 'victim@example.test', now()), ('${ACC.switcher}', 'switcher@example.test', now()),
    ('${ACC.lapsed}', 'lapsed@example.test', now()), ('${ACC.lapsed2}', 'lapsed2@example.test', now())
    on conflict (id) do nothing`);
}
/** 운영자가 손으로 연결한 것과 같은 모양 — 정본 apply_ls_event를 직접 부른다(2026-10-03 두 건과 같은 방식). */
const linkByHand = (uid, sub, at) => sql(`select public.apply_ls_event('${uid}'::uuid, 'pro', '${sub}', '7001', 'active', '${at}'::timestamptz, null, null)`);
const byEmail = (e) => sql(`select coalesce(public.ls_user_by_email(${e === null ? 'null' : `'${e}'`})::text, 'NULL')`);
const ent = (uid) => sql(`select coalesce((select plan || '|' || ls_subscription_id || '|' || ls_status from public.entitlements where user_id = '${uid}'), 'none')`);
const unmatchedOf = (sub) => sql(`select coalesce(string_agg(reason || '|' || user_email, ',' order by reason), 'none') from public.billing_unmatched where ls_subscription_id = '${sub}'`);
const setEnt = (uid, cols) => {
  const names = Object.keys(cols);
  sql(`insert into public.entitlements (user_id, ${names.join(', ')}) values ('${uid}', ${names.map((k) => lit(cols[k])).join(', ')})
       on conflict (user_id) do update set ${names.map((k) => `${k} = excluded.${k}`).join(', ')}`);
};

after(() => {
  if (!DB) return;
  const ids = Object.values(ACC).map((id) => `'${id}'`).join(', ');
  psqlRaw(['-c', `delete from public.billing_unmatched where ls_subscription_id like 'LS-%'; delete from auth.users where id in (${ids})`]); // entitlements는 FK cascade
});

test('ls_user_by_email: 인증된 같은 이메일 계정이 정확히 하나일 때만 id — 인증 안 됨·대소문자만 다른 두 계정·없음·빈 값은 null', { skip }, () => {
  seedAccounts();
  assert.equal(byEmail('buyer@example.test'), ACC.buyer, '정확히 하나(같은 주소의 미인증 계정 BUYER@는 세지 않는다)');
  assert.equal(byEmail('  BUYER@Example.Test  '), ACC.buyer, '앞뒤 공백·대소문자 무시');
  assert.equal(byEmail('unverified@example.test'), 'NULL', '인증 안 된 계정만 있으면 연결하지 않는다');
  assert.equal(byEmail('twin@example.test'), 'NULL', '대소문자만 다른 두 인증 계정 — 누구 결제인지 정할 수 없다');
  assert.equal(byEmail('nobody@example.test'), 'NULL', '없음');
  for (const blank of ['', '   ', null]) assert.equal(byEmail(blank), 'NULL', `빈 값 ${JSON.stringify(blank)}`);
});

test('ls_user_by_email 권한: anon·authenticated·PUBLIC은 실행 불가(이메일로 계정 존재를 알아내는 통로), service_role만 실행', { skip }, () => {
  seedAccounts();
  for (const role of ['anon', 'authenticated']) {
    const r = psqlRaw(['-c', `set role ${role}; select public.ls_user_by_email('buyer@example.test')`]);
    assert.notEqual(r.status, 0, `${role}이 실행됨 — 계정 조회 통로가 열렸다`);
    assert.match(r.stderr, /permission denied/i, role);
  }
  assert.equal(sql(`select exists (select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.ls_user_by_email(text)'::regprocedure and a.grantee = 0::oid and a.privilege_type = 'EXECUTE')`), 'f', 'PUBLIC 실행권이 남아 있다');
  assert.equal(psql(['-A', '-t', '-c', `set role service_role; select public.ls_user_by_email('buyer@example.test')`]).trim(), ACC.buyer);
});

// 엣지 수신자 → 실제 SQL. 진입점 index.ts를 node vm에서 실행하고(test/helpers/ls-webhook-edge.mjs), 함수가 쓰는 supabase-js 호출
// 네 가지(rpc·select().eq().neq().limit()·upsert)를 Postgres 문장으로 바꿔 끼운다(PostgREST 대신). RPC는 service_role로 실행해
// 실행 권한·인자 이름까지 운영과 같은 조건으로 본다. 표 조회·기록은 슈퍼유저로(운영의 서비스 롤처럼 RLS를 거치지 않는다).
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`이름이 아니다: ${s}`); return s; };
const qlit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
function pgSb() {
  const run = (q) => {
    const r = psqlRaw(['-A', '-t', '-c', q]);
    return r.status === 0 ? { out: r.stdout.trim(), error: null } : { out: '', error: { message: r.stderr.trim() } };
  };
  return {
    async rpc(fn, args) {
      const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${qlit(v)}`).join(', ');
      const { out, error } = run(`set role service_role; select coalesce(to_json(public.${ident(fn)}(${named})), 'null'::json)`);
      return error ? { data: null, error } : { data: JSON.parse(out), error: null };
    },
    from(table) {
      return {
        select(cols) {
          const where = [];
          const q = {
            eq(c, v) { where.push(`${ident(c)} = ${qlit(v)}`); return q; },
            neq(c, v) { where.push(`${ident(c)} <> ${qlit(v)}`); return q; },
            async limit(n) {
              const list = String(cols).split(',').map((c) => ident(c.trim())).join(', '); // 'a, b, c' — PostgREST select 목록과 같은 모양
              const { out, error } = run(`select coalesce(json_agg(t), '[]'::json) from (select ${list} from public.${ident(table)}
                where ${where.join(' and ') || 'true'} limit ${Number(n)}) t`);
              return error ? { data: null, error } : { data: JSON.parse(out), error: null };
            },
          };
          return q;
        },
        async upsert(row, opts) {
          if (!opts?.ignoreDuplicates) throw new Error('엣지 함수는 ignoreDuplicates upsert만 쓴다 — 다른 모양이면 이 가짜를 넓힌다');
          const cols = Object.keys(row).map(ident);
          const conflict = String(opts.onConflict).split(',').map((c) => ident(c.trim())).join(', ');
          const { error } = run(`insert into public.${ident(table)} (${cols.join(', ')}) values (${cols.map((c) => qlit(row[c])).join(', ')})
            on conflict (${conflict}) do nothing`);
          return { error };
        },
      };
    },
  };
}
const lsEvent = ({ name = 'subscription_created', userId, sub, email, status = 'active', updatedAt = '2026-10-03T12:24:00Z', endsAt = null }) => ({
  meta: { event_name: name, ...(userId ? { custom_data: { user_id: userId } } : {}) },
  data: { id: sub, attributes: { status, customer_id: 7001, user_email: email, updated_at: updatedAt, ends_at: endsAt, test_mode: false, urls: { customer_portal: null } } },
});
const deliver = (payload) => loadLsWebhook({ sb: pgSb() }).post(payload);

test('엣지→SQL: user_id 없는 결제가 인증된 한 계정의 이메일과 맞으면 그 계정이 Pro — 재전송해도 같다', { skip }, async () => {
  seedAccounts();
  for (let i = 0; i < 2; i++) { // 두 번째 = LS 재시도
    const r = await deliver(lsEvent({ sub: 'LS-E1', email: '  Buyer@Example.TEST ' }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'active' });
  }
  assert.equal(ent(ACC.buyer), 'pro|LS-E1|active');
  assert.equal(sql(`select public.is_pro_for('${ACC.buyer}')`), 't', '앱의 Pro 판정까지');
  assert.equal(ent(ACC.buyerUnv), 'none', '같은 주소의 미인증 계정은 건드리지 않는다');
  assert.equal(unmatchedOf('LS-E1'), 'none');
});

test('엣지→SQL: 계정을 못 찾으면(없음·인증 안 됨·대소문자 쌍) 연결 없이 billing_unmatched no-user 한 행, 200', { skip }, async () => {
  seedAccounts();
  for (const [sub, email, acct] of [['LS-NONE', 'nobody@example.test', null], ['LS-UNV', 'unverified@example.test', ACC.unverified], ['LS-TWIN', 'twin@example.test', ACC.twinA]]) {
    for (let i = 0; i < 2; i++) { // 재시도해도 기록은 한 행(같은 구독·사유)
      const r = await deliver(lsEvent({ sub, email }));
      assert.equal(r.status, 200, sub);
      assert.deepEqual(r.json, { ok: true, unmatched: 'no-user' }, sub);
    }
    assert.equal(unmatchedOf(sub), `no-user|${email}`, sub);
    if (acct) assert.equal(ent(acct), 'none', `${sub}: 연결하지 않았다`);
  }
  assert.equal(ent(ACC.twinB), 'none');
});

test('엣지→SQL: user_id 경로 — 같은 구독이 이미 다른 계정에 있으면 적용하지 않고 duplicate-attribution, 200', { skip }, async () => {
  seedAccounts();
  setEnt(ACC.other, { plan: 'pro', ls_subscription_id: 'LS-DUP', ls_status: 'active' });
  for (let i = 0; i < 2; i++) { // 재시도해도 기록은 한 행
    const r = await deliver(lsEvent({ sub: 'LS-DUP', userId: ACC.twinB, email: 'buyer@example.test' }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, unmatched: 'duplicate-attribution' });
  }
  assert.equal(ent(ACC.twinB), 'none', 'user_id 계정에 적용하지 않았다');
  assert.equal(ent(ACC.other), 'pro|LS-DUP|active', '원래 계정은 그대로');
  assert.equal(unmatchedOf('LS-DUP'), 'duplicate-attribution|buyer@example.test', '같은 구독·사유는 한 행');
});

test('엣지→SQL: user_id 없음 + 그 구독이 두 계정에 연결(비정상) → 어느 쪽에도 적용하지 않고 duplicate-attribution, 200', { skip }, async () => {
  seedAccounts();
  setEnt(ACC.dupA, { plan: 'pro', ls_subscription_id: 'LS-DUP2', ls_status: 'active' });
  setEnt(ACC.dupB, { plan: 'pro', ls_subscription_id: 'LS-DUP2', ls_status: 'active' });
  const r = await deliver(lsEvent({ name: 'subscription_expired', sub: 'LS-DUP2', email: 'dupa@example.test', status: 'expired' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, unmatched: 'duplicate-attribution' });
  assert.equal(ent(ACC.dupA), 'pro|LS-DUP2|active', '이메일이 맞는 계정에도 적용하지 않았다');
  assert.equal(ent(ACC.dupB), 'pro|LS-DUP2|active');
  assert.equal(unmatchedOf('LS-DUP2'), 'duplicate-attribution|dupa@example.test');
});

// 2026-10-03 추가 규칙: user_id가 없으면 이메일보다 먼저 그 구독 번호에 이미 연결된 계정. 9/27 건처럼 결제 이메일 ≠ 계정
// 이메일이라 운영자가 apply_ls_event로 손으로 연결한 구독은, 이 규칙이 없으면 해지·만료가 no-user 기록으로만 끝나 Pro가 남는다.
test('엣지→SQL: user_id 없음 + 손으로 연결한 구독 + 결제 이메일이 어떤 계정과도 안 맞음 → 해지·만료가 그 계정에 반영', { skip }, async () => {
  seedAccounts();
  linkByHand(ACC.manual, 'LS-M1', '2026-09-27T08:56:00Z');
  const cancel = await deliver(lsEvent({ name: 'subscription_cancelled', sub: 'LS-M1', email: 'payer-only@pay.example', status: 'cancelled',
    updatedAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-27T08:56:00Z' }));
  assert.equal(cancel.status, 200);
  assert.deepEqual(cancel.json, { ok: true, plan: 'pro', status: 'cancelled' });
  assert.equal(ent(ACC.manual), 'pro|LS-M1|cancelled', '해지 예약 — 말일까지 pro');
  assert.equal(sql(`select ends_at = '2026-10-27T08:56:00Z'::timestamptz from public.entitlements where user_id = '${ACC.manual}'`), 't', 'ends_at 기록');
  const expire = await deliver(lsEvent({ name: 'subscription_expired', sub: 'LS-M1', email: 'payer-only@pay.example', status: 'expired',
    updatedAt: '2026-10-27T09:00:00Z', endsAt: '2026-10-27T08:56:00Z' }));
  assert.deepEqual(expire.json, { ok: true, plan: 'free', status: 'expired' });
  assert.equal(ent(ACC.manual), 'free|LS-M1|expired', '만료 — free');
  assert.equal(sql(`select public.is_pro_for('${ACC.manual}')`), 'f', '해지한 뒤 Pro가 남지 않는다');
  assert.equal(unmatchedOf('LS-M1'), 'none', '미연결로 적지 않는다');
});

test('엣지→SQL: user_id 없음 + 구독이 A에 연결 + 결제 이메일은 인증된 다른 계정 B와 맞음 → A에 적용, B에 붙이지 않는다', { skip }, async () => {
  seedAccounts();
  linkByHand(ACC.manual2, 'LS-M2', '2026-09-27T08:56:00Z');
  const buyerBefore = ent(ACC.buyer);
  const r = await deliver(lsEvent({ name: 'subscription_updated', sub: 'LS-M2', email: 'buyer@example.test', status: 'past_due', updatedAt: '2026-10-27T09:00:00Z' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'past_due' });
  assert.equal(ent(ACC.manual2), 'pro|LS-M2|past_due', 'A(연결된 계정)에 반영');
  assert.equal(ent(ACC.buyer), buyerBefore, 'B(이메일 계정)는 그대로');
  assert.equal(sql(`select count(*) from public.entitlements where ls_subscription_id = 'LS-M2'`), '1', '구독은 여전히 한 계정에만');
  assert.equal(unmatchedOf('LS-M2'), 'none');
});

test('엣지→SQL: user_id가 있으면 결제 이메일과 상관없이 그 계정 — 지금까지와 같다', { skip }, async () => {
  seedAccounts();
  const r = await deliver(lsEvent({ sub: 'LS-U1', userId: ACC.byId, email: 'someone-else@payment.test' }));
  assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'active' });
  assert.equal(ent(ACC.byId), 'pro|LS-U1|active');
});

test('엣지→SQL: 운영자 부여(granted) 계정은 구독 연결로 만료 이벤트가 와도 plan이 pro로 남고 결제 상태만 기록된다', { skip }, async () => {
  seedAccounts();
  setEnt(ACC.granted, { plan: 'pro', granted: true, ls_subscription_id: 'LS-G', ls_status: 'active' });
  // 결제 이메일은 어떤 계정과도 안 맞는다 — 구독 연결로만 이 계정을 찾는다
  const r = await deliver(lsEvent({ name: 'subscription_expired', sub: 'LS-G', email: 'payer-of-granted@pay.example', status: 'expired', endsAt: '2026-10-01T00:00:00Z' }));
  assert.equal(r.status, 200);
  assert.equal(ent(ACC.granted), 'pro|LS-G|expired');
  assert.equal(sql(`select public.is_pro_for('${ACC.granted}')`), 't');
});

test('엣지→SQL: 같은 구독의 과거 이벤트는 stale(구독 연결 경로), 같은 계정 다른 구독의 강등은 other_subscription(user_id 경로) — 둘 다 200이고 행은 그대로', { skip }, async () => {
  seedAccounts();
  setEnt(ACC.buyer, { plan: 'pro', ls_subscription_id: 'LS-S', ls_status: 'cancelled', ls_updated_at: T_NEW });
  const stale = await deliver(lsEvent({ name: 'subscription_updated', sub: 'LS-S', email: 'buyer@example.test', status: 'active', updatedAt: T_OLD }));
  assert.deepEqual(stale.json, { ok: true, stale: true });
  const other = await deliver(lsEvent({ name: 'subscription_expired', sub: 'LS-OLD', userId: ACC.buyer, email: 'buyer@example.test', status: 'expired' }));
  assert.deepEqual(other.json, { ok: true, otherSubscription: true });
  assert.equal(ent(ACC.buyer), 'pro|LS-S|cancelled', '과거·다른 구독 이벤트가 지금 상태를 덮지 않는다');
});

// 분리 검수 HIGH-1(2026-10-04): 이메일 경로가 그 계정의 현재 구독을 보지 않아, 다른 구독의 pro 쪽 이벤트(active·cancelled 등)가
// 유효한 구독 연결을 덮어썼다 — apply_ls_event의 구독 신원 가드는 plan='free' 이벤트만 막는다. 덮인 뒤 그 구독이 해지·만료되면
// 지금 쓰는 Pro가 꺼진다. 해지 이벤트의 ends_at은 과거 날짜 — 덮이면 그 자리에서 is_pro_for가 false가 된다(날짜와 무관하게 재현).
test('엣지→SQL: (a) 남이 피해자 이메일로 결제·해지·만료해도 피해자의 유효한 구독 연결은 그대로 — email-account-has-subscription 기록', { skip }, async () => {
  seedAccounts();
  linkByHand(ACC.victim, 'LS-VICTIM', '2026-09-01T00:00:00Z');
  for (const [name, status, endsAt, updatedAt] of [
    ['subscription_created', 'active', null, '2026-10-05T00:00:00Z'],
    ['subscription_cancelled', 'cancelled', '2026-01-01T00:00:00Z', '2026-10-05T01:00:00Z'],
    ['subscription_expired', 'expired', '2026-01-01T00:00:00Z', '2026-10-06T00:00:00Z'],
  ]) {
    const r = await deliver(lsEvent({ name, sub: 'LS-ATTACK', email: 'Victim@Example.test', status, updatedAt, endsAt }));
    assert.equal(r.status, 200, name);
    assert.deepEqual(r.json, { ok: true, unmatched: 'email-account-has-subscription' }, name);
    assert.equal(ent(ACC.victim), 'pro|LS-VICTIM|active', `${name}: 피해자 행은 그대로`);
    assert.equal(sql(`select public.is_pro_for('${ACC.victim}')`), 't', `${name}: 피해자는 계속 Pro`);
  }
  assert.equal(unmatchedOf('LS-ATTACK'), 'email-account-has-subscription|Victim@Example.test', '들어온 구독은 한 행으로 기록');
});

test('엣지→SQL: (b) 같은 사람의 옛 구독 해지·만료가 늦게 와도 새 구독 연결을 옛 것으로 바꾸지 않는다', { skip }, async () => {
  seedAccounts();
  linkByHand(ACC.switcher, 'LS-SW-NEW', '2026-10-01T00:00:00Z'); // 새 구독이 연결된 상태 — 옛 구독 번호는 행에 없다
  for (const [name, status, updatedAt] of [['subscription_cancelled', 'cancelled', '2026-10-05T00:00:00Z'], ['subscription_expired', 'expired', '2026-10-06T00:00:00Z']]) {
    const r = await deliver(lsEvent({ name, sub: 'LS-SW-OLD', email: 'switcher@example.test', status, updatedAt, endsAt: '2026-01-01T00:00:00Z' }));
    assert.equal(r.status, 200, name);
    assert.deepEqual(r.json, { ok: true, unmatched: 'email-account-has-subscription' }, name);
    assert.equal(ent(ACC.switcher), 'pro|LS-SW-NEW|active', `${name}: 새 구독 연결 그대로`);
    assert.equal(sql(`select public.is_pro_for('${ACC.switcher}')`), 't', `${name}: 계속 Pro`);
  }
  assert.equal(unmatchedOf('LS-SW-OLD'), 'email-account-has-subscription|switcher@example.test');
});

test('엣지→SQL: (c) 계정에 유효하지 않은 옛 행만 있으면(만료된 다른 구독·해지 기간이 끝난 구독) 이메일 경로가 지금처럼 새 구독을 연결한다', { skip }, async () => {
  seedAccounts();
  setEnt(ACC.lapsed, { plan: 'free', ls_subscription_id: 'LS-LAPSED-OLD', ls_status: 'expired', ends_at: '2026-01-01T00:00:00Z' });
  setEnt(ACC.lapsed2, { plan: 'pro', ls_subscription_id: 'LS-LAPSED2-OLD', ls_status: 'cancelled', ends_at: '2026-01-01T00:00:00Z' }); // expired가 아직 안 온 상태
  for (const [acct, email, sub] of [[ACC.lapsed, 'lapsed@example.test', 'LS-LAPSED-NEW'], [ACC.lapsed2, 'lapsed2@example.test', 'LS-LAPSED2-NEW']]) {
    assert.equal(sql(`select public.is_pro_for('${acct}')`), 'f', `${sub}: 시작 상태는 Pro 아님`);
    const r = await deliver(lsEvent({ sub, email }));
    assert.equal(r.status, 200, sub);
    assert.deepEqual(r.json, { ok: true, plan: 'pro', status: 'active' }, sub);
    assert.equal(ent(acct), `pro|${sub}|active`, sub);
    assert.equal(sql(`select public.is_pro_for('${acct}')`), 't', `${sub}: 새 구독으로 Pro`);
    assert.equal(unmatchedOf(sub), 'none', sub);
  }
});
