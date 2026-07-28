// apply_ls_event 적용 판정 경계표 — **단일 정본**. 두 소비자가 같은 표를 대조한다:
//  ① test/billing-hardening.test.mjs — JS 거울(shouldApplyLsEvent)이 applied 여부를 재현하는지
//  ② test/billing-pg-integration.test.mjs — 실제 Postgres의 apply_ls_event가 판정 문자열과
//     최종 행 상태까지 일치하는지 (분리 검수 F6 — SQL 논리의 실행 검증)
// 표를 고치면 두 테스트가 함께 움직인다 — SQL과 JS 거울이 갈라지면 어느 한쪽이 반드시 깨진다.
//
// stored: null = 행 없음. ts는 ls_updated_at, sub는 ls_subscription_id.
// expect: 'applied' | 'stale' | 'other_subscription' (DB 함수의 반환 문자열).
export const T_OLD = '2026-07-01T00:00:00Z';
export const T_NEW = '2026-07-05T00:00:00Z';
export const T_NEWER = '2026-07-09T00:00:00Z';

export const APPLY_CASES = [
  {
    name: '신규 행 — 가드 대상 없음, insert',
    stored: null,
    incoming: { plan: 'pro', sub: 'S1', ts: T_OLD, status: 'active' },
    expect: 'applied',
  },
  {
    name: '같은 구독 과거 이벤트 — 순서 역전 스킵(stale)',
    stored: { plan: 'pro', sub: 'S1', ts: T_NEW, status: 'active' },
    incoming: { plan: 'pro', sub: 'S1', ts: T_OLD, status: 'cancelled' },
    expect: 'stale',
  },
  {
    name: '같은 구독 동률 — 마지막 커밋 승(진행)',
    stored: { plan: 'pro', sub: 'S1', ts: T_NEW, status: 'active' },
    incoming: { plan: 'pro', sub: 'S1', ts: T_NEW, status: 'cancelled' },
    expect: 'applied',
  },
  {
    name: 'incoming ls_updated_at null — 비교 불가는 진행',
    stored: { plan: 'pro', sub: 'S1', ts: T_NEW, status: 'active' },
    incoming: { plan: 'pro', sub: 'S1', ts: null, status: 'cancelled' },
    expect: 'applied',
  },
  {
    name: 'stored ls_updated_at null — 비교 불가는 진행',
    stored: { plan: 'pro', sub: 'S1', ts: null, status: 'active' },
    incoming: { plan: 'pro', sub: 'S1', ts: T_OLD, status: 'cancelled' },
    expect: 'applied',
  },
  {
    name: 'F1 코너 — 다른 구독 승격은 저장분이 최신이어도 applied(대사 복구 경로)',
    stored: { plan: 'free', sub: 'S1', ts: T_NEW, status: 'expired' },
    incoming: { plan: 'pro', sub: 'S2', ts: T_OLD, status: 'active' },
    expect: 'applied',
  },
  {
    name: '다른 구독 강등 — 신원 가드(O1) 차단',
    stored: { plan: 'pro', sub: 'S2', ts: T_NEW, status: 'active' },
    incoming: { plan: 'free', sub: 'S1', ts: T_NEWER, status: 'expired' },
    expect: 'other_subscription',
  },
  {
    name: '저장 sub id 빈 문자열(그랜드파더링) — 강등도 진행',
    stored: { plan: 'pro', sub: '', ts: T_NEW, status: 'active' },
    incoming: { plan: 'free', sub: 'S1', ts: T_OLD, status: 'expired' },
    expect: 'applied',
  },
];

/** 경계표 항목 → shouldApplyLsEvent 인자 (JS 거울 소비자용). */
export const toMirrorArgs = (c) => ({
  mapped: { plan: c.incoming.plan, ls_subscription_id: c.incoming.sub, ls_updated_at: c.incoming.ts },
  stored: c.stored ? { ls_subscription_id: c.stored.sub, ls_updated_at: c.stored.ts } : null,
});
