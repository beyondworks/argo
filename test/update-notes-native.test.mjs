import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native release acknowledgement persists atomically across calls and processes', async t => {
  try { execFileSync('rustc', ['--version'], { stdio: 'pipe' }); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Rust compiler unavailable'); return; } throw error; }
  const dir = await mkdtemp(join(tmpdir(), 'argo-update-notes-rust-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, process.platform === 'win32' ? 'update-notes.exe' : 'update-notes');
  const source = fileURLToPath(new URL('../src-tauri/src/update_notes.rs', import.meta.url));
  execFileSync('rustc', ['--edition=2021', '--test', source, '-o', binary], { stdio: 'pipe' });
  const env = { ...process.env };
  delete env.ARGO_UPDATE_NOTES_TEST_DIR;
  delete env.ARGO_UPDATE_NOTES_TEST_VERSION;
  const output = execFileSync(binary, [], { encoding: 'utf8', timeout: 30_000, env });
  assert.match(output, /6 passed; 0 failed/);
});

test('native acknowledgement IPC is registered and permitted on existing app origins', async () => {
  const source = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const build = await readFile(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
  const capability = JSON.parse(await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  for (const command of ['read_update_notes_version', 'acknowledge_update_notes_version']) {
    assert.match(source, new RegExp(`generate_handler!\\[[^\\]]*\\b${command}\\b`));
    assert.ok(build.includes(`"${command}"`));
    assert.ok(capability.permissions.includes(`allow-${command.replaceAll('_', '-')}`));
  }
  assert.match(source, /let installed = app\.package_info\(\)\.version\.to_string\(\);/);
  assert.match(source, /spawn_blocking\(move \|\| update_notes::acknowledge\(&dir, &version, &installed\)\)/);
});
