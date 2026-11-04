import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 셸 자동 업데이트(2026-11-04) — "언제 설치하나" 판단(src-tauri/src/auto_update_policy.rs)을 rustc로 따로 컴파일해 그 안의 Rust 테스트를 돌린다.
// 본체 crate의 cargo test는 CI에서 돌지 않아서, 판단 규칙은 이 테스트로만 CI(macOS·Windows)에 잠긴다(boot_port.rs와 같은 방식).
const LOCKED = [
  'installs_when_nothing_runs_or_no_server',
  'running_work_always_defers_even_after_days',
  'unknown_work_defers_until_grace_then_installs',
  'window_in_use_defers_until_grace',
  'disabled_and_location_skip_before_anything_else',
  'webview_install_claim_defers_auto_install',
  'switch_env_overrides_file_and_build_default_is_on',
  'mac_location_problems_block_and_others_do_not',
  'busy_response_is_read_strictly',
  'probe_tells_no_server_unknown_and_answers_apart',
];

test('auto update decision (when to install) passes its Rust tests on this OS', async t => {
  try { execFileSync('rustc', ['--version'], { stdio: 'pipe' }); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Rust compiler unavailable in Node-only environment'); return; } throw error; }
  const source = fileURLToPath(new URL('../src-tauri/src/auto_update_policy.rs', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'argo-auto-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, process.platform === 'win32' ? 'auto-update.exe' : 'auto-update');
  execFileSync('rustc', ['--edition=2021', '--test', source, '-o', binary], { stdio: 'pipe' });
  const result = execFileSync(binary, [], { encoding: 'utf8', timeout: 60_000 });
  const declared = (await readFile(source, 'utf8')).match(/#\[test\]/g).length;
  assert.match(result, new RegExp(`test result: ok\\. ${declared} passed; 0 failed`), result);
  for (const name of LOCKED) assert.match(result, new RegExp(`tests::${name} \\.\\.\\. ok`), `${name} — 지워지거나 이름이 바뀌면 여기서 멈춘다`);
});

test('desktop shell wires the auto update without bypassing the decision', async () => {
  // 실제 배선은 tauri 앱을 띄워야만 실행된다 — 행동 테스트가 닿지 않는 마지막 한 줄씩을 소스로 고정한다(판단은 위 Rust 테스트).
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '');
  const lib = strip(await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'));
  const glue = strip(await readFile(new URL('../src-tauri/src/auto_update.rs', import.meta.url), 'utf8'));
  assert.match(lib, /#\[cfg\(desktop\)\]\s*\{[^}]*tauri_plugin_updater::Builder::new\(\)\.build\(\)[\s\S]*?auto_update::start\(app\.handle\(\)\.clone\(\)\);/, '업데이터 플러그인을 등록한 뒤 자동 업데이트를 시작한다');
  assert.match(lib, /auto_update::update_install_claim, auto_update::update_install_release/, '웹뷰 설치 잠금 명령을 등록한다');
  assert.match(lib, /Boot::Adopt\(p\) => \{\s*auto_update::set_server_port\(p\);/, '입양한 서버에도 작업 중 여부를 묻는다');
  assert.match(lib, /tried\.push\(port\);\s*auto_update::set_server_port\(port\);/, '띄운 사이드카(즉사 폴백 포함)에 묻는다');
  // 설치는 decide()가 Install일 때만, 설치 전에 잠금을 잡는다
  assert.equal((glue.match(/\.install\(/g) ?? []).length, 1, '설치 호출은 한 곳');
  assert.match(glue, /Decision::Install => install\(app, st\)/);
  assert.match(glue, /fn install\(app: &AppHandle, st: &mut State\) -> Duration \{\s*if !claim\(Holder::Auto\) \{/);
  assert.match(glue, /claimed_elsewhere: held_by_other\(Holder::Auto\)/, '웹뷰가 설치 중이면 판단에 넣는다');
  assert.match(glue, /blocks_auto_install\(\)/, '맥 설치 위치 문제를 판단에 넣는다');
  assert.match(glue, /policy::probe_work\(/, '작업 중 여부를 서버에 묻는다');
  assert.doesNotMatch(glue, /download_and_install/, '받기와 설치를 나눠 받아 둔 채 작업이 끝나기를 기다린다');
});

test('the sidecar answers the busy question from the process-wide turn registry', async () => {
  const { registerTurn, activeTurnCount } = await import('../src/turn-abort.mjs');
  const route = await import('../app/api/app-busy/route.js');
  const read = async () => (await route.GET()).json();
  const base = activeTurnCount();
  assert.deepEqual(await read(), { busy: base > 0, turns: base });
  const a = registerTurn('ws-auto-update', 'pepper', () => {}, { source: 'messenger' });
  const b = registerTurn('ws-auto-update', 'pepper', () => {}, { source: 'chat' });
  const c = registerTurn('ws-other', 'kai', () => {}, { source: 'routine' });
  assert.deepEqual(await read(), { busy: true, turns: base + 3 });
  a.release(); b.release();
  assert.deepEqual(await read(), { busy: true, turns: base + 1 });
  c.release();
  assert.deepEqual(await read(), { busy: base > 0, turns: base });
  const res = await route.GET();
  assert.equal(res.headers.get('access-control-allow-origin'), null, '다른 사이트가 읽지 못하게 CORS를 열지 않는다');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the busy route is reachable without a session cookie (the shell has none)', async () => {
  const mw = await readFile(new URL('../middleware.js', import.meta.url), 'utf8');
  assert.match(mw, /const isPublic = [^\n]*p === '\/api\/app-busy'/);
});
