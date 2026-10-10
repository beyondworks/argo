// ls-reconcile — 하루 1회 결제 대사(2026-10-10). pg_cron(ls-reconcile-daily) → ls_reconcile_kick() → 여기.
// LS 구독 전체 목록과 entitlements(구독 번호가 있거나 plan='pro'인 행)를 대조해 불일치를 billing_unmatched에 적는다.
// 적힌 행은 트리거 billing_unmatched_notify가 운영자 기기로 푸시한다(msgr-push). 자동 수정은 하지 않는다 — 알림만.
// 같은 (구독, 사유)의 미해결 행이 있으면 다시 적지 않는다 → 같은 불일치를 매일 다시 알리지 않는다. 처리된 불일치가 다시 생기면 그 행을 다시 연다.
// 불일치가 없으면 쓰기 0.
// 호출 인증: Authorization: Bearer LS_RECONCILE_SECRET(엣지 시크릿 = msgr_settings.ls_reconcile_secret). 시크릿이 없으면 500(닫힘).
// 엣지 시크릿: LS_RECONCILE_SECRET, LEMONSQUEEZY_API_KEY(ls-portal과 같은 이름), 선택 LEMONSQUEEZY_PRO_VARIANT_IDS·LS_ALLOW_TEST.
// 배포: verify_jwt 끔(pg_cron은 사용자 JWT가 없다 — 위 비밀로 막는다). 테스트: test/ls-reconcile.test.mjs(이 파일을 타입만 지워 vm에서 실행).
import { fetchAllSubscriptions, findDiscrepancies, implausiblyEmpty } from './core.js';

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
  // 전부 읽기 — PostgREST는 한 번에 max_rows(기본 1000)까지만 준다. 빈 쪽이 올 때까지 offset을 받은 행 수만큼 민다(분리 검수 LOW-2).
  const restAll = async (path: string) => {
    const all: unknown[] = [];
    for (let page = 0; page < 200; page++) {
      const rows = await rest(`${path}&offset=${all.length}`);
      if (!Array.isArray(rows) || !rows.length) return all;
      all.push(...rows);
    }
    throw new Error(`rest ${path.split('?')[0]} 행이 너무 많다`);
  };
  const variants = new Set(String(Deno.env.get('LEMONSQUEEZY_PRO_VARIANT_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean));

  let subs;
  try { subs = await fetchAllSubscriptions(apiKey, fetch); } catch (e) {
    console.error(`[ls-reconcile] LS 조회 실패 — 이번 대사는 건너뛴다: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return new Response('ls api error', { status: 502 });
  }
  try {
    const ents = await restAll('entitlements?select=user_id,plan,ends_at,ls_subscription_id,ls_customer_id,granted&or=(plan.eq.pro,ls_subscription_id.not.is.null)&order=user_id');
    const openRows = await restAll('billing_unmatched?resolved_at=is.null&select=ls_subscription_id,reason&order=id');
    if (implausiblyEmpty(subs, ents, Date.now())) {
      console.error('[ls-reconcile] LS 구독 목록이 비었는데 우리 쪽 결제 Pro가 있다 — API 키·스토어를 확인할 때까지 대사를 멈춘다(쓰기 없음)');
      return new Response('ls list empty', { status: 502 });
    }
    const findings = findDiscrepancies({
      subs, ents, openRows, nowMs: Date.now(),
      allowTest: Deno.env.get('LS_ALLOW_TEST') === '1', allowedVariants: variants.size ? variants : null,
    });
    if (findings.length) {
      // 같은 (구독, 사유)의 미해결 행은 findDiscrepancies가 이미 뺐다 — 여기서 충돌하는 것은 처리된 행뿐이다.
      // 처리된 불일치가 다시 생기면 그 행을 다시 연다(resolved_at·notified_at을 비움 → 트리거가 다시 알린다, 분리 검수 MEDIUM-2).
      await rest('billing_unmatched?on_conflict=ls_subscription_id,reason', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(findings.map((f) => ({ ...f, resolved_at: null, notified_at: null }))),
      });
    }
    // 로그에는 구독 번호와 사유만 — 이메일은 남기지 않는다
    console.log(`[ls-reconcile] LS 구독 ${subs.length}개 · 우리 쪽 행 ${ents.length}개 · 불일치 ${findings.length}건`,
      findings.map((f) => `${f.ls_subscription_id}:${f.reason}`));
    return Response.json({ ok: true, subscriptions: subs.length, findings: findings.length });
  } catch (e) {
    console.error(`[ls-reconcile] DB 실패: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return new Response('db error', { status: 500 });
  }
});
