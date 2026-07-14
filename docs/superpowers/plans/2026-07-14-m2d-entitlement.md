# M-2d entitlement 스캐폴드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Free/Pro 경계의 뼈대를 심는다 — 계정별 plan(기본 free)과 동기화 게이트 지점. **강제는 꺼진 채**(전원 통과) 출하하고, M-4 결제 연동 때 켠다.

**Architecture:** `entitlements` 테이블(본인 행 select만 RLS — 쓰기는 서비스 롤 전용, M-4 결제 webhook이 쓴다). `src/entitlement.mjs`가 사이클마다 plan을 조회(부재/오류 = free), 게이트는 **세션 모드에만** 적용(셀프호스트·워커는 자기 인프라 — 항상 통과). `ARGO_ENFORCE_PLAN=1`일 때만 강제 — 기본 off.

**작업 디렉토리: `/Users/yoogeon/lean-projects/_worktrees/argo-m2d`** (메인 체크아웃은 랜딩 세션 사용 중 — 절대 금지). 브랜치 `feat/m2d-entitlement` (main = a5f7cca 기준).

## Global Constraints

- **강제 기본 off** — `ARGO_ENFORCE_PLAN !== '1'`이면 모든 모드 통과 (회귀 0)
- 게이트는 세션 모드 한정 (`loadSyncCreds()` truthy = 서비스 모드 → 무조건 통과)
- 게이트 차단은 **사이클 조기 return** — diff가 아예 안 돌므로 삭제 오인류 부작용 원천 없음
- plan 조회 실패/행 부재 = 'free' (fail-safe: 강제 off 기본이라 무해, 강제 on에서도 비파괴 — 다음 사이클 재시도)
- 시크릿 평문 금지, 커밋 prefix, 명시 add, sed -i 금지
- 검증: `npm test`, `node --check`, `npm run build`, DB는 `scripts/db-apply.sh`

---

### Task 1: `entitlements` 테이블 + RLS

**Files:**
- Create: `supabase/migrations/20260714150000_entitlements.sql`

- [ ] **Step 1: SQL**:

```sql
-- 요금제 경계(M-2d 스캐폴드) — plan은 서버(서비스 롤, M-4 결제 webhook)만 쓴다.
-- authenticated는 본인 행 select만: insert/update/delete 정책 없음 = 사용자가 자기 플랜을 못 바꾼다.
create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  updated_at timestamptz not null default now()
);
alter table public.entitlements enable row level security;

drop policy if exists entitlements_own_select on public.entitlements;
create policy entitlements_own_select on public.entitlements
  for select to authenticated using (user_id = (select auth.uid()));
```

- [ ] **Step 2: 적용 + 검증** — `scripts/db-apply.sh supabase/migrations/20260714150000_entitlements.sql` → CREATE TABLE/POLICY, 이어 pg_policies 조회로 정책 1개(SELECT)만 존재 확인 (INSERT/UPDATE/DELETE 정책 **부재**가 스펙)

- [ ] **Step 3: 커밋** — `git add supabase/migrations/20260714150000_entitlements.sql` → `feat(m2d): entitlements 테이블 — plan은 서버만 쓴다, 본인 행 select RLS`

---

### Task 2: entitlement 모듈 + sync 게이트 + M-2c 이월 하이진 2건

**Files:**
- Create: `src/entitlement.mjs`
- Modify: `src/sync.mjs` (cycle — owners 확정 후·syncCompany 루프 전 게이트), `src/accountkey.mjs` (무음 null 분기 warn), `app/auth/signout/route.js` (clearAccountKey 호출)
- Test: `test/core.test.mjs`

**Interfaces:**
- Produces: `fetchPlan(sb, ownerId) → Promise<'free'|'pro'>`, `syncEntitled(sb, ownerId) → Promise<{ok, plan}>` (ok = 강제 off || 서비스 모드 판단은 호출자 몫 아님 — 아래 참조), `lastPlan() → string|null` (syncStatus 노출용)

- [ ] **Step 1: 실패하는 테스트** — `test/core.test.mjs`에 추가:

```js
import { fetchPlan, syncEntitled, lastPlan } from '../src/entitlement.mjs';

function fakePlanSb(rows) {
  return { from: () => ({ select: () => ({ eq: (_c, uid) => ({ maybeSingle: async () => rows.error ? { data: null, error: rows.error } : { data: rows[uid] ? { plan: rows[uid] } : null, error: null } }) }) }) };
}

test('entitlement — 부재 free·존재 pro·오류 free·강제 게이트', async () => {
  assert.equal(await fetchPlan(fakePlanSb({ 'u-p': 'pro' }), 'u-p'), 'pro');
  assert.equal(await fetchPlan(fakePlanSb({}), 'u-x'), 'free');            // 행 부재
  assert.equal(await fetchPlan(fakePlanSb({ error: { message: 'boom' } }), 'u-x'), 'free'); // 오류 fail-safe
  assert.equal(await fetchPlan(fakePlanSb({}), null), 'free');             // 오너 없음
  const prev = process.env.ARGO_ENFORCE_PLAN;
  try {
    delete process.env.ARGO_ENFORCE_PLAN;                                  // 강제 off(기본)
    assert.deepEqual(await syncEntitled(fakePlanSb({}), 'u-x'), { ok: true, plan: 'free' });
    process.env.ARGO_ENFORCE_PLAN = '1';                                   // 강제 on
    assert.deepEqual(await syncEntitled(fakePlanSb({}), 'u-x'), { ok: false, plan: 'free' });
    assert.deepEqual(await syncEntitled(fakePlanSb({ 'u-p': 'pro' }), 'u-p'), { ok: true, plan: 'pro' });
    assert.equal(lastPlan(), 'pro');
  } finally {
    if (prev === undefined) delete process.env.ARGO_ENFORCE_PLAN; else process.env.ARGO_ENFORCE_PLAN = prev;
  }
});
```

- [ ] **Step 2: 실패 확인** — `npm test 2>&1 | tail -6` → module not found

- [ ] **Step 3: 구현** — `src/entitlement.mjs`:

```js
// 요금제 경계(M-2d 스캐폴드) — plan 조회와 동기화 게이트. 강제는 ARGO_ENFORCE_PLAN=1일 때만(기본 off,
// M-4 결제 연동에서 켠다). plan 쓰기는 서버(서비스 롤) 전용 — 이 모듈은 읽기만 한다.
// fail-safe: 행 부재·조회 실패 = 'free'. 강제 on에서도 게이트는 사이클 조기 return이라 비파괴(다음 사이클 재시도).
let last = null; // 관측용 — syncStatus 노출

export const lastPlan = () => last;

/** 계정 plan. 부재/오류/오너 없음 = 'free'. */
export async function fetchPlan(sb, ownerId) {
  if (!ownerId) { last = 'free'; return 'free'; }
  try {
    const { data, error } = await sb.from('entitlements').select('plan').eq('user_id', ownerId).maybeSingle();
    if (error) throw new Error(error.message);
    last = data?.plan === 'pro' ? 'pro' : 'free';
  } catch (e) {
    console.warn('[argo] 플랜 조회 실패 — free로 간주:', e.message);
    last = 'free';
  }
  return last;
}

/** 동기화 자격 게이트 — 강제 off면 항상 통과. */
export async function syncEntitled(sb, ownerId) {
  const plan = await fetchPlan(sb, ownerId);
  if (process.env.ARGO_ENFORCE_PLAN !== '1') return { ok: true, plan };
  return { ok: plan === 'pro', plan };
}
```

- [ ] **Step 4: sync.mjs 게이트** — import `import { syncEntitled, lastPlan } from './entitlement.mjs';`. `cycle()`에서 owners 확정(+owners[0] ensureAccountKey 폴백) **직후**, renewLease **전**에:

```js
  // 요금제 게이트(M-2d 스캐폴드) — 세션 모드에만. 서비스 모드(셀프호스트·워커)는 자기 인프라라 통과.
  // 강제는 ARGO_ENFORCE_PLAN=1일 때만(기본 off). 차단 = 조기 return — diff가 안 돌아 부작용 없음.
  if (!loadSyncCreds()) {
    const ent = await syncEntitled(client(), keyOwner || owners[0] || null);
    if (!ent.ok) { status.lastError = '멀티기기 동기화는 Pro 플랜입니다'; return; }
  }
```
그리고 `syncStatus()` 반환에 `plan: lastPlan(),` 추가 (관측용 — UI는 후속).

- [ ] **Step 5: 이월 하이진 2건** —
  1. `src/accountkey.mjs`: `if (!b64) return null;` 분기에 `console.warn('[argo] 계정 키 경합 재조회도 비어 있음 — 다음 사이클 재시도');` 추가
  2. `app/auth/signout/route.js`: `clearDeviceSession()` 호출 옆에 `clearAccountKey();` 추가 (import 포함 — 방어적 캐시 정리, 계정 전환 대비)

- [ ] **Step 6: 검증** — `node --check` 4파일 + `npm test 2>&1 | grep -E "^# (pass|fail)"` (24개) + `npm run build 2>&1 | grep -E "✓ Compiled|Failed|Error" | head -3`

- [ ] **Step 7: 커밋** — `git add src/entitlement.mjs src/sync.mjs src/accountkey.mjs app/auth/signout/route.js test/core.test.mjs` → `feat(m2d): 요금제 게이트 스캐폴드(강제 off) + M-2c 이월 하이진`

---

### Task 3: 검증·문서 [컨트롤러]

1. DB 정책 직접 재확인 (select 1개, 쓰기 정책 0개)
2. 강제 off 회귀: 테스트·빌드 (실서버 E2E는 강제가 off 기본이라 생략 — **M-4에서 강제 on E2E 의무** 문서화)
3. PRODUCT-SPEC: M-2d 취소선 + "강제는 M-4에서 on + E2E" 노트
4. 최종 리뷰(opus) → main 병합(임시 워크트리 — 랜딩 세션 체크아웃 불가침) → push

## 알려진 한계 (후속)

- 강제 on 경로의 실서버 E2E는 M-4에서 (스캐폴드는 단위 테스트만)
- plan 변경 UI·결제 연동 없음 (M-4), plan 캐시 없음(사이클당 1쿼리 — 무시 가능)
