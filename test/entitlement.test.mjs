// B(페이월 서버측 이전) 클라이언트 pre-flight 회귀 테스트.
// 집행 권위는 서버 RLS(is_pro). 여기선 클라 UX 불변식: 조회 실패는 'free'가 아니라 null(미확인)이어야
// 하고, 강제 on에서도 '확정 free'만 차단하고 pro·미확인은 낙관 통과해야 한다(유료 사용자 오차단 방지).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlan, syncEntitled } from '../src/entitlement.mjs';

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
