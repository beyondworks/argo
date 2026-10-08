import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 본체 셸의 포트 결정(src-tauri/src/boot_port.rs)을 rustc로 따로 컴파일해 그 안의 Rust 테스트를 돌린다 — 본체 crate의
// cargo test는 CI에서 돌지 않아서, 입양 게이트(dockProtocol)와 2026-10-08 상주 대기(재시동 직후 앱이 상주 자리 3001을
// 먼저 차지한 사고)가 이 테스트로만 CI(macOS·Windows)에 잠긴다.
const LOCKED = [
  'adoption_rejects_same_version_without_current_dock_protocol',
  'probe_tells_closed_silent_and_hang_up_apart',
  'resident_still_starting_is_waited_for_then_adopted',
  'resident_relaunched_after_first_run_dies_is_still_adopted',
  'resident_never_binding_gives_up_after_closed_limit_and_keeps_its_port_free',
  'resident_other_version_coexists_without_waiting_but_keeps_its_port',
  'resident_port_is_last_resort_when_nothing_else_is_usable',
  'no_resident_is_unchanged_no_wait_and_3001_first',
  'planner_for_home_reads_the_installed_resident_then_waits_and_keeps_its_port',
];

test('desktop boot port decision (adoption gate, resident wait, spawn port) passes its Rust tests on this OS', async t => {
  try { execFileSync('rustc', ['--version'], { stdio: 'pipe' }); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Rust compiler unavailable in Node-only environment'); return; } throw error; }
  const source = fileURLToPath(new URL('../src-tauri/src/boot_port.rs', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'argo-boot-port-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, process.platform === 'win32' ? 'boot-port.exe' : 'boot-port');
  execFileSync('rustc', ['--edition=2021', '--test', source, '-o', binary], { env: { ...process.env, CARGO_PKG_VERSION: '9.9.9' }, stdio: 'pipe' });
  const result = execFileSync(binary, [], { encoding: 'utf8', timeout: 60_000 });
  const declared = (await readFile(source, 'utf8')).match(/#\[test\]/g).length;
  assert.match(result, new RegExp(`test result: ok\\. ${declared} passed; 0 failed`), result);
  for (const name of LOCKED) assert.match(result, new RegExp(`tests::${name} \\.\\.\\. ok`), `${name} — 지워지거나 이름이 바뀌면 여기서 멈춘다`);
});

test('desktop shell wires the boot port decision without bypassing it', async () => {
  // 실제 셸 배선은 tauri 앱을 띄워야만 실행된다 — 행동 테스트가 닿지 않는 마지막 한 줄씩을 소스로 고정한다(행동은 위 Rust 테스트).
  const lib = (await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')).replace(/\/\/[^\n]*/g, '');
  assert.match(lib, /let mut planner = BootPlanner::for_home\(app\.path\(\)\.home_dir\(\)\.ok\(\)\);/, 'setup은 설치된 상주를 읽는 입구로 시작한다');
  assert.match(lib, /planner\.step\(Duration::ZERO, probe_port\)/);
  assert.match(lib, /planner\.settle\(probe_port, /);
  assert.equal((lib.match(/plan\.port\(/g) ?? []).length, 2, '첫 스폰과 즉사 폴백 모두 같은 계획으로 포트를 고른다');
  assert.doesNotMatch(lib, /pick_spawn_port|fn tcp_open|fn can_bind|const PORTS/, '포트 선택을 lib.rs에 다시 만들지 않는다');
  // 부팅 시작은 두 곳 — 바로 결정(setup)과 기다린 뒤 결정(대기 스레드). 하나라도 빠지면 그 경로의 사용자는 부트 화면에서 멈춘다(#874 2차 검수 LOW).
  assert.equal((lib.match(/start_boot\(&handle, boot\)/g) ?? []).length, 2, '부팅 시작 호출은 정확히 두 곳');
  assert.match(lib, /Some\(boot\) => start_boot\(&handle, boot\)/, 'setup에서 바로 결정된 부팅을 시작한다');
  assert.match(lib, /let boot = planner\.settle\([\s\S]*?\n\s*start_boot\(&handle, boot\);\n\s*\}\);/, '대기 스레드는 기다린 결정으로 부팅을 시작한다');
});
