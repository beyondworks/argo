// PR #160 이월 견고화 회귀 — 돈 표면이라 경계를 테스트로 잠근다:
//  [M1] 원자 적용(apply_ls_event RPC 호출 계약 + 마이그레이션 불변식)
//  [M4] 미귀속 적재 행 구성  [O2] 대사 후보 선별·쿨다운·실행 흐름
// DB 원자성 자체는 Postgres의 몫 — 여기서는 (a) 라우트/모듈이 RPC 계약을 지키는지,
// (b) 마이그레이션 SQL이 "단일 문장 조건부 upsert + 권한 격리" 불변식을 유지하는지 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyLsEvent, unmatchedRow, pickProSubscription, lsGateOpts } from '../src/lsbilling.mjs';
import { reconcileDue, reconcileEntitlement } from '../src/lsreconcile.mjs';

const UID = '11111111-2222-3333-4444-555555555555';

// ── [M1] applyLsEvent — RPC 호출 계약
const mappedFix = {
  userId: UID, plan: 'pro', ls_subscription_id: 'sub_1', ls_customer_id: '77',
  ls_status: 'active', ls_updated_at: '2026-07-28T01:00:00Z', ends_at: null, portal_url: 'https://ls.example/portal',
};

test('applyLsEvent: mapped 전체 필드를 RPC 인자로 넘기고 판정 문자열을 돌려준다', async () => {
  const calls = [];
  const sb = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: 'applied', error: null }; } };
  assert.equal(await applyLsEvent(sb, mappedFix), 'applied');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'apply_ls_event');
  assert.deepEqual(calls[0][1], {
    p_user_id: UID, p_plan: 'pro', p_sub_id: 'sub_1', p_customer_id: '77',
    p_status: 'active', p_updated_at: '2026-07-28T01:00:00Z', p_ends_at: null, p_portal_url: 'https://ls.example/portal',
  });
});

test('applyLsEvent: DB 오류는 throw — 호출자(웹훅)가 5xx로 LS 재시도를 유도해야 한다', async () => {
  const sb = { rpc: async () => ({ data: null, error: { message: 'boom' } }) };
  await assert.rejects(() => applyLsEvent(sb, mappedFix), /boom/);
});

test('마이그레이션 불변식: 조건 판정이 upsert 한 문장 안에 있고(원자), RPC는 서비스 롤 전용', async () => {
  const sql = await readFile(fileURLToPath(new URL('../supabase/migrations/20260728113000_billing_hardening.sql', import.meta.url)), 'utf8');
  // 단일 문장 조건부 upsert — select→비교→쓰기 3단계로 되돌아가는 회귀를 텍스트 수준에서 차단
  assert.match(sql, /on conflict \(user_id\) do update/);
  assert.match(sql, /e\.ls_updated_at <= excluded\.ls_updated_at/);          // 순서 역전(isStaleEvent 거울)
  assert.match(sql, /excluded\.plan = 'free'/);                              // 신원 가드(O1 거울)
  // 사용자 자기승격 차단 — anon/authenticated에서 실행권 회수
  assert.match(sql, /revoke execute on function public\.apply_ls_event[\s\S]*?from public, anon, authenticated/);
  // 미귀속 테이블은 RLS on + 정책 없음(서비스 롤 전용) + dedup
  assert.match(sql, /alter table public\.billing_unmatched enable row level security/);
  assert.doesNotMatch(sql, /create policy[\s\S]*billing_unmatched/);
  assert.match(sql, /billing_unmatched_dedup/);
});

// ── [M4] unmatchedRow — 수동 귀속에 필요한 최소 식별자만
test('unmatchedRow: 구독id·customer·이메일·이벤트·사유를 싣고, raw payload 전체는 싣지 않는다', () => {
  const payload = {
    meta: { event_name: 'subscription_created' },
    data: { id: 999, attributes: { customer_id: 77, user_email: 'pay@example.com', card_last_four: '4242' } },
  };
  const row = unmatchedRow('subscription_created', 'no-user', payload);
  assert.deepEqual(row, {
    event_name: 'subscription_created', reason: 'no-user',
    ls_subscription_id: '999', ls_customer_id: '77', user_email: 'pay@example.com',
  }); // deepEqual = 여분 필드(카드번호 등 PII)가 끼면 실패
});

test('unmatchedRow: 필드 부재는 빈 문자열 — dedup 유니크 인덱스(not null) 계약 유지', () => {
  const row = unmatchedRow(undefined, undefined, {});
  assert.deepEqual(row, { event_name: '', reason: '', ls_subscription_id: '', ls_customer_id: '', user_email: '' });
});

// ── [O2] pickProSubscription — 대사 후보 선별
const sub = (id, status, extra = {}) => ({
  id, attributes: { status, customer_id: 77, variant_id: 111, updated_at: '2026-07-28T01:00:00Z', ends_at: null, urls: { customer_portal: 'https://ls.example/p' }, ...extra },
});

test('선별: PRO 상태만 후보 — 만료·미납은 복구 대상이 아니다(강등은 웹훅의 몫)', () => {
  assert.equal(pickProSubscription([sub('a', 'expired'), sub('b', 'unpaid')]), null);
  const m = pickProSubscription([sub('a', 'expired'), sub('b', 'active')]);
  assert.equal(m.ls_subscription_id, 'b');
  assert.equal(m.plan, 'pro');
  assert.equal(m.ls_status, 'active');
});

test('선별: 웹훅과 같은 게이트 — test_mode 기본 거부, variant 허용목록 밖 거부', () => {
  assert.equal(pickProSubscription([sub('a', 'active', { test_mode: true })]), null);
  assert.equal(pickProSubscription([sub('a', 'active', { test_mode: true })], { allowTest: true })?.ls_subscription_id, 'a');
  const opts = { allowedVariants: new Set(['222']) };
  assert.equal(pickProSubscription([sub('a', 'active')], opts), null); // variant 111 ∉ {222}
  assert.equal(pickProSubscription([sub('a', 'active', { variant_id: 222 })], opts)?.ls_subscription_id, 'a');
});

test('선별: 복수 후보는 updated_at 최신 우선, 저장 customer_id 일치가 있으면 그쪽 우선', () => {
  const older = sub('old', 'active', { updated_at: '2026-07-01T00:00:00Z', customer_id: 55 });
  const newer = sub('new', 'active', { updated_at: '2026-07-28T00:00:00Z', customer_id: 66 });
  assert.equal(pickProSubscription([older, newer]).ls_subscription_id, 'new');
  assert.equal(pickProSubscription([older, newer], { storedCustomerId: '55' }).ls_subscription_id, 'old');
  assert.equal(pickProSubscription([older, newer], { storedCustomerId: '99' }).ls_subscription_id, 'new'); // 불일치면 최신 폴백
});

// ── [O2] 쿨다운 — LS API 연타 방지(실패해도 쿨다운 소모)
test('reconcileDue: 첫 호출 통과, 쿨다운 내 재호출 차단, 경과 후 재통과', () => {
  const uid = 'cooldown-user-1';
  assert.equal(reconcileDue(uid, 1_000_000, 600_000), true);
  assert.equal(reconcileDue(uid, 1_000_000 + 1, 600_000), false);
  assert.equal(reconcileDue(uid, 1_000_000 + 600_000, 600_000), true);
});

// ── [O2] reconcileEntitlement — 실행 흐름
const fakeFetch = (subs, status = 200) => async () => ({
  ok: status === 200, status, json: async () => ({ data: subs }),
});

test('대사: 활성 구독 발견 → 원자 적용 경로(apply_ls_event)로 복구, userId는 세션 신원으로 강제', async () => {
  const calls = [];
  const sb = { rpc: async (fn, args) => { calls.push(args); return { data: 'applied', error: null }; } };
  const r = await reconcileEntitlement({
    sb, userId: UID, email: 'pay@example.com', apiKey: 'k',
    fetchImpl: fakeFetch([sub('sub_9', 'active')]), nowMs: 10_000_000,
  });
  assert.equal(r.result, 'applied');
  assert.equal(calls[0].p_user_id, UID);       // 귀속은 LS 응답이 아니라 요청 세션의 user.id
  assert.equal(calls[0].p_sub_id, 'sub_9');
  assert.equal(calls[0].p_plan, 'pro');
});

test('대사: 활성 구독 없음 → 쓰기 없이 null(강등 방향 대사 금지)', async () => {
  let wrote = false;
  const sb = { rpc: async () => { wrote = true; return { data: 'applied', error: null }; } };
  const r = await reconcileEntitlement({
    sb, userId: `${UID}-none`, email: 'a@b.c', apiKey: 'k',
    fetchImpl: fakeFetch([sub('x', 'expired')]), nowMs: 20_000_000,
  });
  assert.equal(r, null);
  assert.equal(wrote, false);
});

test('대사: apiKey·email 부재는 즉시 null(LS 호출 자체가 없다) — 로컬·미설정 환경 무해', async () => {
  const boom = async () => { throw new Error('fetch가 불리면 안 된다'); };
  assert.equal(await reconcileEntitlement({ sb: {}, userId: 'u1', email: '', apiKey: 'k', fetchImpl: boom }), null);
  assert.equal(await reconcileEntitlement({ sb: {}, userId: 'u2', email: 'a@b.c', apiKey: '', fetchImpl: boom }), null);
});

test('대사: 쿨다운 내 재호출은 LS API를 다시 때리지 않는다', async () => {
  let fetches = 0;
  const f = async () => { fetches++; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  const args = { sb: {}, userId: 'cooldown-user-2', email: 'a@b.c', apiKey: 'k', fetchImpl: f };
  await reconcileEntitlement({ ...args, nowMs: 30_000_000 });
  await reconcileEntitlement({ ...args, nowMs: 30_000_001 });
  assert.equal(fetches, 1);
});

test('대사: LS API 비정상 응답은 throw — 호출자(me/billing)가 삼켜 응답을 깨지 않게 한다', async () => {
  await assert.rejects(() => reconcileEntitlement({
    sb: {}, userId: 'err-user-1', email: 'a@b.c', apiKey: 'k', fetchImpl: fakeFetch([], 500), nowMs: 40_000_000,
  }), /LS API 500/);
});

// ── 게이트 옵션 공유 — 웹훅·대사가 같은 env 해석을 쓴다
test('lsGateOpts: variant 목록 파싱(공백·빈 항목 제거), 미설정이면 null, allowTest는 "1"만', () => {
  assert.deepEqual(lsGateOpts({ LEMONSQUEEZY_PRO_VARIANT_IDS: ' 111, ,222 ' }), { allowedVariants: new Set(['111', '222']), allowTest: false });
  assert.deepEqual(lsGateOpts({}), { allowedVariants: null, allowTest: false });
  assert.equal(lsGateOpts({ LEMONSQUEEZY_ALLOW_TEST: '1' }).allowTest, true);
  assert.equal(lsGateOpts({ LEMONSQUEEZY_ALLOW_TEST: 'true' }).allowTest, false);
});
