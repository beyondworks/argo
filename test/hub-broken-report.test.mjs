// L2(2026-10-05 분리 검수): hub.listAgents가 못 읽은 크루 카드를 조용히 뺀다(경고 로그는 프로세스당 한 번, Windows EBUSY·EMFILE 같은 일시 실패도 같은 경로).
// 그 크루가 목록에서 사라져도 사용자는 이유를 모른다 → 회사·크루 목록 API 응답에 `broken`(못 읽은 카드 수·이름)을 함께 돌려주고
// 작업 공간 화면이 "크루 카드 N개를 읽지 못했어요"를 작게 보인다. 잠그는 행동:
//   ① scanAgents가 agents와 broken을 함께 돌려주고 listAgents(배열)는 종전 그대로 ② 경고 로그가 1회여도 broken은 매 호출 보고
//   ③ listCompanies 항목·GET /api/companies/[ws]/agents·GET /api/companies/[ws](light 포함)가 broken을 싣는다 ④ 화면 판정 함수
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-hubbroken-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // AUTH off
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
globalThis.__argoScheduler = true; globalThis.__argoGateway = true;

const { WS_ROOT } = await import('../src/workspace.mjs');
const hub = await import('../src/hub.mjs');

async function company(id, { bad = [] } = {}) {
  const root = join(WS_ROOT, id);
  await mkdir(join(root, 'agents'), { recursive: true });
  await writeFile(join(root, 'company.json'), JSON.stringify({ id, name: id, created: '2026-10-05T00:00:00Z' }));
  await writeFile(join(root, 'agents', 'good.md'), '---\nname: 좋은 크루\nrole: 기획\n---\n# 좋은 크루\n');
  for (const n of bad) await mkdir(join(root, 'agents', `${n}.md`), { recursive: true }); // 디렉터리 = readFile EISDIR — 못 읽는 카드
}
const call = async (mod, path, ws) => (await import(mod)).GET(new Request(`http://localhost${path}`), { params: Promise.resolve({ ws }) });

test('scanAgents — 읽은 크루와 못 읽은 카드(수·이름)를 함께 돌려주고, listAgents는 배열 그대로다', async () => {
  await company('hb-a', { bad: ['zeta', 'bad'] });
  const r = await hub.scanAgents('hb-a');
  assert.deepEqual(r.agents.map((a) => a.slug), ['good']);
  assert.deepEqual(r.broken, { count: 2, names: ['bad', 'zeta'] }, '이름은 카드 파일명(.md 제외)·정렬');
  const list = await hub.listAgents('hb-a');
  assert.ok(Array.isArray(list)); assert.deepEqual(list.map((a) => a.slug), ['good']);
  const again = await hub.scanAgents('hb-a'); // 경고 로그는 프로세스당 한 번이지만 보고는 매번 — 화면이 사라지지 않게
  assert.equal(again.broken.count, 2);
  await company('hb-clean');
  assert.deepEqual((await hub.scanAgents('hb-clean')).broken, { count: 0, names: [] });
  await assert.rejects(() => hub.listAgents('hb-a', { strict: true }), '엄격 모드는 종전처럼 던진다(인벤토리 미러)');
});

test('회사 목록 항목과 크루·회사 API 응답이 broken을 싣는다', async () => {
  await company('hb-b', { bad: ['bad'] });
  const c = (await hub.listCompanies()).find((x) => x.id === 'hb-b');
  assert.equal(c.crew, 1);
  assert.deepEqual(c.broken, { count: 1, names: ['bad'] });
  assert.deepEqual((await hub.listCompanies()).find((x) => x.id === 'hb-clean')?.broken, { count: 0, names: [] });
  const agents = await (await call('../app/api/companies/[ws]/agents/route.js', '/api/companies/hb-b/agents', 'hb-b')).json();
  assert.deepEqual(agents.agents.map((a) => a.slug), ['good']);
  assert.deepEqual(agents.broken, { count: 1, names: ['bad'] });
  const light = await (await call('../app/api/companies/[ws]/route.js', '/api/companies/hb-b?light=1', 'hb-b')).json();
  assert.deepEqual(light.broken, { count: 1, names: ['bad'] }, '사이드바가 쓰는 light 응답에도');
  assert.deepEqual(light.agents.map((a) => a.slug), ['good']);
});

test('화면 판정 — broken이 있을 때만 안내를 만들고, 없거나 0이면 만들지 않는다', async () => {
  const { brokenCardsOf } = await import('../app/c/[ws]/company-load.mjs');
  assert.deepEqual(brokenCardsOf({ broken: { count: 2, names: ['a', 'b'] } }), { count: 2, names: ['a', 'b'] });
  for (const d of [null, undefined, {}, { broken: null }, { broken: { count: 0, names: [] } }, { broken: { count: 'x' } }, { missing: true }]) assert.equal(brokenCardsOf(d), null, JSON.stringify(d));
});
