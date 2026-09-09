// mcp.json 권한 회귀 — 자격(env 토큰)과 임의 command를 담는 파일이 0600으로 생기는지.
// 실측 2026-08-19: 동기화 경로는 0600(sync.mjs isSecretRel)인데 로컬 저장만 mode를 안 줘 0644로
// 생겼다. 로컬 우선 제품에서 OS 사용자 경계가 마지막 경계라, 같은 기기의 다른 도구·계정이 읽으면
// 그게 유출이다(고객 기기의 코딩 에이전트가 Argo 파일을 읽은 사고와 같은 계열).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, writeFile, chmod, mkdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'argo-mcpmode-'));
process.env.ARGO_ROOT = root;

test('installMcp: mcp.json이 0600으로 저장된다', async () => {
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

test('installMcp: 기존 0644 파일도 다음 저장에 0600으로 조인다', async () => {
  const { paths } = await import('../src/workspace.mjs');
  const { installMcp, MCP_CATALOG } = await import('../src/market.mjs');
  const file = paths('mode-existing').mcp;
  await mkdir(join(root, 'mode-existing'), { recursive: true });
  await writeFile(file, JSON.stringify({ servers: {} }));
  await chmod(file, 0o644);
  await installMcp('mode-existing', MCP_CATALOG[0].id);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});
