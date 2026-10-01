// 요금제 조회 10분 캐시 — 검수 M3(DB 위생, 2026-10-01).
// 결함(수정 전, 가짜 Supabase 측정): 바뀐 게 없는 동기화 프로세스가 주기마다 GET /auth/v1/user + POST rpc/my_plan을 보냈다
// (2초 주기 20초 동안 각 8회 — 기본 8초 주기면 프로세스당 분당 15건, 하루 21,600건). 앱·CLI 상주마다 따로 센다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, runSyncChild } from './helpers/sync-child.mjs';
import { cachedPlan, rememberPlan, invalidatePlanCache, PLAN_TTL_MS, PLAN_FAIL_TTL_MS } from '../src/plan-cache.mjs';

const USER = 'GET /auth/v1/user';
const PLAN = 'POST /rest/v1/rpc/my_plan';
const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });

test('유휴 동기화: 0.5초 주기로 5초(약 10주기) 돌아도 요금제 조회는 1번뿐이다(수정 전: 주기마다)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-plancache-'));
  seedRoot(root, { url: fake.url });
  const { status } = await runSyncChild({ root, env: { ARGO_SYNC_CYCLE_MS: '500' }, waitMs: 5000 });
  assert.equal(status.plan, 'pro', '캐시된 판정도 설정 카드에 그대로 보인다');
  assert.equal(fake.count(PLAN), 1, 'rpc/my_plan');
  assert.equal(fake.count(USER), 1, '/auth/v1/user');
});

test('업로드가 거절되면 캐시를 버리고 다음 주기에 다시 묻는다 — 그 뒤로는 다시 캐시(거절 회사는 10분 보류라 재거절 없음)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro', rejectUploads: true }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-plancache-deny-'));
  seedRoot(root, { url: fake.url });
  await runSyncChild({ root, env: { ARGO_SYNC_CYCLE_MS: '500' }, waitMs: 5000 });
  assert.equal(fake.count(PLAN), 2, '첫 조회 + 거절 직후 1회');
  assert.equal(fake.count(USER), 2);
});

test('캐시 판정(순수): 같은 키·10분 안이면 그대로, 키가 바뀌면(계정·오너 변경) 빗나감, 조회 실패(null)는 1분만', () => {
  invalidatePlanCache();
  const t0 = 1_000_000;
  rememberPlan('u1|u1', { ok: true, plan: 'pro' }, t0);
  assert.deepEqual(cachedPlan('u1|u1', t0 + PLAN_TTL_MS - 1), { ok: true, plan: 'pro' });
  assert.equal(cachedPlan('u1|u1', t0 + PLAN_TTL_MS), null, '10분 지나면 다시 묻는다');
  assert.equal(cachedPlan('u2|u2', t0 + 1), null, '다른 계정으로 로그인하면 옛 계정 판정을 쓰지 않는다');
  rememberPlan('u1|u1', { ok: true, plan: null }, t0);
  assert.ok(cachedPlan('u1|u1', t0 + PLAN_FAIL_TTL_MS - 1));
  assert.equal(cachedPlan('u1|u1', t0 + PLAN_FAIL_TTL_MS), null, '실패는 1분 뒤 재시도(장애 중 매 주기 폭주 방지 + 빠른 복구)');
  rememberPlan('u1|u1', { ok: false, plan: 'free' }, t0);
  invalidatePlanCache();
  assert.equal(cachedPlan('u1|u1', t0 + 1), null);
});

test('결제 화면 조회(me/billing GET)가 캐시를 지운다 — 결제·요금제 변경 뒤 돌아온 탭에서 동기화가 10분 동안 페이월에 머물지 않게(반대 검토 L-f)', async () => {
  // 라우트는 next 의존이라 임포트할 수 없다 — 소스 앵커로 잠근다(test/billing-device-surface.test.mjs와 같은 관례).
  const route = await readFile(new URL('../app/api/me/billing/route.js', import.meta.url), 'utf8');
  assert.match(route, /import \{ invalidatePlanCache \} from '\.\.\/\.\.\/\.\.\/\.\.\/src\/plan-cache\.mjs'/);
  assert.match(route, /export async function GET\(\) \{[\s\S]{0,400}?invalidatePlanCache\(\);/, 'GET 첫머리에서 지운다(조기 반환 분기 전부보다 앞)');
});
