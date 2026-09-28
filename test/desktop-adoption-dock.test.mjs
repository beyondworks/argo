import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('desktop source adoption gate rejects stale resident over isolated HTTP sockets', async t => {
  try { execFileSync('rustc', ['--version'], { stdio: 'pipe' }); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Rust compiler unavailable in Node-only environment'); return; } throw error; }
  const source = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const predicate = source.match(/fn is_same_version_argo\(port: u16\) -> bool \{[\s\S]*?\n\}/)?.[0];
  const behavior = source.match(/    fn adoption_rejects_same_version_without_current_dock_protocol\(\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(predicate); assert.ok(behavior);
  const dir = await mkdtemp(join(tmpdir(), 'argo-adoption-dock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = join(dir, 'adoption.rs');
  const binary = join(dir, 'adoption');
  await writeFile(harness, `use std::io::{Read, Write};\nuse std::net::TcpStream;\nuse std::time::Duration;\n${predicate}\n#[test]\n${behavior}\n`);
  execFileSync('rustc', ['--edition=2021', '--test', harness, '-o', binary], { env: { ...process.env, CARGO_PKG_VERSION: '9.9.9' }, stdio: 'pipe' });
  const result = execFileSync(binary, [], { encoding: 'utf8' });
  assert.match(result, /1 passed; 0 failed/);
});
