// F7(2026-10-05 분리 검증): 크루 카드 파일 하나를 못 읽으면 listAgents가 던져 회사 전체가 홈 목록(listCompanies)에서
// 사라지고, 게이트웨이 sync가 그 회사의 큐 드레인 워커까지 내렸다. 깨진 카드만 건너뛰고 회사는 남아야 한다.
// 인벤토리 미러(메신저 DB의 크루 행 정리)는 엄격 모드 — 카드를 못 읽었다고 그 크루 행을 지우면 안 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-hubcard-'));
const WS = 'hub-broken';
const root = join(process.env.ARGO_ROOT, 'workspaces', WS);
const { WS_ROOT } = await import('../src/workspace.mjs');
const wsRoot = join(WS_ROOT, WS);
await mkdir(join(wsRoot, 'agents', 'bad.md'), { recursive: true }); // 디렉터리 = readFile EISDIR — 읽을 수 없는 카드 재현
await writeFile(join(wsRoot, 'agents', 'good.md'), '---\nname: 좋은 크루\nrole: 기획\n---\n# 좋은 크루\n');
await writeFile(join(wsRoot, 'company.json'), JSON.stringify({ id: WS, name: '깨진 카드 회사', created: '2026-10-05T00:00:00Z' }));
void root;

test('깨진 크루 카드 하나 때문에 회사가 홈 목록에서 사라지지 않는다 — 그 카드만 건너뛴다', async () => {
  const { listCompanies, listAgents } = await import('../src/hub.mjs');
  const companies = await listCompanies();
  const c = companies.find((x) => x.id === WS);
  assert.ok(c, '회사가 목록에 남는다');
  assert.equal(c.crew, 1, '읽을 수 있는 크루만 센다');
  assert.deepEqual((await listAgents(WS)).map((a) => a.slug), ['good']);
});

test('엄격 모드(인벤토리 미러용)는 종전처럼 던진다 — 못 읽은 카드를 "없는 크루"로 보고 메신저 행을 지우지 않게', async () => {
  const { listAgents } = await import('../src/hub.mjs');
  await assert.rejects(() => listAgents(WS, { strict: true }));
});
