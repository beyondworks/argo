// [O2] 유실 대사(reconcile) — LS 웹훅 재시도는 3회·약 155초가 전부라, 그 창을 놓치면
// "결제됐는데 pro가 영원히 안 붙는" 상태가 된다. /api/me/billing 접근 시(사용자가 설정
// 화면을 여는 바로 그 고통의 순간) entitlements가 free/무행이면 LS API에 활성 구독이 있는지
// 대조해 복구한다. 쓰기는 웹훅과 같은 원자 경로(apply_ls_event)라 뒤늦게 도착한 웹훅과
// 경합해도 순서 가드가 지켜진다.
import { applyLsEvent, pickProSubscription } from './lsbilling.mjs';

const COOLDOWN_MS = 10 * 60_000; // 설정 화면 재방문마다 LS API를 때리지 않는다(과금·레이트리밋 예의)
const lastTry = new Map(); // userId → 마지막 시도 ms (베스트에포트 — 프로세스 로컬)

/** 쿨다운 게이트 — 통과 시 즉시 시도 시각을 선점 기록한다(실패해도 쿨다운 소모: LS 장애 때 연타 방지). */
export function reconcileDue(userId, nowMs = Date.now(), cooldownMs = COOLDOWN_MS) {
  const prev = lastTry.get(userId) ?? 0;
  if (nowMs - prev < cooldownMs) return false;
  if (lastTry.size > 10_000) lastTry.clear(); // 메모리 상한 — 쿨다운은 베스트에포트라 리셋 무해
  lastTry.set(userId, nowMs);
  return true;
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
    복구 전용(승격 방향만): entitlements를 free로 내리는 일은 하지 않는다 — 강등은 웹훅의 몫. */
export async function reconcileEntitlement({
  sb, userId, email, storedCustomerId = null, apiKey,
  allowedVariants = null, allowTest = false, fetchImpl = fetch, nowMs = Date.now(),
}) {
  if (!apiKey || !userId || !email) return null;
  if (!reconcileDue(userId, nowMs)) return null;
  const subs = await fetchLsSubscriptions(email, apiKey, fetchImpl);
  const picked = pickProSubscription(subs, { allowedVariants, allowTest, storedCustomerId });
  if (!picked) return null;
  const result = await applyLsEvent(sb, { ...picked, userId });
  console.log(`[argo] billing 대사: 유실 복구 시도 user=${userId} sub=${picked.ls_subscription_id} → ${result}`);
  return { result, picked };
}
