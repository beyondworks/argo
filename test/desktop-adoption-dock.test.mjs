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
  // 입양 판정 = 포트 상태 열거 + ping 본문 판정 + 프로브 + 같은 버전 술어(2026-10-08 상주 대기에서 Silent를 가르려고 나눴다).
  const items = [
    /#\[derive\([^)]*\)\]\nenum PortState \{[^}]*\}/,
    /fn classify_ping\(text: &str\) -> PortState \{[\s\S]*?\n\}/,
    /fn probe_port\(port: u16\) -> PortState \{[\s\S]*?\n\}/,
    /fn is_same_version_argo\(port: u16\) -> bool \{[\s\S]*?\n\}/,
  ].map((re) => source.match(re)?.[0]);
  assert.ok(items.every(Boolean), 'adoption predicate pieces');
  const predicate = items.join('\n');
  const behavior = source.match(/    fn adoption_rejects_same_version_without_current_dock_protocol\(\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(predicate); assert.ok(behavior);
  const dir = await mkdtemp(join(tmpdir(), 'argo-adoption-dock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = join(dir, 'adoption.rs');
  const binary = join(dir, process.platform === 'win32' ? 'adoption.exe' : 'adoption');
  await writeFile(harness, `use std::io::{Read, Write};\nuse std::net::TcpStream;\nuse std::time::Duration;\n${predicate}\n#[test]\n${behavior}\n`);
  execFileSync('rustc', ['--edition=2021', '--test', harness, '-o', binary], { env: { ...process.env, CARGO_PKG_VERSION: '9.9.9' }, stdio: 'pipe' });
  const result = execFileSync(binary, [], { encoding: 'utf8' });
  assert.match(result, /1 passed; 0 failed/);
});
