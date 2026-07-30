// 개발 서버 중복 실행 회귀 — 살아 있는 소유자 차단, 죽은 PID 회수, 토큰 기반 안전 해제.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireDevServerLock,
  processIsAlive,
  releaseDevServerLock,
} from '../src/dev-server-lock.mjs';

const dirs = [];
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const lockFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'argo-dev-lock-test-'));
  dirs.push(dir);
  return join(dir, 'dev.lock');
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

test('첫 개발 서버만 락을 얻고 살아 있는 두 번째 실행은 원본을 보존한다', () => {
  const file = lockFile();
  const first = { pid: process.pid, token: 'first' };
  assert.equal(acquireDevServerLock(file, first).acquired, true);
  const second = acquireDevServerLock(file, { pid: process.pid, token: 'second' });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, 'running');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'first');
});

test('죽은 PID의 오래된 락은 회수하고 새 소유자로 교체한다', () => {
  const file = lockFile();
  writeFileSync(file, JSON.stringify({ pid: 999999999, token: 'stale' }));
  const next = { pid: process.pid, token: 'next' };
  const result = acquireDevServerLock(file, next, { isAlive: () => false });
  assert.equal(result.acquired, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'next');
});

test('소유 토큰이 다른 종료는 후속 서버 락을 삭제하지 않는다', () => {
  const file = lockFile();
  acquireDevServerLock(file, { pid: process.pid, token: 'owner' });
  assert.equal(releaseDevServerLock(file, 'other'), false);
  assert.equal(existsSync(file), true);
  assert.equal(releaseDevServerLock(file, 'owner'), true);
  assert.equal(existsSync(file), false);
});

test('PID 확인은 ESRCH은 죽음, EPERM은 살아 있음으로 판정한다', () => {
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(123, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }), false);
  assert.equal(processIsAlive(123, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }), true);
});

test('npm dev 진입점은 단일 실행기이고 개발 캐시는 production과 분리한다', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const entry = readFileSync(join(ROOT, 'scripts', 'dev.mjs'), 'utf8');
  const config = readFileSync(join(ROOT, 'next.config.mjs'), 'utf8');
  assert.equal(pkg.scripts.dev, 'node scripts/dev.mjs');
  assert.match(entry, /acquireDevServerLock/);
  assert.match(entry, /ARGO_NEXT_DIST_DIR.*'\.next-dev'/s);
  assert.match(config, /distDir: process\.env\.ARGO_NEXT_DIST_DIR \|\| '\.next'/);
});
