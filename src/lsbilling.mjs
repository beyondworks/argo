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
    throw하지 않는다 — 웹훅은 이해 못 하는 이벤트에 200을 줘야 LS가 무한 재시도하지 않는다. */
export function mapSubscriptionEvent(eventName, payload) {
  if (typeof eventName !== 'string' || !eventName.startsWith('subscription_')) return null;
  // 인보이스류(subscription_payment_*)는 attributes 스키마가 달라 스킵 — 상태 전이는
  // subscription_updated(past_due 포함)가 항상 따라온다(LS 문서 계약).
  if (eventName.startsWith('subscription_payment_')) return null;
  const attrs = payload?.data?.attributes;
  const userId = payload?.meta?.custom_data?.user_id;
  if (!attrs || typeof attrs.status !== 'string') return null;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return { error: 'no-user' }; // 결제됐는데 귀속 불가 — 로그 대상
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
    portal_url: attrs?.urls?.customer_portal ?? null,
  };
}

/** 순서 역전 방어 — 새 이벤트가 저장분보다 과거면 스킵해야 하는가. */
export function isStaleEvent(incomingUpdatedAt, storedUpdatedAt) {
  const inc = Date.parse(incomingUpdatedAt ?? '');
  const cur = Date.parse(storedUpdatedAt ?? '');
  if (!Number.isFinite(inc) || !Number.isFinite(cur)) return false; // 비교 불가면 최신으로 취급(진행)
  return inc < cur;
}
