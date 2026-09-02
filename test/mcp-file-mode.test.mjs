// mcp.json 권한 회귀 — 자격(env 토큰)과 임의 command를 담는 파일이 0600으로 생기는지.
// 실측 2026-08-19: 동기화 경로는 0600(sync.mjs isSecretRel)인데 로컬 저장만 mode를 안 줘 0644로
// 생겼다. 로컬 우선 제품에서 OS 사용자 경계가 마지막 경계라, 같은 기기의 다른 도구·계정이 읽으면
// 그게 유출이다(고객 기기의 코딩 에이전트가 Argo 파일을 읽은 사고와 같은 계열).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile, mkdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('installMcp: mcp.json이 0600으로 저장된다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-mcpmode-'));
  process.env.ARGO_ROOT = root;
  const { createCompany, paths } = await import('../src/workspace.mjs');
  const { installMcp, MCP_CATALOG } = await import('../src/market.mjs');
  const wsId = 'modedrill';
  await mkdir(join(root, wsId), { recursive: true });
  await createCompany(wsId, 'mode-drill', 'drill@example.com');
  await installMcp(wsId, MCP_CATALOG[0].id);
  const st = await stat(paths(wsId).mcp);
  // Windows는 POSIX 모드가 없어 Node가 mode를 무시한다 — 이 방어는 유닉스 계열 한정이다.
  // (윈도우는 별도 수단이 필요하다는 뜻이므로 조용히 넘기지 않고 사유를 남긴다.)
  if (process.platform === 'win32') return;
  assert.equal(st.mode & 0o777, 0o600, `mcp.json 권한: ${(st.mode & 0o777).toString(8)} (0600이어야)`);
});

test('계약: saveMcp가 mode 0600 + chmod를 함께 건다', async () => {
  const src = await readFile(new URL('../src/market.mjs', import.meta.url), 'utf8');
  const fn = src.split('async function saveMcp')[1]?.split('\n}')[0] ?? '';
  assert.ok(fn.includes('0o600'), 'writeFile mode 0600');
  assert.ok(fn.includes('chmod'), '기존 파일도 조인다 — mode 인자는 기존 파일에 무시된다');
});
