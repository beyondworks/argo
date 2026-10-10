// ls-reconcile 순수 부분 — LS 구독 목록 조회와 entitlements 대조. Deno와 Node 양쪽에서 돈다 → test/ls-reconcile.test.mjs
// 판정 기준은 결제 웹훅과 같다: LS 상태 active·on_trial·past_due·cancelled(말일까지)는 Pro, 시험 결제는 기본 제외,
// variant 허용 목록이 설정돼 있으면 그 variant만. 우리 쪽 Pro = entitlements plan='pro'이고 기한이 남았거나(ends_at 없음 포함)
// 운영자 부여(granted). 구독 번호가 빈 행(그랜드파더링·운영자 부여)은 LS와 대조하지 않는다.

export const PRO_STATUSES = new Set(['active', 'on_trial', 'past_due', 'cancelled']);
export const MAX_PAGES = 50; // 100개 × 50쪽 = 5,000 구독 — 넘으면 멈추고 알린다(무한 반복 방지)

/** LS 구독 하나가 지금 Pro로 인정되는가 */
export function lsCountsAsPro(sub, { nowMs = Date.now(), allowTest = false, allowedVariants = null } = {}) {
  const a = sub?.attributes;
  if (!a || !PRO_STATUSES.has(String(a.status))) return false;
  if (a.test_mode && !allowTest) return false;
  if (allowedVariants?.size && !allowedVariants.has(String(a.variant_id))) return false;
  // cancelled는 말일(ends_at)까지만 — LS가 expired로 바꾸기 전 짧은 틈을 Pro로 세지 않는다
  if (a.status === 'cancelled' && a.ends_at && Date.parse(a.ends_at) <= nowMs) return false;
  return true;
}

/** entitlements 행이 결제로 Pro인가(is_pro의 결제 조건과 같다) */
export function entPaidPro(row, nowMs = Date.now()) {
  if (row?.plan !== 'pro') return false;
  return row.ends_at == null || Date.parse(row.ends_at) > nowMs;
}

/**
 * 불일치 찾기 — 자동 수정은 하지 않는다. 반환: billing_unmatched에 넣을 행 목록.
 *  · reconcile-ls-pro-not-linked: LS는 Pro로 인정하는 구독인데, 그 구독 번호에 연결된 우리 쪽 Pro 계정이 없다.
 *  · reconcile-pro-not-in-ls: 우리 쪽은 그 구독 번호로 결제 Pro인데(운영자 부여 제외), LS에 그 구독이 없거나 Pro가 아니다.
 * knownSubIds(아직 처리되지 않은 billing_unmatched 행의 구독 번호)는 건너뛴다 — 이미 알린 건이고, 결제 먼저·가입 나중
 * 자동 연결(PR #933 ls_link_late_signups)이 같은 구독의 다른 사유 행을 보고 멈추지 않게.
 */
export function findDiscrepancies({ subs = [], ents = [], knownSubIds = new Set(), nowMs = Date.now(), allowTest = false, allowedVariants = null }) {
  const opts = { nowMs, allowTest, allowedVariants };
  const byId = new Map(subs.map((s) => [String(s?.id ?? ''), s]));
  const entsBySub = new Map();
  for (const r of ents) {
    const sid = String(r?.ls_subscription_id ?? '');
    if (!sid) continue;
    if (!entsBySub.has(sid)) entsBySub.set(sid, []);
    entsBySub.get(sid).push(r);
  }
  const out = new Map(); // `${sub}|${reason}` → 행
  const add = (row) => { const k = `${row.ls_subscription_id}|${row.reason}`; if (!out.has(k)) out.set(k, row); };
  for (const s of subs) {
    const sid = String(s?.id ?? '');
    if (!sid || !lsCountsAsPro(s, opts)) continue;
    const rows = entsBySub.get(sid) ?? [];
    if (rows.some((r) => entPaidPro(r, nowMs) || r.granted === true)) continue;
    add({ event_name: 'reconcile-daily', reason: 'reconcile-ls-pro-not-linked', ls_subscription_id: sid,
      ls_customer_id: String(s.attributes?.customer_id ?? ''), user_email: String(s.attributes?.user_email ?? '') });
  }
  for (const r of ents) {
    const sid = String(r?.ls_subscription_id ?? '');
    if (!sid || r.granted === true || !entPaidPro(r, nowMs)) continue;
    const s = byId.get(sid);
    if (s && lsCountsAsPro(s, opts)) continue;
    add({ event_name: 'reconcile-daily', reason: 'reconcile-pro-not-in-ls', ls_subscription_id: sid,
      ls_customer_id: String(s?.attributes?.customer_id ?? r.ls_customer_id ?? ''), user_email: String(s?.attributes?.user_email ?? '') });
  }
  return [...out.values()].filter((row) => !knownSubIds.has(row.ls_subscription_id));
}

/** LS 구독 전체 목록 — 쪽마다 100개, links.next가 없을 때까지. 오류는 throw(호출부가 502로 끝내고 아무것도 쓰지 않는다). */
export async function fetchAllSubscriptions(apiKey, fetchImpl = fetch) {
  const all = [];
  let url = 'https://api.lemonsqueezy.com/v1/subscriptions?page[size]=100&page[number]=1';
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new Error(`LS 구독 목록이 ${MAX_PAGES}쪽을 넘었다 — 대사를 멈춘다`);
    if (!url.startsWith('https://api.lemonsqueezy.com/')) throw new Error('LS 다음 쪽 주소가 LS API 밖을 가리킨다');
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.api+json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`LS API ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.data)) throw new Error('LS API 응답에 data 배열이 없다');
    all.push(...body.data);
    url = typeof body?.links?.next === 'string' && body.links.next ? body.links.next : '';
  }
  return all;
}
