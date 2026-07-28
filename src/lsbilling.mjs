// 레몬스퀴지 결제 → entitlements 환산(순수 로직) — 웹훅 라우트와 테스트가 공유한다.
//
// 돈의 UX 원칙(2026-07-28 유건 확정): 결제는 **클라우드(동기화·멀티디바이스)만** 잠근다.
// 로컬 사용은 플랜과 무관하게 항상 가능 — 집행 권위는 서버 RLS(is_pro)이고, 이 모듈은
// LS 구독 상태를 entitlements.plan('pro'|'free')으로 환산하는 단일 지점이다.
//
// 상태 매핑(LS subscription status → plan):
//  - on_trial / active            → pro (정상 구독)
//  - past_due                     → pro (유예 — LS 던닝이 재시도 중. 카드 만료 실수로 업무를 끊지 않는다.
//                                    던닝 소진 시 LS가 unpaid/expired로 내리며 그때 free)
//  - cancelled                    → pro (해지 예약 — ends_at까지 접근 유지가 LS 계약.
//                                    기간 종료 시 subscription_expired 이벤트가 free로 내린다)
//  - expired / unpaid / paused    → free (클라우드 동결 — 데이터는 지우지 않는다. 재구독 시 그대로 재개)
//
// 멱등·순서: 이벤트는 상태 스냅샷이라 재전송 replay는 무해(같은 값 upsert). 순서 역전만
// 방어한다 — attributes.updated_at이 저장된 ls_updated_at보다 과거면 스킵(웹훅 재시도가
// 최신 상태를 과거로 되돌리는 것 차단).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PRO_STATUSES = new Set(['on_trial', 'active', 'past_due', 'cancelled']);
export const FREE_STATUSES = new Set(['expired', 'unpaid', 'paused']);

/** X-Signature(HMAC-SHA256 hex of raw body) 검증 — 시크릿 미설정이면 무조건 false(fail-closed). */
export function verifyLsSignature(rawBody, signatureHeader, secret) {
  if (!secret || typeof signatureHeader !== 'string' || !signatureHeader.trim()) return false;
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signatureHeader.trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** subscription_* 이벤트를 entitlements 갱신안으로 환산. 처리 대상이 아니면 null(무시가 정답인 이벤트).
    throw하지 않는다 — 웹훅은 이해 못 하는 이벤트에 200을 줘야 LS가 무한 재시도하지 않는다.
    opts.allowedVariants: Set<string>|null — 설정돼 있으면 그 variant만 Pro(저가 티어·애드온이 전권을
    받는 것 차단, 재검수 M2). opts.allowTest: test_mode 결제 수용 여부(기본 거부 — 재검수 M3). */
export function mapSubscriptionEvent(eventName, payload, opts = {}) {
  if (typeof eventName !== 'string' || !eventName.startsWith('subscription_')) return null;
  // 인보이스류(subscription_payment_*)는 attributes 스키마가 달라 스킵 — 상태 전이는
  // subscription_updated(past_due 포함)가 항상 따라온다(LS 문서 계약).
  if (eventName.startsWith('subscription_payment_')) return null;
  const attrs = payload?.data?.attributes;
  const userId = payload?.meta?.custom_data?.user_id;
  if (!attrs || typeof attrs.status !== 'string') return null;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return { error: 'no-user' }; // 결제됐는데 귀속 불가 — 로그 대상
  if (attrs.test_mode && !opts.allowTest) return { error: 'test-mode' }; // 가짜 카드 결제로 실 Pro 부여 차단
  if (opts.allowedVariants?.size && !opts.allowedVariants.has(String(attrs.variant_id))) {
    return { error: `other-product:${attrs.variant_id}` }; // Pro 상품이 아닌 구매 — 전권 부여 금지
  }
  const status = attrs.status;
  const plan = PRO_STATUSES.has(status) ? 'pro' : FREE_STATUSES.has(status) ? 'free' : null;
  if (!plan) return { error: `unknown-status:${status}` }; // 새 상태가 생기면 조용히 오판하지 않고 드러낸다
  return {
    userId: userId.toLowerCase(),
    plan,
    ls_subscription_id: String(payload?.data?.id ?? ''),
    ls_customer_id: String(attrs.customer_id ?? ''),
    ls_status: status,
    ls_updated_at: attrs.updated_at ?? null,
    ends_at: attrs.ends_at ?? null,
    // ⚠ 스냅샷일 뿐이다 — LS 포털 URL은 발급 후 24시간 만료(서명 프리사인 링크, 재검수 HIGH).
    // UI는 이 값을 렌더하지 말 것 — 클릭 시점 발급 라우트(/api/me/billing/portal)를 쓴다.
    portal_url: attrs?.urls?.customer_portal ?? null,
  };
}

/** 구독 신원 가드(O1) — 다른 구독의 강등 이벤트가 현재 구독을 덮으면 안 된다.
    시나리오: 월간 해지(유예 pro) 후 연간 재구독 → 옛 월간의 expired가 나중에 도착해도
    free로 덮으면 돈 낸 연간 구독자가 클라우드를 잃는다. 승격(pro)은 신원 무관 허용.
    ⚠ 실집행 정본은 DB의 apply_ls_event(20260728113000 마이그레이션) WHERE 조건 — 이 함수는
    그 조건의 JS 거울(테스트로 계약을 잠그는 실행 가능한 스펙)이다. 변경 시 양쪽 동기 필수. */
export function isOtherSubscriptionDowngrade(mapped, stored) {
  return mapped?.plan === 'free'
    && !!stored?.ls_subscription_id
    && stored.ls_subscription_id !== mapped.ls_subscription_id;
}

/** 순서 역전 방어 — 새 이벤트가 저장분보다 과거면 스킵해야 하는가.
    ⚠ isOtherSubscriptionDowngrade와 마찬가지로 apply_ls_event WHERE 조건의 JS 거울. */
export function isStaleEvent(incomingUpdatedAt, storedUpdatedAt) {
  const inc = Date.parse(incomingUpdatedAt ?? '');
  const cur = Date.parse(storedUpdatedAt ?? '');
  if (!Number.isFinite(inc) || !Number.isFinite(cur)) return false; // 비교 불가면 최신으로 취급(진행)
  return inc < cur;
}

/** 웹훅·대사가 공유하는 게이트 옵션 — variant 허용목록(M2)·test_mode 수용(M3)을 env에서 한 곳으로. */
export function lsGateOpts(env = process.env) {
  const allowedVariants = new Set(String(env.LEMONSQUEEZY_PRO_VARIANT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return {
    allowedVariants: allowedVariants.size ? allowedVariants : null,
    allowTest: env.LEMONSQUEEZY_ALLOW_TEST === '1',
  };
}

/** [M1] 환산 결과를 entitlements에 원자 적용 — DB 함수 apply_ls_event 한 문장으로 순서 역전·
    구독 신원 가드를 행 잠금 안에서 판정+쓰기한다(select→JS비교→upsert의 동시 전달 race 제거).
    반환: 'applied' | 'stale' | 'other_subscription'. DB 오류는 throw(호출자가 5xx로 LS 재시도 유도). */
export async function applyLsEvent(sb, mapped) {
  const { data, error } = await sb.rpc('apply_ls_event', {
    p_user_id: mapped.userId,
    p_plan: mapped.plan,
    p_sub_id: mapped.ls_subscription_id,
    p_customer_id: mapped.ls_customer_id,
    p_status: mapped.ls_status,
    p_updated_at: mapped.ls_updated_at,
    p_ends_at: mapped.ends_at,
    p_portal_url: mapped.portal_url,
  });
  if (error) throw new Error(error.message);
  return data;
}

/** [M4] 귀속 실패 이벤트 → billing_unmatched 적재 행. 수동 귀속에 필요한 최소 식별자만
    (구독 id·customer id·결제 이메일·이벤트명·사유) — raw payload 전체는 PII 과잉이라 싣지 않는다. */
export function unmatchedRow(eventName, reason, payload) {
  const attrs = payload?.data?.attributes ?? {};
  return {
    event_name: String(eventName ?? ''),
    reason: String(reason ?? ''),
    ls_subscription_id: String(payload?.data?.id ?? ''),
    ls_customer_id: String(attrs.customer_id ?? ''),
    user_email: String(attrs.user_email ?? ''),
  };
}

/** [O2] 대사(reconcile) 후보 선별 — LS 구독 목록 API(data[])에서 Pro로 인정할 활성 구독을 고른다.
    웹훅과 같은 게이트(test_mode·variant 허용목록)를 통과한 PRO_STATUSES만. 복수면 updated_at 최신
    우선, 저장된 customer_id와 일치하는 게 있으면 그쪽 우선(이메일 동명 계정 오귀속 방어).
    복구 전용이라 free 방향 후보는 없다 — 강등은 웹훅(순서 가드 포함)의 몫. */
export function pickProSubscription(subs, opts = {}) {
  const { allowedVariants = null, allowTest = false, storedCustomerId = null } = opts;
  const ok = (Array.isArray(subs) ? subs : []).filter((s) => {
    const a = s?.attributes;
    if (!a || typeof a.status !== 'string' || !PRO_STATUSES.has(a.status)) return false;
    if (a.test_mode && !allowTest) return false;
    if (allowedVariants?.size && !allowedVariants.has(String(a.variant_id))) return false;
    return true;
  });
  if (!ok.length) return null;
  const ts = (s) => Date.parse(s.attributes.updated_at ?? '') || 0;
  ok.sort((x, y) => ts(y) - ts(x));
  const match = storedCustomerId
    ? ok.find((s) => String(s.attributes.customer_id ?? '') === String(storedCustomerId)) : null;
  const s = match ?? ok[0];
  const a = s.attributes;
  return {
    plan: 'pro',
    ls_subscription_id: String(s.id ?? ''),
    ls_customer_id: String(a.customer_id ?? ''),
    ls_status: a.status,
    ls_updated_at: a.updated_at ?? null,
    ends_at: a.ends_at ?? null,
    portal_url: a?.urls?.customer_portal ?? null, // 스냅샷 — UI 렌더 금지 계약은 동일
  };
}
