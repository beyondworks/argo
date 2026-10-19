// 무료 계정 = 로그인·플랜 확인만(유건 2026-10-19 "무료 사용자는 나중에 pro 전환을 위해 로그인만 하는 개념이고 사용은 전적으로 로컬에서 하도록 해야해").
// 행동 시험 — 실제 supabase-js 클라이언트로 동기화 루프·리스 타이머를 자식 프로세스에서 돌리고(가짜 Supabase HTTP), 나간 요청을 센다.
// 계약: ① 확정 free면 /auth/v1/user·rpc/my_plan(10분 캐시)·토큰 회전 말고는 0건 — Storage(리스·클레임·매니페스트·목록), account_keys·device_keys·
//   wrapped_deks, 색인 RPC 모두 없음 ② 그래도 이 기기가 실행 담당이다(isCloudLeader — 루틴·텔레그램이 이 기기에서 돈다)
// ③ 인접 핀: Pro는 종전처럼 리스·매니페스트를 쓴다 ④ 플랜 조회 실패(미확인)는 free로 보지 않는다(유료 오차단 방지 — 종전 동작).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, spawnLeaseChild } from './helpers/sync-child.mjs';

const roots = [];
after(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 앱 최소 버전 확인(30분마다) = 옛 앱 사용 중지 장치(#1107) — 로그인한 기기의 안전장치라 무료도 남긴다
const ALLOWED_FREE = new Set(['GET /auth/v1/user', 'POST /rest/v1/rpc/my_plan', 'POST /auth/v1/token', 'POST /rest/v1/rpc/argo_min_app_version']);

async function run(plan, { ms = 6000, fault = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), `argo-freelocal-${plan}-`)); roots.push(root);
  const fake = await startFakeSupabase({ plan, userId: 'u1' });
  if (fault) fake.fault = fault;
  seedRoot(root, { url: fake.url, userId: 'u1' });
  const child = spawnLeaseChild({ root, env: { ARGO_SYNC_CYCLE_MS: '500' } });
  await sleep(ms);
  const last = child.last();
  await child.kill();
  await fake.close();
  const kinds = {};
  for (const h of fake.hits) kinds[h.k.replace(/\/storage\/v1\/object\/.*/, '/storage/v1/object/*')] = (kinds[h.k.replace(/\/storage\/v1\/object\/.*/, '/storage/v1/object/*')] ?? 0) + 1;
  return { hits: fake.hits, kinds, last, err: child.err };
}

test('확정 free — 6초(주기 0.5초 × 12)에 로그인·플랜 확인 말고는 요청 0, 이 기기가 실행 담당', async () => {
  const r = await run('free');
  const extra = r.hits.filter((h) => !ALLOWED_FREE.has(h.k));
  assert.deepEqual(extra.map((h) => h.k), [], `무료 계정이 클라우드를 불렀다: ${JSON.stringify(r.kinds)}`);
  assert.ok((r.kinds['POST /rest/v1/rpc/my_plan'] ?? 0) >= 1, '플랜 확인은 한다');
  assert.ok((r.kinds['POST /rest/v1/rpc/my_plan'] ?? 0) <= 2, `플랜 확인은 캐시된다(10분) — ${r.kinds['POST /rest/v1/rpc/my_plan']}건`);
  assert.equal(r.last?.cloud, true, '무료 기기가 실행 담당이 아니다 — 루틴·텔레그램이 멈춘다');
  console.log(`# [free] 6초 요청: ${JSON.stringify(r.kinds)}`);
});

test('인접 핀 — Pro는 종전처럼 리스(Storage)·매니페스트를 쓴다', async () => {
  const r = await run('pro');
  assert.ok((r.kinds['POST /storage/v1/object/*'] ?? 0) + (r.kinds['PUT /storage/v1/object/*'] ?? 0) > 0, `Pro 쓰기가 없다: ${JSON.stringify(r.kinds)}`);
  assert.ok(r.hits.some((h) => h.k.includes('_device-lease.json') || h.k.startsWith('GET /storage/v1/object/')), 'Pro 리스 읽기가 없다');
  console.log(`# [pro] 6초 요청: ${JSON.stringify(r.kinds)}`);
});

test('플랜 조회 실패(미확인)는 free로 보지 않는다 — 종전처럼 동기화를 시도한다(유료 오차단 방지)', async () => {
  const r = await run('free', { fault: (_req, path) => (path.endsWith('/rpc/my_plan') ? { status: 500 } : null) });
  assert.ok(r.hits.some((h) => h.k.startsWith('GET /storage/v1/object/') || h.k.startsWith('POST /storage/v1/object/')), `미확인인데 동기화를 멈췄다: ${JSON.stringify(r.kinds)}`);
});
