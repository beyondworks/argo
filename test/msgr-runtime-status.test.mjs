import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-status-'));
const { msgrGatewayStatus } = await import('../src/connections.mjs');
const { paths } = await import('../src/workspace.mjs');

test('메신저 응답 상태는 손상된 다른 연결 설정과 독립적으로 읽힌다', async () => {
  const ws = 'status-check';
  const root = paths(ws).root;
  await mkdir(root, { recursive: true });
  await writeFile(paths(ws).connections, '{bad json');
  await writeFile(join(root, '.gateway-msgr.json'), JSON.stringify({ ts: Date.now(), ok: true, error: '' }));
  try {
    assert.equal((await msgrGatewayStatus(ws)).alive, true);
  } finally {
    await rm(process.env.ARGO_ROOT, { recursive: true, force: true });
  }
});
