// F3·F13(2026-10-05 분리 검증)
// F3: 회사 정보 조회가 한 번 실패하면(순단·401·500) 셸 전체가 '회사를 찾을 수 없습니다'가 됐고, GET 라우트는 모든 예외를 404로 돌려줬다.
// F13: 홈의 회사 목록 조회가 실패하면 해골 화면이 끝없이 돌았다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-coload-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // AUTH off(apimsg 관례)
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
globalThis.__argoScheduler = true; globalThis.__argoGateway = true; // 라우트 임포트가 상주 데몬(타이머)을 띄우지 않게

const { nextCompanyData, isCompanyMissing } = await import('../app/c/[ws]/company-load.mjs');
const { homeListView } = await import('../app/home-list.mjs');
const fail = (status, errorCode) => Object.assign(new Error('x'), { data: errorCode ? { errorCode } : {}, status });

test('F3 셸: 진짜 없음(404 company_not_found)만 "찾을 수 없음" — 순단·401·500은 보던 화면을 그대로 둔다', () => {
  const prev = { company: { id: 'co', name: '회사' }, agents: [] };
  assert.deepEqual(nextCompanyData(prev, fail(404, 'company_not_found')), { missing: true });
  for (const e of [fail(500), fail(401, 'auth_required'), fail(403, 'company_forbidden'), new TypeError('fetch failed')]) {
    assert.equal(nextCompanyData(prev, e), prev, `${e.message}: 보던 화면 유지`);
    assert.deepEqual(nextCompanyData(null, e), { loadError: true }, '처음부터 못 받았으면 다시 시도 화면');
  }
  assert.equal(isCompanyMissing(fail(404)), false, '코드 없는 404(프록시 등)는 없음으로 단정하지 않는다');
});

test('F3 라우트: company.json이 없을 때만 404, 손상 등 그 밖의 읽기 실패는 500', async () => {
  const route = await import('../app/api/companies/[ws]/route.js');
  const { WS_ROOT } = await import('../src/workspace.mjs');
  const call = (ws) => route.GET(new Request(`http://localhost/api/companies/${ws}?light=1`), { params: Promise.resolve({ ws }) });
  const gone = await call('co-none');
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).errorCode, 'company_not_found');
  await mkdir(join(WS_ROOT, 'co-broken'), { recursive: true });
  await writeFile(join(WS_ROOT, 'co-broken', 'company.json'), '{"id": "co-broken", 잘린 JSON');
  const broken = await call('co-broken');
  assert.equal(broken.status, 500, '손상은 "없음"이 아니다 — 회사가 사라진 것처럼 보이면 안 된다');
  assert.notEqual((await broken.json()).errorCode, 'company_not_found');
  await mkdir(join(WS_ROOT, 'co-ok'), { recursive: true });
  await writeFile(join(WS_ROOT, 'co-ok', 'company.json'), JSON.stringify({ id: 'co-ok', name: '정상' }));
  assert.equal((await call('co-ok')).status, 200);
});

test('F13 홈 목록: 조회 실패는 오류 + 다시 시도(끝없는 로딩 금지)', () => {
  assert.equal(homeListView(null, false), 'loading');
  assert.equal(homeListView(null, true), 'error');
  assert.equal(homeListView([], true), 'empty', '이미 받은 목록이 있으면 그것을 보여 준다');
  assert.equal(homeListView([{ id: 'a' }], false), 'list');
});
