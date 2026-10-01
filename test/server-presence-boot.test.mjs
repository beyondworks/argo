// 앱 사이드카(ARGO_PARENT_PID가 있는 서버)는 부팅할 때 실행 표식을 쓰고 종료할 때 지운다 — argo login이 "앱이 실행 중인가"를 알 수 있게(2026-10-01).
// 상주(:3001)·argo run·개발 서버는 ARGO_PARENT_PID가 없어 표식을 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { childEnv } from './helpers/sync-child.mjs';

const boot = (root, extra) => {
  const script = `
await import(${JSON.stringify(new URL('../instrumentation-node.mjs', import.meta.url).href)});
await new Promise((r) => setTimeout(r, 1200));
const f = ${JSON.stringify(join(root, '.server-presence.json'))};
const { existsSync, readFileSync } = await import('node:fs');
process.stdout.write('\\n@@' + JSON.stringify({ during: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null, pid: process.pid }) + '\\n');
process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, { ...extra, ARGO_SYNC: '0' }), encoding: 'utf8', timeout: 60_000 });
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `no result\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(2));
};

test('사이드카(ARGO_PARENT_PID)는 부팅 중 표식(pid)을 두고 종료하면 지운다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-presence-boot-')); mkdirSync(root, { recursive: true });
  const r = boot(root, { ARGO_PARENT_PID: String(process.pid) });
  assert.equal(r.during.pid, r.pid, '표식의 pid = 서버 프로세스');
  assert.equal(existsSync(join(root, '.server-presence.json')), false, '종료 때 지운다');
});

test('상주·argo run·개발 서버(ARGO_PARENT_PID 없음)는 표식을 쓰지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-presence-boot-')); mkdirSync(root, { recursive: true });
  assert.equal(boot(root, {}).during, null);
});
