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
  // 줄 첫머리의 속성만 센다 — 주석 안의 '#[test]' 글자(파일 머리 설명)는 시험이 아니다
  const declared = (await readFile(source, 'utf8')).match(/^\s*#\[test\]\s*$/gm).length;
  assert.equal(declared, LOCKED.length, '잠근 시험 목록과 선언한 시험 수가 같다');
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
  assert.match(glue, /match policy::decide\(&facts\(app, st, enabled, location_blocked\)\) \{\s*Decision::Install => \{\}/, '설치는 decide가 Install일 때만');
  assert.match(glue, /if !claim\(Holder::Auto\) \{\s*return policy::RETRY_DEFERRED;\s*\}\s*if st\.bytes\.is_none\(\)/, '받기·설치 전에 잠금을 잡는다');
  assert.match(glue, /let Decision::Defer\(why\) \| Decision::Skip\(why\) = policy::decide\(&facts\(/, '받는 사이 작업이 시작됐으면 다시 미룬다');
  assert.equal((glue.match(/install\(app, st\)/g) ?? []).length, 1, '설치 함수 호출은 판단 뒤 한 곳');
  assert.match(glue, /claimed_elsewhere: held_by_other\(Holder::Auto\)/, '웹뷰가 설치 중이면 판단에 넣는다');
  assert.match(glue, /blocks_auto_install\(\)/, '맥 설치 위치 문제를 판단에 넣는다');
  assert.match(glue, /policy::probe_work\(/, '작업 중 여부를 서버에 묻는다');
  assert.doesNotMatch(glue, /download_and_install/, '받기와 설치를 나눠 받아 둔 채 작업이 끝나기를 기다린다');
  assert.match(glue, /\.updater_builder\(\)\s*\.timeout\(AUTO_DOWNLOAD_TIMEOUT\)/, '셸 내려받기에는 시간 상한이 있다(걸린 연결이 잠금을 쥐지 않게)');
  assert.match(glue, /let waiting = st\.found_since/, '창 사용 중 상한은 같은 버전을 처음 찾은 시각부터 센다');
  assert.doesNotMatch(glue, /ready: Option<\(Update, Vec<u8>/, '파일은 설치하기로 정한 순간에만 받는다(며칠씩 메모리에 들고 있지 않는다)');
});

test('the sidecar answers the busy question from the process-wide turn registry', async () => {
  const { registerTurn, activeTurnCount } = await import('../src/turn-abort.mjs');
  const route = await import('../app/api/app-busy/route.js');
  const read = async () => { const { busy, turns } = await (await route.GET()).json(); return { busy, turns }; }; // 등록부 칸만 본다(상태 파일·단발은 아래 시험)
  const base = activeTurnCount();
  assert.equal((await read()).turns, base);
  const a = registerTurn('ws-auto-update', 'pepper', () => {}, { source: 'messenger' });
  const b = registerTurn('ws-auto-update', 'pepper', () => {}, { source: 'chat' });
  const c = registerTurn('ws-other', 'kai', () => {}, { source: 'routine' });
  assert.deepEqual(await read(), { busy: true, turns: base + 3 });
  a.release(); b.release();
  assert.deepEqual(await read(), { busy: true, turns: base + 1 });
  c.release();
  assert.equal((await read()).turns, base);
  const res = await route.GET();
  assert.equal(res.headers.get('access-control-allow-origin'), null, '다른 사이트가 읽지 못하게 CORS를 열지 않는다');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const prev = process.env.ARGO_TENANT_OWNER;
  process.env.ARGO_TENANT_OWNER = 'tenant-owner';
  try { assert.equal((await route.GET()).status, 404, '호스팅 테넌트 워커에서는 닫는다'); }
  finally { if (prev === undefined) delete process.env.ARGO_TENANT_OWNER; else process.env.ARGO_TENANT_OWNER = prev; }
});

test('the busy route is reachable without a session cookie (the shell has none)', async () => {
  const mw = await readFile(new URL('../middleware.js', import.meta.url), 'utf8');
  assert.match(mw, /const isPublic = [^\n]*p === '\/api\/app-busy'/);
});

// 검수 I-1(2026-11-04): 원격 출처(localhost 화면)의 앱 명령은 build.rs 매니페스트 + capability 권한에 있어야만 허용된다.
// 빠지면 invoke가 거부되고, 훅은 그것을 '옛 셸'로 보아 잠금 없이 설치한다 — 셸 자동 설치와 동시에 돌 수 있다(save_download 2026-09-17 사고와 같은 원인).
test('install lock commands are registered, in the app manifest and permitted on the remote app origin', async () => {
  const source = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const build = await readFile(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
  const capability = JSON.parse(await readFile(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  const manifest = build.match(/AppManifest::new\(\)\.commands\(&\[([^\]]*)\]\)/)?.[1] ?? '';
  for (const command of ['update_install_claim', 'update_install_release']) {
    assert.match(source, new RegExp(`generate_handler!\\[[^\\]]*\\b${command}\\b`), `${command} invoke_handler 등록`);
    assert.ok(manifest.includes(`"${command}"`), `${command}이 build.rs AppManifest에 없다`);
    assert.ok(capability.permissions.includes(`allow-${command.replaceAll('_', '-')}`), `${command} 권한이 capability에 없다`);
  }
  assert.ok(capability.remote?.urls?.includes('http://localhost:3001'), '화면은 원격 출처(localhost)다');
});

// 검수 I-2: 실행 등록부는 프로세스마다 따로다 — 앱과 같은 폴더를 쓰는 argo CLI(ARGO_CLI_APP=1)의 턴은 상태 파일로만 보인다.
test('busy counts a fresh turn status file written by another process, and one-shot runs', async t => {
  const { mkdtemp: mk, mkdir, writeFile } = await import('node:fs/promises');
  const { freshTurnStatusCount } = await import('../src/turn-status.mjs');
  const { beginOneShot, activeOneShotCount } = await import('../src/turn-abort.mjs');
  const root = await mk(join(tmpdir(), 'argo-busy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  await mkdir(join(root, 'acme', 'chats'), { recursive: true });
  await mkdir(join(root, 'beta', 'chats'), { recursive: true });
  assert.equal(await freshTurnStatusCount({ root, now }), 0, '상태 파일이 없으면 0');
  // 다른 프로세스(CLI)가 쓴 신선한 파일 — pid가 이 프로세스가 아니다
  await writeFile(join(root, 'acme', 'chats', 'pepper.status.json'), JSON.stringify({ stage: 'think', ts: now - 5_000, pid: process.pid + 1 }));
  // 2분 넘게 갱신이 없는 잔재(죽은 턴)는 세지 않는다
  await writeFile(join(root, 'beta', 'chats', 'kai.status.json'), JSON.stringify({ stage: 'think', ts: now - 121_000, pid: 1 }));
  await writeFile(join(root, 'beta', 'chats', 'kai.json'), JSON.stringify({ messages: [] }));
  assert.equal(await freshTurnStatusCount({ root, now }), 1);
  assert.equal(await freshTurnStatusCount({ root, now: now + 120_000 }), 0, '신선 창(120초)이 지나면 세지 않는다');
  const base = activeOneShotCount();
  const done = beginOneShot();
  assert.equal(activeOneShotCount(), base + 1, '야간 기억 정리 같은 단발 실행도 센다');
  done(); done();
  assert.equal(activeOneShotCount(), base, '끝내기를 두 번 불러도 한 번만 뺀다');
});

test('the busy route reports busy for another process turn file (actual route, ARGO_ROOT)', async t => {
  const { mkdtemp: mk, mkdir, writeFile } = await import('node:fs/promises');
  const root = await mk(join(tmpdir(), 'argo-busy-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'acme', 'chats'), { recursive: true });
  await writeFile(join(root, 'acme', 'chats', 'pepper.status.json'), JSON.stringify({ stage: 'think', ts: Date.now(), pid: process.pid + 1 }));
  const { execFileSync: run } = await import('node:child_process');
  // WS_ROOT는 임포트 때 정해진다 — 새 프로세스에서 ARGO_ROOT로 실제 라우트를 부른다
  const route = new URL('../app/api/app-busy/route.js', import.meta.url).href;
  const out = run(process.execPath, ['--input-type=module', '-e', `const r = await import(${JSON.stringify(route)}); console.log(JSON.stringify(await (await r.GET()).json()));`], { env: { ...process.env, ARGO_ROOT: root, ARGO_TENANT_OWNER: '' }, encoding: 'utf8' });
  const body = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(body.busy, true);
  assert.equal(body.turns, 0, '이 프로세스의 등록부에는 없다');
  assert.equal(body.statusFiles, 1);
});
