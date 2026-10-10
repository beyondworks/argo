// ls-reconcile — 하루 1회 결제 대사(2026-10-10). pg_cron(ls-reconcile-daily) → ls_reconcile_kick() → 여기.
// LS 구독 전체 목록과 entitlements(구독 번호가 있거나 plan='pro'인 행)를 대조해 불일치를 billing_unmatched에 적는다.
// 적힌 행은 트리거 billing_unmatched_notify가 운영자 기기로 푸시한다(msgr-push). 자동 수정은 하지 않는다 — 알림만.
// 같은 (구독, 사유)는 표의 고유 색인으로 1행 → 같은 불일치를 매일 다시 알리지 않는다. 불일치가 없으면 쓰기 0.
// 호출 인증: Authorization: Bearer LS_RECONCILE_SECRET(엣지 시크릿 = msgr_settings.ls_reconcile_secret). 시크릿이 없으면 500(닫힘).
// 엣지 시크릿: LS_RECONCILE_SECRET, LEMONSQUEEZY_API_KEY(ls-portal과 같은 이름), 선택 LEMONSQUEEZY_PRO_VARIANT_IDS·LS_ALLOW_TEST.
// 배포: verify_jwt 끔(pg_cron은 사용자 JWT가 없다 — 위 비밀로 막는다). 테스트: test/ls-reconcile.test.mjs(이 파일을 타입만 지워 vm에서 실행).
import { fetchAllSubscriptions, findDiscrepancies } from './core.js';

const enc = new TextEncoder();
async function sameSecret(a: string, b: string) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });
  const secret = Deno.env.get('LS_RECONCILE_SECRET');
  if (!secret) return new Response('reconcile not configured', { status: 500 });
  if (!(await sameSecret(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) return new Response('unauthorized', { status: 401 });
  const apiKey = Deno.env.get('LEMONSQUEEZY_API_KEY');
  if (!apiKey) return new Response('ls api key missing', { status: 500 });
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const rest = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`rest ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 || r.status === 201 ? null : r.json();
  };
  const variants = new Set(String(Deno.env.get('LEMONSQUEEZY_PRO_VARIANT_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  let subs;
  try { subs = await fetchAllSubscriptions(apiKey, fetch); } catch (e) {
    console.error(`[ls-reconcile] LS 조회 실패 — 이번 대사는 건너뛴다: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return new Response('ls api error', { status: 502 });
  }
  try {
    const ents = await rest('entitlements?select=user_id,plan,ends_at,ls_subscription_id,ls_customer_id,granted&or=(plan.eq.pro,ls_subscription_id.not.is.null)');
    const open = await rest('billing_unmatched?resolved_at=is.null&select=ls_subscription_id');
    const knownSubIds = new Set((open ?? []).map((o: { ls_subscription_id: string }) => String(o.ls_subscription_id ?? '')));
    const findings = findDiscrepancies({
      subs, ents: ents ?? [], knownSubIds, nowMs: Date.now(),
      allowTest: Deno.env.get('LS_ALLOW_TEST') === '1', allowedVariants: variants.size ? variants : null,
    });
    if (findings.length) {
      // 같은 (구독, 사유)가 이미 있으면(처리된 행 포함) 건너뛴다 — 행이 새로 생길 때만 알림이 나간다
      await rest('billing_unmatched?on_conflict=ls_subscription_id,reason', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(findings),
      });
    }
    // 로그에는 구독 번호와 사유만 — 이메일은 남기지 않는다
    console.log(`[ls-reconcile] LS 구독 ${subs.length}개 · 우리 쪽 행 ${(ents ?? []).length}개 · 불일치 ${findings.length}건`,
      findings.map((f) => `${f.ls_subscription_id}:${f.reason}`));
    return Response.json({ ok: true, subscriptions: subs.length, findings: findings.length });
  } catch (e) {
    console.error(`[ls-reconcile] DB 실패: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return new Response('db error', { status: 500 });
  }
});
