// B(페이월 서버측 이전) 클라이언트 pre-flight 회귀 테스트.
// 집행 권위는 서버 RLS(is_pro). 여기선 클라 UX 불변식: 조회 실패는 'free'가 아니라 null(미확인)이어야
// 하고, 강제 on에서도 '확정 free'만 차단하고 pro·미확인은 낙관 통과해야 한다(유료 사용자 오차단 방지).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlan, syncEntitled, proRowActive, reconcileUnneeded } from '../src/entitlement.mjs';

// mock supabase: from().select().eq().maybeSingle() → {data, error}
const mkSb = (result) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) });

test('fetchPlan: pro 행 → pro', async () => {
  assert.equal(await fetchPlan(mkSb({ data: { plan: 'pro' }, error: null }), 'u'), 'pro');
});
test('fetchPlan: free 행 → free', async () => {
  assert.equal(await fetchPlan(mkSb({ data: { plan: 'free' }, error: null }), 'u'), 'free');
});
test('fetchPlan: 무행 → free (RLS is_pro=false와 일치)', async () => {
  assert.equal(await fetchPlan(mkSb({ data: null, error: null }), 'u'), 'free');
});
test('fetchPlan: 조회 오류 → null (미확인, 낙관)', async () => {
  assert.equal(await fetchPlan(mkSb({ data: null, error: { message: 'boom' } }), 'u'), null);
});
test('fetchPlan: 오너 미상 → null (미확인)', async () => {
  assert.equal(await fetchPlan(mkSb({ data: null, error: null }), null), null);
});

test('syncEntitled: 강제 off면 항상 통과(기존 동작 불변)', async () => {
  const prev = process.env.ARGO_ENFORCE_PLAN; delete process.env.ARGO_ENFORCE_PLAN;
  try {
    assert.deepEqual(await syncEntitled(mkSb({ data: { plan: 'free' }, error: null }), 'u'), { ok: true, plan: 'free' });
  } finally { if (prev !== undefined) process.env.ARGO_ENFORCE_PLAN = prev; }
});
test('syncEntitled: 강제 on — 확정 free만 차단, pro·미확인은 낙관 통과', async () => {
  const prev = process.env.ARGO_ENFORCE_PLAN; process.env.ARGO_ENFORCE_PLAN = '1';
  try {
    assert.equal((await syncEntitled(mkSb({ data: { plan: 'free' }, error: null }), 'u')).ok, false, '확정 free 차단');
    assert.equal((await syncEntitled(mkSb({ data: { plan: 'pro' }, error: null }), 'u')).ok, true, 'pro 통과');
    assert.equal((await syncEntitled(mkSb({ data: null, error: { message: 'x' } }), 'u')).ok, true, '미확인(null) 낙관 통과 — 유료 오차단 방지');
  } finally { if (prev === undefined) delete process.env.ARGO_ENFORCE_PLAN; else process.env.ARGO_ENFORCE_PLAN = prev; }
});

/* ── 2주 무료 체험(2026-07-24: 멀티디바이스 2주 Free + Pro $16/월) — 서버 is_pro OR 조건과 대칭 ── */
const mkSbAuth = (result, user) => ({
  ...mkSb(result),
  auth: { getUser: async () => ({ data: { user } }) },
});
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

test('fetchPlan: 무행 + 가입 3일 → trial (체험 창)', async () => {
  assert.equal(await fetchPlan(mkSbAuth({ data: null, error: null }, { id: 'u', created_at: daysAgo(3) }), 'u'), 'trial');
});
test('fetchPlan: 무행 + 가입 20일 → free (체험 종료)', async () => {
  assert.equal(await fetchPlan(mkSbAuth({ data: null, error: null }, { id: 'u', created_at: daysAgo(20) }), 'u'), 'free');
});
test('fetchPlan: free 행이어도 가입 14일 이내면 trial (서버 OR와 대칭)', async () => {
  assert.equal(await fetchPlan(mkSbAuth({ data: { plan: 'free' }, error: null }, { id: 'u', created_at: daysAgo(1) }), 'u'), 'trial');
});
test('fetchPlan: 세션 사용자 ≠ 오너면 체험 판정 불가 → free', async () => {
  assert.equal(await fetchPlan(mkSbAuth({ data: null, error: null }, { id: 'other', created_at: daysAgo(1) }), 'u'), 'free');
});
test('fetchPlan: auth 미지원 클라(기존 mkSb) → free 관용 (기존 테스트 불변)', async () => {
  assert.equal(await fetchPlan(mkSb({ data: null, error: null }), 'u'), 'free');
});
test('syncEntitled: 강제 on에서 trial은 통과', async () => {
  const prev = process.env.ARGO_ENFORCE_PLAN; process.env.ARGO_ENFORCE_PLAN = '1';
  try {
    const r = await syncEntitled(mkSbAuth({ data: null, error: null }, { id: 'u', created_at: daysAgo(2) }), 'u');
    assert.deepEqual(r, { ok: true, plan: 'trial' });
  } finally { if (prev === undefined) delete process.env.ARGO_ENFORCE_PLAN; else process.env.ARGO_ENFORCE_PLAN = prev; }
});
test('fetchPlan: auth 일시 실패(error 반환) → null (미확인 낙관 — 검수 MEDIUM 반영)', async () => {
  const sb = { ...mkSb({ data: null, error: null }), auth: { getUser: async () => ({ data: { user: null }, error: { message: 'network' } }) } };
  assert.equal(await fetchPlan(sb, 'u'), null);
});

/* ── ends_at 만료 집행(전수리뷰 2026-07-30 #5) — 서버 is_pro(20260730050000)와 대칭 ── */
test('fetchPlan: pro 행 + ends_at 경과 → free (만료 웹훅 유실돼도 자격이 꺼진다)', async () => {
  assert.equal(await fetchPlan(mkSb({ data: { plan: 'pro', ends_at: daysAgo(1) }, error: null }), 'u'), 'free');
});
test('fetchPlan: pro 행 + ends_at 미래(해지 예약) → pro (그때까지 접근 유지가 LS 계약)', async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(await fetchPlan(mkSb({ data: { plan: 'pro', ends_at: future }, error: null }), 'u'), 'pro');
});
test('fetchPlan: pro 행 + ends_at null(활성·그랜드파더링) → pro (기존 동작 불변)', async () => {
  assert.equal(await fetchPlan(mkSb({ data: { plan: 'pro', ends_at: null }, error: null }), 'u'), 'pro');
});
test('fetchPlan: pro 행 + ends_at 파싱 불능 → pro (낙관 방향 — 유료 오차단 방지)', async () => {
  assert.equal(await fetchPlan(mkSb({ data: { plan: 'pro', ends_at: 'garbage' }, error: null }), 'u'), 'pro');
});
test('proRowActive: 대사 게이트 회귀 가드 — ends_at 경과 pro는 "유효 아님"이라 대사가 돈다', () => {
  // 분리 검수 HIGH: 게이트가 원시 plan==='pro'를 믿으면 재개 웹훅 유실 사용자(plan pro + ends_at 과거)의
  // 유일한 복구(유실 대사)가 영구히 꺼진다. 공유 술어가 false를 줘야 me/billing 게이트가 열린다.
  assert.equal(proRowActive({ plan: 'pro', ends_at: daysAgo(1) }), false, '만료 pro → 대사 재적격');
  assert.equal(proRowActive({ plan: 'pro', ends_at: null }), true, '활성 pro (대사 불요 판정은 reconcileUnneeded 소관)');
  assert.equal(proRowActive({ plan: 'pro', ends_at: new Date(Date.now() + 86_400_000).toISOString() }), true, '해지 예약(말일 전)');
  assert.equal(proRowActive({ plan: 'free' }), false);
  assert.equal(proRowActive(null), false);
});

test('reconcileUnneeded: 부여 Pro(구독 없는 pro)는 대사가 돌아야 한다 — 중복 청구 유인 차단', () => {
  // 분리 검수 2026-08-19 HIGH-1: 게이트가 proRowActive만 보면 그랜드파더링 44계정(plan=pro·
  // ends_at=null·구독 식별자 없음)은 대사가 영구히 꺼져, 결제 후 웹훅 1건만 유실돼도 hasSub가
  // 영영 안 붙는다 → 설정 카드가 **이미 낸 사람에게** 결제 버튼을 계속 보여준다.
  const granted = { plan: 'pro', ends_at: null, ls_subscription_id: null };
  assert.equal(proRowActive(granted), true, '자격은 유효 pro가 맞다(강등 금지)');
  assert.equal(reconcileUnneeded(granted), false, '그러나 대사는 돌아야 한다 — 잃어버린 결제 후보');

  // 구독이 붙은 정상 pro는 여전히 LS를 안 때린다(호출량 회귀 방지).
  assert.equal(reconcileUnneeded({ plan: 'pro', ends_at: null, ls_subscription_id: 'sub_1' }), true);
  // 만료 pro는 구독 유무와 무관하게 대사 적격(2026-07-30 HIGH가 잠근 방향 — 좁히기가 이걸 깨면 안 된다).
  assert.equal(reconcileUnneeded({ plan: 'pro', ends_at: daysAgo(1), ls_subscription_id: 'sub_1' }), false);
  assert.equal(reconcileUnneeded({ plan: 'free', ls_subscription_id: 'sub_1' }), false);
  assert.equal(reconcileUnneeded(null), false, '무행은 항상 대사 적격');
});
