#!/usr/bin/env node
// Next dev 단일 실행기. 중복 npm run dev가 같은 캐시를 덮어 API 500을 만드는 것을 차단한다.
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { acquireDevServerLock, releaseDevServerLock } from '../src/dev-server-lock.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NEXT_BIN = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const repoKey = createHash('sha256').update(ROOT).digest('hex').slice(0, 16);
const lockPath = join(tmpdir(), `argo-next-dev-${repoKey}.lock`);
const owner = {
  pid: process.pid,
  token: randomUUID(),
  startedAt: new Date().toISOString(),
  args: process.argv.slice(2),
};
const lock = acquireDevServerLock(lockPath, owner);

if (!lock.acquired) {
  const detail = lock.owner?.pid ? ` (PID ${lock.owner.pid})` : '';
  console.log(`[argo] 이 저장소의 개발 서버가 이미 실행 중입니다${detail}.`);
  console.log('[argo] 기존 서버를 사용합니다. 중복 실행은 Next 빌드 캐시 손상을 막기 위해 시작하지 않았습니다.');
  process.exit(0);
}

let released = false;
const release = () => {
  if (released) return;
  released = true;
  releaseDevServerLock(lockPath, owner.token);
};

const child = spawn(process.execPath, [NEXT_BIN, 'dev', ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    // dev와 next build/start가 겹쳐도 같은 산출물 디렉터리를 만지지 않는다.
    ARGO_NEXT_DIST_DIR: process.env.ARGO_NEXT_DIST_DIR || '.next-dev',
  },
});

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => stop(signal));
}

child.once('error', (error) => {
  console.error(`[argo] 개발 서버 시작 실패: ${error.message}`);
  release();
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  release();
  process.exitCode = code ?? (signal ? 1 : 0);
});

process.once('exit', release);
