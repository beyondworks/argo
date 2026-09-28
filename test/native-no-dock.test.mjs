import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SHIM_SRC } from '../src/no-dock.mjs';

test('native preload payload matches JS canonical payload byte for byte', async () => {
  assert.equal(await readFile('src-tauri/src/no-dock.cjs', 'utf8'), SHIM_SRC);
});

test('native shared helper exercises token parsing and atomic preparation', { skip: process.platform !== 'darwin' && 'macOS native preload module' }, async (t) => {
  try { execFileSync('rustc', ['--version'], { stdio: 'pipe' }); }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('rustc unavailable in Node-only environment'); return; }
    throw error;
  }
  const dir = await mkdtemp(join(tmpdir(), 'argo-native-dock-tests-'));
  try {
    const binary = join(dir, 'no-dock-tests');
    execFileSync('rustc', ['--edition=2021', '--test', 'src-tauri/src/no_dock.rs', '-o', binary]);
    const output = execFileSync(binary, [], { encoding: 'utf8', env: { ...process.env, ARGO_TEST_NODE: process.execPath } });
    assert.match(output, /0 failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
