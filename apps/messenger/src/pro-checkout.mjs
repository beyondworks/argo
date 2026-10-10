// 메신저 Pro 결제(2026-10-11 유건 지시: "프로는 아르고 앱 프로 결제랑 통합, 메신저에서도 결제 가능하게. 모바일에서도").
// 같은 계정이면 본체·랜딩·메신저 어디서 결제해도 같은 Pro다 — 같은 LS 상품, 같은 custom user_id 귀속(ls-webhook → entitlements 한 행),
// 같은 판정(서버 my_plan RPC). 이 파일은 새 판정·새 가격·새 주소 조립을 만들지 않고 본체 것을 그대로 가져온다:
//   · 주소 조립 = 본체 설정 버튼의 checkoutUrl(app/c/[ws]/settings/checkout-link.mjs) — 같은 함수
//   · 상품 주소(월간·연간) = 랜딩 결제의 LS_MONTHLY·LS_YEARLY(landing/lib/checkout.js) — 앱 릴리스 빌드에 주입되는 것과 같은 상품
//   · 판정 = effectivePlanOf(src/entitlement.mjs) — 본체 /api/me/billing이 my_plan 응답을 읽는 함수
//   · 가격 문구 = 본체 사전의 billing.upgradeMonthly·billing.upgradeYearly(화면에서 ta로 읽는다 — 숫자를 여기 다시 쓰지 않는다)
// 순수 모듈(React·Supabase 없음) — test/pro-checkout.test.mjs가 잠근다.
import { checkoutUrl } from '../../../app/c/[ws]/settings/checkout-link.mjs';
import { LS_MONTHLY, LS_YEARLY } from '../../../landing/lib/checkout.js';
import { effectivePlanOf, proRowActive } from '../../../src/entitlement.mjs';

export const PLAN_BASE = { monthly: LS_MONTHLY, yearly: LS_YEARLY };
/** LS 고객 포털(이메일 로그인) — ls-portal 엣지 함수가 서명 링크를 못 줄 때(CORS 반영 전 배포본·네트워크)의 대체 길. 상품 주소와 같은 가게 */
export const LS_BILLING = `${new URL(LS_MONTHLY).origin}/billing`;

/** my_plan 응답 → 'pro' | 'trial' | 'free' | null(모름). 본체와 같은 함수 */
export const planOf = (myPlan) => effectivePlanOf(myPlan);

/** 플랫폼별 구매 경로 — 붙일 자리는 이 함수 하나다.
 *  'web'  = LS 체크아웃을 시스템 브라우저로(맥·윈도우·Android·메신저 웹)
 *  'none' = iOS. App Store 심사 지침 3.1.1: 앱 안 디지털 구독은 Apple 인앱 결제여야 하고 외부 결제 링크·버튼은 지역에 따라 금지된다.
 *           iOS 인앱 결제는 만들지 않기로 확정(유건 2026-10-11) — 업그레이드 버튼·구독 관리 링크·외부 결제 안내를 모두 숨기고
 *           "이 계정이 Pro면 자동으로 적용됩니다"만 보인다. 나중에 구매 경로가 생기면 여기서 다른 값을 돌려주는 것으로 붙인다. */
export function purchaseChannel({ ios = false } = {}) {
  return ios ? 'none' : 'web';
}

/** 업그레이드 체크아웃 주소. 이미 Pro이거나 판정을 모르면 null — 이중 구독 방지(#934: 이미 Pro면 체크아웃을 만들지 않는다).
 *  plan은 서버 판정(my_plan)만 받는다. 'trial'은 결제할 수 있다(본체 설정과 같다). user = 로그인 계정 { id, email } */
export function proCheckoutUrl({ plan, user, cadence = 'monthly' }) {
  if (plan !== 'free' && plan !== 'trial') return null;
  return checkoutUrl(PLAN_BASE[cadence === 'yearly' ? 'yearly' : 'monthly'], user);
}

/** 플랜 카드가 그릴 것(순수). row = entitlements 본인 행(RLS) 또는 null. kind:
 *  'loading' | 'unavailable' | 'free' | 'trial' | 'pro-sub'(구독 중) | 'pro-cancelled'(해지 예약) | 'pro-pastdue'(결제 실패 유예) | 'pro-granted'(구독 없이 받은 Pro)
 *  buy = 업그레이드 버튼(구매 경로가 web이고 Pro가 아닐 때만), portal = 구독 관리 링크(web이고 구독이 있을 때만) */
export function planView({ plan, row = null, channel = 'web', loading = false, now = Date.now() }) {
  if (loading) return { kind: 'loading', buy: false, portal: false };
  if (plan == null) return { kind: 'unavailable', buy: false, portal: false };
  const web = channel === 'web';
  if (plan !== 'pro') return { kind: plan === 'trial' ? 'trial' : 'free', buy: web, portal: false };
  const hasSub = !!row?.ls_subscription_id;
  const endsAt = row?.ends_at && Date.parse(row.ends_at) > now ? row.ends_at : null;
  if (!hasSub) return { kind: 'pro-granted', buy: false, portal: false, endsAt };
  if (row?.ls_status === 'past_due') return { kind: 'pro-pastdue', buy: false, portal: web };
  if (endsAt && proRowActive(row)) return { kind: 'pro-cancelled', buy: false, portal: web, endsAt };
  return { kind: 'pro-sub', buy: false, portal: web };
}

// ── 결제 뒤 재확인(DB 위생 — 2026-09-23 규칙) ──
// 웹훅이 entitlements에 반영되기까지 몇 초가 걸릴 수 있다. 앱으로 돌아온 순간(포커스·화면 복귀) 한 번 읽고, Pro가 아니면 짧게 몇 번 더 읽는다.
// 한 라운드 = my_plan 최대 5회(0·3·5·10·20초 뒤, 총 38초). 라운드는 '업그레이드를 누른 뒤 15분 안에 앱으로 돌아올 때'만 시작하고
// 이미 돌고 있으면 새로 시작하지 않는다. 무한 폴링 없음 — 업그레이드를 누르지 않은 사용자는 카드를 열 때 1회 읽기뿐이다.
export const RECHECK_DELAYS_MS = [0, 3000, 5000, 10000, 20000];
export const ARM_MS = 15 * 60 * 1000;

/** 앱 복귀 때 재확인 라운드를 시작하는가(순수). armedAt = 업그레이드를 누른 시각(없으면 null) */
export function shouldRecheckOnReturn({ armedAt, now = Date.now(), running = false }) {
  return !!armedAt && !running && now - armedAt >= 0 && now - armedAt < ARM_MS;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** readPlan()을 정해진 간격으로 최대 delays.length회 부른다. 'pro'면 바로 멈춘다. alive()가 false면(화면을 떠남) 더 읽지 않는다.
 *  반환 { plan: 마지막으로 읽은 판정(못 읽으면 null), tries: 실제로 읽은 횟수 } */
export async function recheckUntilPro(readPlan, { delays = RECHECK_DELAYS_MS, sleep = sleepMs, alive = () => true } = {}) {
  let plan = null; let tries = 0;
  for (const d of delays) {
    if (d > 0) await sleep(d);
    if (!alive()) break;
    tries += 1;
    plan = await Promise.resolve().then(readPlan).catch(() => null);
    if (plan === 'pro') break;
  }
  return { plan, tries };
}

/** 'Pro로 바꾸면 풀리는' 서버 오류 코드 → 그 안내의 사전 키. 안내 토스트를 플랜 카드로 잇는 판정의 유일한 목록이다.
 *  msgr_pro_required = 무료 계정 에이전트 메신저 연결(#941), msgr_room_limit = 대화방 4명 한도(개인 공간 2026-09-30).
 *  msgr_seat_limit(조직 좌석)은 넣지 않는다 — 개인 Pro로 풀리지 않는다. 새 무료 한도 코드는 여기에 한 줄(코드: 사전 키) 더한다. */
export const PRO_UPSELL = {
  msgr_pro_required: 'err.proRequired',
  msgr_room_limit: 'room.limit',
};

/** 오류 토스트가 'Pro로 바꾸면 풀리는' 안내인가. setErr에는 원문 코드가 오기도, 이미 번역한 문구(friendlyErr)가 오기도 해서 둘 다 본다.
 *  t = 메신저 사전(키 → 지금 언어 문구). 없으면 코드만 본다 */
export function isProUpsell(err, t = null) {
  const s = String(err ?? '');
  if (!s) return false;
  for (const [code, key] of Object.entries(PRO_UPSELL)) {
    if (new RegExp(`\\b${code}\\b`).test(s)) return true;
    const text = t ? t(key) : '';
    if (text && text !== key && s.includes(text)) return true;
  }
  return false;
}
