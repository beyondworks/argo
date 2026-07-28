// PR #160 이월 견고화 회귀 — 돈 표면이라 경계를 테스트로 잠근다:
//  [M1] 원자 적용(apply_ls_event RPC 호출 계약 + 마이그레이션 불변식)
//  [M4] 미귀속 적재 행 구성  [O2] 대사 후보 선별·쿨다운·실행 흐름
// DB 원자성 자체는 Postgres의 몫 — 여기서는 (a) 라우트/모듈이 RPC 계약을 지키는지,
// (b) 마이그레이션 SQL이 "단일 문장 조건부 upsert + 권한 격리" 불변식을 유지하는지 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyLsEvent, unmatchedRow, pickProSubscription, lsGateOpts, shouldApplyLsEvent } from '../src/lsbilling.mjs';
import {
  reconcileDueFromRow, claimReconcile, clearReconcileEmpty, reconcileEntitlement, COOLDOWN_MS, EMPTY_COOLDOWN_MS,
} from '../src/lsreconcile.mjs';
import { APPLY_CASES, toMirrorArgs } from './helpers/ls-apply-cases.mjs';

const UID = '11111111-2222-3333-4444-555555555555';

// ── [M1] shouldApplyLsEvent — DB WHERE 조건의 JS 거울. 경계표는 test/helpers/ls-apply-cases.mjs가
// 단일 정본이며 pg 통합 테스트(billing-pg-integration)와 공유한다 — 표가 갈라지면 한쪽이 깨진다.
test('적용 판정 거울: 공유 경계표 전 케이스에서 applied 여부가 DB 기대와 일치 — F1 코너 포함', () => {
  for (const c of APPLY_CASES) {
    const { mapped, stored } = toMirrorArgs(c);
    assert.equal(shouldApplyLsEvent(mapped, stored), c.expect === 'applied', c.name);
  }
});

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
  assert.match(sql, /e\.ls_updated_at <= excluded\.ls_updated_at/);          // 순서 역전(shouldApplyLsEvent 거울)
  assert.match(sql, /coalesce\(e\.ls_subscription_id, ''\) <> excluded\.ls_subscription_id/); // 순서 역전은 같은 구독 한정(F1)
  assert.match(sql, /excluded\.plan = 'free'/);                              // 신원 가드(O1 거울)
  assert.match(sql, /drop function if exists public\.apply_ls_event/);       // 시그니처 변경 시 오버로드 잔존 차단(F12)
  // 사용자 자기승격 차단 — anon/authenticated에서 실행권 회수
  assert.match(sql, /revoke execute on function public\.apply_ls_event[\s\S]*?from public, anon, authenticated/);
  // 미귀속 테이블은 RLS on + 정책 없음(서비스 롤 전용) + dedup
  assert.match(sql, /alter table public\.billing_unmatched enable row level security/);
  assert.doesNotMatch(sql, /create policy[\s\S]*billing_unmatched/);
  assert.match(sql, /billing_unmatched_dedup/);
});

test('마이그레이션 불변식(F7): 쿨다운 컬럼 2종 — 시도·부정 확정 분리, not null default epoch(lte 선점의 전제)', async () => {
  const sql = await readFile(fileURLToPath(new URL('../supabase/migrations/20260728150000_ls_reconcile_cooldown.sql', import.meta.url)), 'utf8');
  // nullable로 되돌리면 claimReconcile의 lte 2개 필터가 null 행을 영원히 못 선점한다 — 회귀 차단
  assert.match(sql, /add column if not exists ls_reconciled_at timestamptz not null default 'epoch'/);
  assert.match(sql, /add column if not exists ls_reconcile_empty_at timestamptz not null default 'epoch'/);
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

// ── [O2·F7] 쿨다운 — DB 공유(인스턴스·재배포 무관). 시도 10분 게이트 + 부정 확정 24시간 게이트
const NOW = Date.parse('2026-07-28T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('reconcileDueFromRow: 무행·컬럼 null은 due, 시도 10분·부정 확정 24시간 게이트(경계 포함)', () => {
  assert.equal(reconcileDueFromRow(null, NOW), true);  // 무행 — 웹훅 전량 유실 결제자일 수 있다
  assert.equal(reconcileDueFromRow({}, NOW), true);    // 컬럼 null — 대사 이력 없음
  // 시도 게이트(10분): 쿨다운 내 차단, 정확히 경과하면 통과
  assert.equal(reconcileDueFromRow({ ls_reconciled_at: iso(NOW - COOLDOWN_MS + 1_000) }, NOW), false);
  assert.equal(reconcileDueFromRow({ ls_reconciled_at: iso(NOW - COOLDOWN_MS) }, NOW), true);
  // 부정 확정 게이트(24시간): 시도 게이트를 지나도 최근 "구독 없음" 확정이면 차단 —
  // 무료 사용자를 10분마다 영구 조회하던 호출량(F7의 핵심)을 여기서 끊는다
  assert.equal(reconcileDueFromRow({ ls_reconciled_at: iso(NOW - COOLDOWN_MS), ls_reconcile_empty_at: iso(NOW - EMPTY_COOLDOWN_MS + 1_000) }, NOW), false);
  assert.equal(reconcileDueFromRow({ ls_reconciled_at: iso(NOW - COOLDOWN_MS), ls_reconcile_empty_at: iso(NOW - EMPTY_COOLDOWN_MS) }, NOW), true);
});

// ── [O2] reconcileEntitlement — 실행 흐름
const fakeFetch = (subs, status = 200) => async () => ({
  ok: status === 200, status, json: async () => ({ data: subs }),
});

// 대사용 가짜 supabase 클라이언트 — rpc + 쿨다운 선점(update().eq().lte().lte().select()) +
// 부정 확정 기록(update().eq() await) + 중복 귀속 조회(select().eq().neq().limit()) + 적재.
// claim: 조건부 update 선점 결과, insertClaim: 무행 insert 선점 결과.
const fakeSb = ({ claim = true, insertClaim = false, dupes = [], rpcResult = 'applied' } = {}) => {
  const calls = { rpc: [], upserts: [], updates: [], ltes: [] };
  const sb = {
    rpc: async (fn, args) => { calls.rpc.push([fn, args]); return { data: rpcResult, error: null }; },
    from: (table) => {
      const b = {
        _update: null, _upsert: null,
        update(vals) { calls.updates.push([table, vals]); this._update = vals; return this; },
        eq() { return this; },
        neq() { return this; },
        lte(col, val) { calls.ltes.push([col, val]); return this; },
        limit: async () => ({ data: dupes, error: null }),
        upsert(row, opts) {
          calls.upserts.push([table, row, opts]);
          if (opts?.ignoreDuplicates && table === 'entitlements') { this._upsert = row; return this; }
          return Promise.resolve({ error: null }); // billing_unmatched 적재 — await로 끝난다
        },
        select() {
          if (this._update) return Promise.resolve({ data: claim ? [{ user_id: 'u' }] : [], error: null });
          if (this._upsert) return Promise.resolve({ data: insertClaim ? [{ user_id: 'u' }] : [], error: null });
          return this; // 중복 귀속 조회 경로
        },
        then(res, rej) { return Promise.resolve({ data: null, error: null }).then(res, rej); }, // update().eq() 직접 await(부정 확정 기록)
      };
      return b;
    },
  };
  return { sb, calls };
};

test('선점(claim): 조건부 update가 행을 갱신하면 통과 — 게이트 2종이 lte 필터(무조건 AND)로 실린다', async () => {
  const { sb, calls } = fakeSb({ claim: true });
  assert.equal(await claimReconcile(sb, UID, NOW), true);
  assert.equal(calls.updates.length, 1);
  assert.deepEqual(Object.keys(calls.updates[0][1]), ['ls_reconciled_at']); // 선점은 시도 시각만 기록
  assert.equal(calls.upserts.length, 0); // 행이 있으면 insert 경로 없음
  // 쿨다운 판정이 DB 문장 안에 있다(원자) — or 그룹 결합 의미에 기대지 않고 lte 2개로 끝난다
  // (컬럼이 not null default epoch이라 null 케이스가 없다 — 마이그레이션 불변식과 한 쌍)
  assert.deepEqual(calls.ltes.map(([col]) => col), ['ls_reconciled_at', 'ls_reconcile_empty_at']);
  assert.equal(calls.ltes[0][1], iso(NOW - COOLDOWN_MS));
  assert.equal(calls.ltes[1][1], iso(NOW - EMPTY_COOLDOWN_MS));
});

test('결제 의사 신호(clearReconcileEmpty): 부정 확정 게이트만 epoch로 해제 — 시도 게이트는 안 건드린다', async () => {
  const { sb, calls } = fakeSb();
  await clearReconcileEmpty(sb, UID);
  assert.equal(calls.updates.length, 1);
  const vals = calls.updates[0][1];
  assert.deepEqual(Object.keys(vals), ['ls_reconcile_empty_at']); // ls_reconciled_at 미포함 — intent 연타가 LS 호출 증폭이 되지 않는 근거
  assert.equal(Date.parse(vals.ls_reconcile_empty_at), 0); // epoch = 항상 due(컬럼 default와 동일)
});

test('선점(claim): 무행이면 ignoreDuplicates insert로 선점 — 동시 생성은 한쪽만 통과', async () => {
  const won = fakeSb({ claim: false, insertClaim: true });
  assert.equal(await claimReconcile(won.sb, UID, NOW), true);
  const [table, row, opts] = won.calls.upserts[0];
  assert.equal(table, 'entitlements');
  assert.deepEqual(Object.keys(row), ['user_id', 'ls_reconciled_at']); // plan 미지정 — default 'free', 자격 무영향
  assert.deepEqual(opts, { onConflict: 'user_id', ignoreDuplicates: true });
  const lost = fakeSb({ claim: false, insertClaim: false }); // 쿨다운 중이거나 타 인스턴스가 선점
  assert.equal(await claimReconcile(lost.sb, UID, NOW), false);
});

// 부정 확정 기록(ls_reconcile_empty_at) update가 있었는지 — 24시간 장기 쿨다운의 근거
const emptyMarks = (calls) => calls.updates.filter(([t, vals]) => t === 'entitlements' && 'ls_reconcile_empty_at' in vals);

test('대사: 활성 구독 발견 → 원자 적용 경로(apply_ls_event)로 복구, userId는 세션 신원으로 강제', async () => {
  const { sb, calls } = fakeSb();
  const r = await reconcileEntitlement({
    sb, userId: UID, email: 'pay@example.com', apiKey: 'k',
    fetchImpl: fakeFetch([sub('sub_9', 'active')]), nowMs: NOW,
  });
  assert.equal(r.result, 'applied');
  assert.equal(calls.rpc[0][1].p_user_id, UID); // 귀속은 LS 응답이 아니라 요청 세션의 user.id
  assert.equal(calls.rpc[0][1].p_sub_id, 'sub_9');
  assert.equal(calls.rpc[0][1].p_plan, 'pro');
  assert.equal(emptyMarks(calls).length, 0); // 복구 성공은 부정 확정이 아니다
});

test('대사 중복 귀속 가드(F2): 같은 구독이 타 계정에 이미 붙어 있으면 쓰지 않고 unmatched 적재', async () => {
  const { sb, calls } = fakeSb({ dupes: [{ user_id: 'someone-else' }] });
  const r = await reconcileEntitlement({
    sb, userId: `${UID}-dupe`, email: 'shared@example.com', apiKey: 'k',
    fetchImpl: fakeFetch([sub('sub_shared', 'active')]), nowMs: NOW,
  });
  assert.equal(r, null);
  assert.equal(calls.rpc.length, 0); // 구독 상태 쓰기 없음 — 1구독 N계정 pro 차단
  const unmatched = calls.upserts.filter(([t]) => t === 'billing_unmatched');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0][1].reason, 'duplicate-attribution');
  assert.equal(unmatched[0][1].ls_subscription_id, 'sub_shared');
  // 이 계정은 결제자일 수 있다 — 24시간 잠그지 않는다(운영자 정리 후 10분 내 재대사로 풀리게)
  assert.equal(emptyMarks(calls).length, 0);
});

test('대사: 활성 구독 없음 → 구독 상태 쓰기 없이 null + 부정 확정 기록(24시간 캐싱)', async () => {
  const { sb, calls } = fakeSb();
  const r = await reconcileEntitlement({
    sb, userId: `${UID}-none`, email: 'a@b.c', apiKey: 'k',
    fetchImpl: fakeFetch([sub('x', 'expired')]), nowMs: NOW,
  });
  assert.equal(r, null);
  assert.equal(calls.rpc.length, 0); // 강등 방향 대사 금지 — plan을 건드리지 않는다
  assert.equal(emptyMarks(calls).length, 1); // 무료 사용자 영구 10분 폴 차단의 핵심
});

test('대사: apiKey·email 부재는 즉시 null(LS 호출·DB 선점 자체가 없다) — 로컬·미설정 환경 무해', async () => {
  const boom = async () => { throw new Error('fetch가 불리면 안 된다'); };
  assert.equal(await reconcileEntitlement({ sb: {}, userId: 'u1', email: '', apiKey: 'k', fetchImpl: boom }), null);
  assert.equal(await reconcileEntitlement({ sb: {}, userId: 'u2', email: 'a@b.c', apiKey: '', fetchImpl: boom }), null);
});

test('대사: DB 선점 실패(쿨다운 중·타 인스턴스 선점)면 LS API를 때리지 않는다', async () => {
  let fetches = 0;
  const f = async () => { fetches++; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  const { sb } = fakeSb({ claim: false, insertClaim: false });
  assert.equal(await reconcileEntitlement({ sb, userId: UID, email: 'a@b.c', apiKey: 'k', fetchImpl: f, nowMs: NOW }), null);
  assert.equal(fetches, 0);
});

test('대사: LS API 비정상 응답은 throw — 호출자(me/billing)가 백그라운드에서 삼킨다. 선점은 이미 소모(장애 연타 방지)', async () => {
  const { sb, calls } = fakeSb();
  await assert.rejects(() => reconcileEntitlement({
    sb, userId: UID, email: 'a@b.c', apiKey: 'k', fetchImpl: fakeFetch([], 500), nowMs: NOW,
  }), /LS API 500/);
  assert.equal(calls.updates.length, 1); // throw 전에 시도 시각이 기록됐다 — 10분간 재시도 차단
  assert.equal(emptyMarks(calls).length, 0); // 오류는 부정 확정이 아니다 — 24시간 잠금 금지
});

// ── 게이트 옵션 공유 — 웹훅·대사가 같은 env 해석을 쓴다
test('lsGateOpts: variant 목록 파싱(공백·빈 항목 제거), 미설정이면 null, allowTest는 "1"만', () => {
  assert.deepEqual(lsGateOpts({ LEMONSQUEEZY_PRO_VARIANT_IDS: ' 111, ,222 ' }), { allowedVariants: new Set(['111', '222']), allowTest: false });
  assert.deepEqual(lsGateOpts({}), { allowedVariants: null, allowTest: false });
  assert.equal(lsGateOpts({ LEMONSQUEEZY_ALLOW_TEST: '1' }).allowTest, true);
  assert.equal(lsGateOpts({ LEMONSQUEEZY_ALLOW_TEST: 'true' }).allowTest, false);
});
