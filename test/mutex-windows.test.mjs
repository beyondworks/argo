import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp } from './helpers/tmp.mjs';

// Exercise the production loop with deterministic OS errors; no product test switches.
const source = (await readFile(new URL('../src/mutex.mjs', import.meta.url), 'utf8'))
  .replace("await import('node:fs/promises')", 'fs')
  .replace("await import('node:path')", 'path')
  .replaceAll('export ', '');
const load = (platform, fs) => new Function('fs', 'path', 'process', `${source}; return withDirLock;`)(fs, { dirname }, { platform });
const failure = code => Object.assign(new Error('fixture mkdir failed'), { code });

test('Windows delete-pending EPERM retries acquisition without reclaiming another owner', async () => {
  let attempts = 0, callback = 0, stats = 0, removals = 0;
  const lock = load('win32', {
    mkdir: async (_file, opts) => { if (!opts && ++attempts <= 3) throw failure('EPERM'); },
    stat: async () => { stats++; return { mtimeMs: 0 }; },
    rm: async () => { removals++; },
  });
  assert.equal(await lock('/fixture/lock', async () => { callback++; assert.equal(removals, 0); return 'acquired'; }, { retryMs: 1 }), 'acquired');
  assert.equal(attempts, 4);
  assert.equal(callback, 1);
  assert.equal(stats, 0);
  assert.equal(removals, 1, 'only the successfully acquired lock is removed on release');
});
test('persistent Windows EPERM consumes bounded retry budget and never runs protected write', async () => {
  let attempts = 0;
  const lock = load('win32', {
    mkdir: async (_file, opts) => { if (!opts) { attempts++; throw failure('EPERM'); } },
    stat: async () => { assert.fail('EPERM must not inspect or reclaim lock'); },
    rm: async () => { assert.fail('no acquired lock to remove'); },
  });
  await assert.rejects(lock('/fixture/lock', () => assert.fail('write without lock'), { timeoutMs: 0, retryMs: 1 }), { code: 'ELOCKTIMEOUT' });
  assert.ok(attempts >= 1);
});
test('POSIX EPERM and all-platform EACCES still fail immediately', async () => {
  for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EPERM'], ['win32', 'EACCES']]) {
    let attempts = 0;
    const error = failure(code);
    const lock = load(platform, { mkdir: async (_file, opts) => { if (!opts) { attempts++; throw error; } } });
    await assert.rejects(lock('/fixture/lock', () => assert.fail('write without lock')), e => e === error);
    assert.equal(attempts, 1);
  }
});
test('actual directory mutex preserves every update across four competing Node processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-mutex-race-')), counter = join(root, 'counter.json');
  await writeFile(counter, '0');
  const module = new URL('../src/mutex.mjs', import.meta.url).href;
  const script = `import { readFile, writeFile } from 'node:fs/promises';
    import { withDirLock } from ${JSON.stringify(module)};
    const counter = ${JSON.stringify(counter)};
    for (let i = 0; i < 32; i++) await withDirLock(counter + '.lock', async () => {
      const before = JSON.parse(await readFile(counter, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 1));
      await writeFile(counter, JSON.stringify(before + 1));
    });`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`mutex child failed (${code}): ${stderr}`)));
  })));
  assert.equal(JSON.parse(await readFile(counter, 'utf8')), 128);
});
