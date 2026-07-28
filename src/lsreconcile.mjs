// [O2] 유실 대사(reconcile) — LS 웹훅 재시도는 3회·약 155초가 전부라, 그 창을 놓치면
// "결제됐는데 pro가 영원히 안 붙는" 상태가 된다. /api/me/billing 접근 시(사용자가 설정
// 화면을 여는 바로 그 고통의 순간) entitlements가 free/무행이면 LS API에 활성 구독이 있는지
// 대조해 복구한다. 쓰기는 웹훅과 같은 원자 경로(apply_ls_event)라 뒤늦게 도착한 웹훅과
// 경합해도 순서 가드가 지켜진다.
//
// 쿨다운(분리 검수 F7): 프로세스 메모리가 아니라 entitlements 두 컬럼으로 인스턴스 간 공유한다
// (마이그레이션 20260728150000). 오류와 부정 결과를 구분한다 —
//  - ls_reconciled_at(시도, 10분): 시도 전 선점 기록. LS 장애 연타 방지 + 장애 후 10분 재시도.
//  - ls_reconcile_empty_at(구독 없음 확정, 24시간): 부정 결과 캐싱. 무료 사용자를 10분마다
//    영구 조회하던 호출량을 끊는다. 웹훅이 정상이면 24시간 지연은 강등·승격에 무영향(대사는 최후 방어).
import { applyLsEvent, pickProSubscription, unmatchedRow } from './lsbilling.mjs';

export const COOLDOWN_MS = 10 * 60_000; // 대사 시도 간격 — 설정 화면 재방문마다 LS API를 때리지 않는다
export const EMPTY_COOLDOWN_MS = 24 * 60 * 60_000; // "활성 구독 없음" 확정 후 재확인 간격

/** 행 기반 사전 판정(무쿼리) — 라우트가 이미 읽은 entitlements 행으로 대사 시도 가치를 계산한다.
    통과해도 선점은 claimReconcile(원자)이 한다 — 이 함수는 쿨다운 중 헛 DB 쓰기를 없애는 필터.
    무행(null)은 항상 due — 웹훅이 전부 유실된 결제자일 수 있다. */
export function reconcileDueFromRow(row, nowMs = Date.now()) {
  if (!row) return true;
  const tried = Date.parse(row.ls_reconciled_at ?? '');
  if (Number.isFinite(tried) && nowMs - tried < COOLDOWN_MS) return false;
  const empty = Date.parse(row.ls_reconcile_empty_at ?? '');
  if (Number.isFinite(empty) && nowMs - empty < EMPTY_COOLDOWN_MS) return false;
  return true;
}

/** 쿨다운 선점(인스턴스 간 원자) — 조건부 update 한 문장이 판정+기록을 겸한다: 행이 갱신되면
    이 요청이 선점한 것. 0행이면 (a) 쿨다운 중이거나 (b) 행이 없다 — (b)는 ignoreDuplicates
    insert로 선점(동시 생성은 PK 충돌로 한쪽만 통과, plan은 default 'free'라 자격에 무영향).
    실패(LS 장애)해도 쿨다운이 소모되게 **시도 전에** 기록한다. */
export async function claimReconcile(sb, userId, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  const triedCut = new Date(nowMs - COOLDOWN_MS).toISOString();
  const emptyCut = new Date(nowMs - EMPTY_COOLDOWN_MS).toISOString();
  const { data, error } = await sb.from('entitlements')
    .update({ ls_reconciled_at: now })
    .eq('user_id', userId)
    .or(`ls_reconciled_at.is.null,ls_reconciled_at.lte.${triedCut}`)
    .or(`ls_reconcile_empty_at.is.null,ls_reconcile_empty_at.lte.${emptyCut}`)
    .select('user_id');
  if (error) throw new Error(error.message);
  if (data?.length) return true;
  const { data: ins, error: insErr } = await sb.from('entitlements')
    .upsert({ user_id: userId, ls_reconciled_at: now }, { onConflict: 'user_id', ignoreDuplicates: true })
    .select('user_id');
  if (insErr) throw new Error(insErr.message);
  return !!ins?.length;
}

/** 부정 결과 확정 기록 — "활성 구독 없음"이 확인됐을 때만 부른다(LS 오류는 throw로 빠져 여기
    오지 않는다). 실패는 무해 — 기록이 안 되면 10분 뒤 한 번 더 확인할 뿐이라 삼키고 로그만. */
export async function markReconcileEmpty(sb, userId, nowMs = Date.now()) {
  const { error } = await sb.from('entitlements')
    .update({ ls_reconcile_empty_at: new Date(nowMs).toISOString() })
    .eq('user_id', userId);
  if (error) console.error('[argo] billing 대사: 부정 결과 기록 실패(무해 — 10분 뒤 재확인):', error.message);
}

/** LS 구독 목록 조회 — 체크아웃 때 우리가 지정한 이메일(checkout[email]=user.email)로 필터.
    (subscriptions API에 customer_id 필터가 없어 이메일 필터 + customer_id 후처리 대조를 쓴다) */
export async function fetchLsSubscriptions(email, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(
    `https://api.lemonsqueezy.com/v1/subscriptions?filter[user_email]=${encodeURIComponent(email)}&page[size]=50`,
    {
      headers: { Accept: 'application/vnd.api+json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000),
    },
  );
  if (!res.ok) throw new Error(`LS API ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

/** 대사 1회 실행 — 활성 Pro 구독이 있으면 원자 적용. 반환: { result, picked } 또는 null(할 일 없음).
    복구 전용(승격 방향만): entitlements를 free로 내리는 일은 하지 않는다 — 강등은 웹훅의 몫.
    중복 귀속 가드(분리 검수 F2): 같은 LS 구독이 이미 **다른** user_id에 붙어 있으면 적용하지
    않는다 — 조인 키가 체크아웃 이메일이라, 공용 메일함 등으로 1구독이 N계정에 pro를 주는 것
    (게다가 강등 웹훅은 원 결제자만 향해 나머지는 영구 pro)을 막는다. 감지 건은 billing_unmatched에
    duplicate-attribution으로 적재해 수동 판단 대상으로 남긴다. */
export async function reconcileEntitlement({
  sb, userId, email, storedCustomerId = null, apiKey,
  allowedVariants = null, allowTest = false, fetchImpl = fetch, nowMs = Date.now(),
}) {
  if (!apiKey || !userId || !email) return null;
  if (!(await claimReconcile(sb, userId, nowMs))) return null;
  const subs = await fetchLsSubscriptions(email, apiKey, fetchImpl);
  const picked = pickProSubscription(subs, { allowedVariants, allowTest, storedCustomerId });
  if (!picked) {
    await markReconcileEmpty(sb, userId, nowMs); // 부정 결과 캐싱 — 24시간은 다시 묻지 않는다
    return null;
  }
  const { data: dupes, error: dupErr } = await sb.from('entitlements')
    .select('user_id').eq('ls_subscription_id', picked.ls_subscription_id).neq('user_id', userId).limit(1);
  if (dupErr) throw new Error(dupErr.message);
  if (dupes?.length) {
    console.error(`[argo] billing 대사 중단: 구독 ${picked.ls_subscription_id}이 이미 다른 계정에 귀속 — duplicate-attribution 적재(수동 판단 대상)`);
    const row = { ...unmatchedRow('reconcile', 'duplicate-attribution', {}), ls_subscription_id: picked.ls_subscription_id, ls_customer_id: picked.ls_customer_id, user_email: email };
    const { error: insErr } = await sb.from('billing_unmatched')
      .upsert(row, { onConflict: 'ls_subscription_id,reason', ignoreDuplicates: true });
    if (insErr) console.error('[argo] billing 대사 duplicate-attribution 적재 실패:', insErr.message);
    // 자동 복구 불가 확정(수동 판단 대상) — 부정 결과와 동급으로 장기 쿨다운. 안 그러면 이
    // 사용자는 10분마다 영구히 LS를 때린다(귀속은 어차피 운영자 판단 + 이후 웹훅이 처리).
    await markReconcileEmpty(sb, userId, nowMs);
    return null;
  }
  const result = await applyLsEvent(sb, { ...picked, userId });
  if (result !== 'applied') {
    // 대사가 막히면 자동 복구 경로가 더 없다 — 무음으로 두지 않고 수동 확인 대상으로 크게 남긴다.
    console.error(`[argo] billing 대사 [수동 확인 필요] 적용 차단 user=${userId} sub=${picked.ls_subscription_id} → ${result}`);
  } else {
    console.log(`[argo] billing 대사: 유실 복구 user=${userId} sub=${picked.ls_subscription_id} → applied`);
  }
  return { result, picked };
}
