// B(페이월 서버측 이전) 클라이언트 pre-flight 회귀 테스트.
// 집행 권위는 서버 RLS(is_pro). 여기선 클라 UX 불변식: 조회 실패는 'free'가 아니라 null(미확인)이어야
// 하고, 강제 on에서도 '확정 free'만 차단하고 pro·미확인은 낙관 통과해야 한다(유료 사용자 오차단 방지).
//
// 2026-09-29 변경: fetchPlan은 더 이상 가입일+14일을 클라이언트에서 계산하지 않는다(14일 무료 체험
// 폐지 — R1). T(마이그레이션 20260929110000 적용 시각) 이전 가입자만 남은 체험이 있고, 그 판정은
// 서버(my_plan() RPC)만 안다. mock sb는 이제 `.rpc('my_plan')`을 흉내 낸다 — .from(entitlements) 직접
// 조회 모킹은 여기서 더 쓰지 않는다(core.test.mjs의 fakePlanSb도 같은 이유로 rpc 기반으로 바뀌었다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlan, syncEntitled, proRowActive, reconcileUnneeded } from '../src/entitlement.mjs';

// mock supabase: rpc('my_plan') → {data, error}. auth는 옵션(세션 신원 확인용, 없으면 건너뜀).
const mkSb = (plan, { authUser, authError } = {}) => ({
  rpc: async (name) => (name === 'my_plan' ? { data: { plan }, error: null } : { data: null, error: { message: `unknown rpc ${name}` } }),
  ...(authUser !== undefined || authError !== undefined
    ? { auth: { getUser: async () => ({ data: { user: authUser ?? null }, error: authError ?? null }) } }
    : {}),
});
const mkSbErr = (message) => ({ rpc: async () => ({ data: null, error: { message } }) });

test('fetchPlan: pro → pro', async () => {
  assert.equal(await fetchPlan(mkSb('pro'), 'u'), 'pro');
});
test('fetchPlan: free → free', async () => {
  assert.equal(await fetchPlan(mkSb('free'), 'u'), 'free');
});
test('fetchPlan: trial(T 이전 가입자의 남은 체험, 서버가 판정) → trial', async () => {
  assert.equal(await fetchPlan(mkSb('trial'), 'u'), 'trial');
});
test('fetchPlan: RPC가 예기치 않은 값을 주면 free로 관용(서버 계약 밖 — 안전한 기본값)', async () => {
  assert.equal(await fetchPlan(mkSb('weird'), 'u'), 'free');
});
test('fetchPlan: RPC 오류 → null (미확인, 낙관)', async () => {
  assert.equal(await fetchPlan(mkSbErr('boom'), 'u'), null);
});
test('fetchPlan: 오너 미상 → null (미확인)', async () => {
  assert.equal(await fetchPlan(mkSb('pro'), null), null);
});
test('fetchPlan: 세션 사용자 ≠ 오너면 free — 남의 판정을 오너 것으로 안 믿는다', async () => {
  assert.equal(await fetchPlan(mkSb('pro', { authUser: { id: 'other' } }), 'u'), 'free');
});
test('fetchPlan: auth 미지원 클라(서비스 모드) — getUser 자체가 없으면 확인을 건너뛰고 RPC를 믿는다', async () => {
  assert.equal(await fetchPlan(mkSb('pro'), 'u'), 'pro'); // mkSb('pro')는 auth 옵션 없음 → typeof sb.auth?.getUser !== 'function'
});
test('fetchPlan: auth.getUser 일시 실패(error) — 신원 확인을 건너뛰고 RPC 결과를 믿는다(fail-open)', async () => {
  const sb = mkSb('pro', { authUser: null, authError: { message: 'network' } });
  assert.equal(await fetchPlan(sb, 'u'), 'pro');
});

test('syncEntitled: 강제 off면 항상 통과(기존 동작 불변)', async () => {
  const prev = process.env.ARGO_ENFORCE_PLAN; delete process.env.ARGO_ENFORCE_PLAN;
  try {
    assert.deepEqual(await syncEntitled(mkSb('free'), 'u'), { ok: true, plan: 'free' });
  } finally { if (prev !== undefined) process.env.ARGO_ENFORCE_PLAN = prev; }
});
test('syncEntitled: 강제 on — 확정 free만 차단, pro·trial·미확인은 낙관 통과', async () => {
  const prev = process.env.ARGO_ENFORCE_PLAN; process.env.ARGO_ENFORCE_PLAN = '1';
  try {
    assert.equal((await syncEntitled(mkSb('free'), 'u')).ok, false, '확정 free 차단');
    assert.equal((await syncEntitled(mkSb('pro'), 'u')).ok, true, 'pro 통과');
    assert.equal((await syncEntitled(mkSb('trial'), 'u')).ok, true, 'trial(T 이전 가입자 남은 체험) 통과');
    assert.equal((await syncEntitled(mkSbErr('x'), 'u')).ok, true, '미확인(null) 낙관 통과 — 유료 오차단 방지');
  } finally { if (prev === undefined) delete process.env.ARGO_ENFORCE_PLAN; else process.env.ARGO_ENFORCE_PLAN = prev; }
});

/* ── ends_at 만료·부여 Pro는 여전히 proRowActive·reconcileUnneeded(entitlement.mjs) 소관 —
      fetchPlan이 RPC로 옮겨가도 이 두 술어는 /api/me/billing의 원시 entitlements 행에서 그대로 쓰인다. ── */
test('proRowActive: 대사 게이트 회귀 가드 — ends_at 경과 pro는 "유효 아님"이라 대사가 돈다', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  assert.equal(proRowActive({ plan: 'pro', ends_at: daysAgo(1) }), false, '만료 pro → 대사 재적격');
  assert.equal(proRowActive({ plan: 'pro', ends_at: null }), true, '활성 pro (대사 불요 판정은 reconcileUnneeded 소관)');
  assert.equal(proRowActive({ plan: 'pro', ends_at: new Date(Date.now() + 86_400_000).toISOString() }), true, '해지 예약(말일 전)');
  assert.equal(proRowActive({ plan: 'free' }), false);
  assert.equal(proRowActive(null), false);
});

test('reconcileUnneeded: 부여 Pro(구독 없는 pro)는 대사가 돌아야 한다 — 중복 청구 유인 차단', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const granted = { plan: 'pro', ends_at: null, ls_subscription_id: null };
  assert.equal(proRowActive(granted), true, '자격은 유효 pro가 맞다(강등 금지)');
  assert.equal(reconcileUnneeded(granted), false, '그러나 대사는 돌아야 한다 — 잃어버린 결제 후보');
  assert.equal(reconcileUnneeded({ plan: 'pro', ends_at: null, ls_subscription_id: 'sub_1' }), true);
  assert.equal(reconcileUnneeded({ plan: 'pro', ends_at: daysAgo(1), ls_subscription_id: 'sub_1' }), false);
  assert.equal(reconcileUnneeded({ plan: 'free', ls_subscription_id: 'sub_1' }), false);
  assert.equal(reconcileUnneeded(null), false, '무행은 항상 대사 적격');
});

// 보안 검수 M1(2026-09-29): 서비스 모드(service_role)는 auth.uid()가 비어 오너를 p_uid로 넘겨야
// 서버가 그 오너의 plan을 판정한다. 인자를 빼면 서비스 모드 오너가 모두 free로 보인다.
test('fetchPlan: my_plan에 p_uid로 오너를 넘긴다', async () => {
  let seen;
  const sb = { rpc: async (name, args) => { seen = { name, args }; return { data: { plan: 'pro' }, error: null }; } };
  assert.equal(await fetchPlan(sb, 'owner-1'), 'pro');
  assert.deepEqual(seen, { name: 'my_plan', args: { p_uid: 'owner-1' } });
});
