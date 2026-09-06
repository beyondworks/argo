// 윈도우 셸 백엔드(순수 판정) — 라우터·사다리·spawn 인자·MSYS 경로 정규화·자가 진단 폴백. 실제 실행은 native-engine.test(윈도우 CI)가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCommand, stripDataText, shellCandidates, shellSpawn, normalizeMsysPaths, resolveShell, resetShellCache, isShellFallback, planShellRun, FALLBACK_RECHECK_MS, BUSYBOX_FILE } from '../src/engine/shell-backend.mjs';

test('라우터 — bash 문법은 sh, cmd 고유 문법은 cmd, 동사-명사는 powershell (2026-09-06 윈도우 시뮬 59건 기준)', () => {
  const sh = ['ls -la', 'pwd', 'cat package.json | head -5', 'grep -n "x" a.md', 'find . -name "*.json" | wc -l', 'git status && git log --oneline -1',
    'mkdir -p a/b && cd a/b && pwd', 'export FOO=1; echo "$FOO"', 'X=$(node -e "console.log(1)"); echo "$X"', "cat <<'EOF' > h.txt\nline\nEOF\ncat h.txt", "sed -n '1,3p' a",
    'test -f a && echo yes || echo no', '[ -d src ] && echo dir', 'for f in *.json; do echo "F:$f"; done', 'set -e; false; echo x', 'set -o pipefail; false | true',
    'date +%Y%m%d', 'printf "%s\\n" a b | sort', 'echo 100%', 'echo $HOME', 'type node', 'type -a git', 'command -v node', 'rmdir empty', 'powershell -Command "Get-Date -Format yyyy"', 'pwsh -c "1+1"',
    'findstr /i name package.json', 'where node', 'tasklist | head', 'start=1; echo $start', 'echo "dir listing"', 'cd src && ls', '',
    // 1R M2: 데이터(히어독 본문·따옴표 문자열) 속 cmd 동사·%VAR%는 명령이 아니다
    "cat > notes.md <<'EOF'\nStart the server with npm start\nEOF", "cat > README.md <<'EOF'\nCopy the config file first.\nEOF", "cat > run.bat <<'EOF'\n@echo off\ndir /b\nEOF",
    'git commit -m "refactor: split module; move helpers to utils"', 'git commit -m "chore: cleanup && move assets"', 'grep "%VERSION%" template.txt', "grep '%VERSION%' template.txt",
    'python -c "import time; start = time.time(); print(start)"', 'copy() { cp "$@"; }; copy a b', 'cut -d, -f2 <<< "x,y,z"', 'echo "type this"; ls',
    'git commit -m "feat: x\n\nMove helpers to utils\nStart the server"', 'grep "%VERSION%" template.txt']; // 2R N2: 여러 줄 따옴표 본문도 데이터 · 윈도우 환경변수가 아닌 템플릿 자리표시(%VERSION%)는 비운다
  for (const c of sh) assert.equal(classifyCommand(c), 'sh', c);
  const cmd = ['dir', 'dir /b', 'type package.json', 'type sim-out\\pkg.txt', 'type "a b.txt"', 'copy a.txt b.txt', 'del a.txt', 'erase a.txt', 'move a b', 'ren a b', 'rename a b', 'md x', 'rd x', 'cls', 'call build.bat', 'start .', 'mklink /D a b',
    'set FOO=1 && echo %FOO%', 'set FOO=1', 'SET FOO=1', 'set "FOO=1"', 'TYPE a.txt', 'echo %USERPROFILE%', 'cd %USERPROFILE%\\Desktop', 'echo %TEMP%', 'rmdir /s /q build', 'cd src && dir /b | findstr mjs', 'ls; dir', 'DIR /b',
    // 2R N1: 공백 든 윈도우 경로는 따옴표로 싼다 — 따옴표 안 `%VAR%\\경로` 모양은 남는다
    'cd "%USERPROFILE%\\Desktop"', 'mkdir "%USERPROFILE%\\Desktop\\New Folder"', 'echo "%USERPROFILE%" > out.txt', 'xcopy "%USERPROFILE%\\a" "b" /s', 'if exist "%USERPROFILE%\\x" (echo yes)', 'echo "%TEMP%"'];
  for (const c of cmd) assert.equal(classifyCommand(c), 'cmd', c);
  const ps = ['Get-ChildItem -Recurse', 'Get-Content a.txt', 'Get-Date -Format yyyy', 'Set-Location src', 'cd src && Get-ChildItem', 'Get-Date; Get-Location'];
  assert.equal(stripDataText("cat <<'EOF' > h\nmove me\nEOF\ntype x.txt"), "cat <<'' > h\ntype x.txt", '히어독 본문 제거·명령 줄 유지(종결자 따옴표는 데이터로 비워진다)'); assert.equal(stripDataText('type "a b.txt" && echo "hi"'), 'type "p.p" && echo ""');
  assert.equal(stripDataText('cd "%USERPROFILE%\\Desktop" && echo "%TEMP%" && grep "%VERSION%"'), 'cd "%p%\\p" && echo "%p%" && grep ""', '윈도우 환경변수·환경변수 경로 모양만 남고 템플릿 자리표시(%VERSION%)는 비운다'); assert.equal(stripDataText('git commit -m "a\nmove b"'), 'git commit -m ""', '여러 줄 따옴표');
  for (const c of ps) assert.equal(classifyCommand(c), 'powershell', c);
});

test('사다리 — ARGO_SHELL → 동봉(cwd·실행 파일 bin/) → Git Bash → cmd.exe, spawn 인자·cmd 그대로 전달', () => {
  const c = shellCandidates({ env: { ARGO_SHELL: 'D:\\x\\busybox64u.exe', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, cwd: 'D:\\app\\server', argv1: 'D:\\app\\server\\server.js' });
  assert.deepEqual(c.map((x) => x.kind), ['busybox', 'busybox', 'busybox', 'gitbash', 'gitbash', 'cmd']);
  assert.equal(c[0].file, 'D:\\x\\busybox64u.exe'); assert.ok(c[1].file.endsWith(join('server', 'bin', BUSYBOX_FILE))); assert.ok(c[3].file.endsWith(join('Git', 'bin', 'bash.exe')));
  assert.equal(shellCandidates({ env: {}, cwd: '/x', argv1: null }).at(-1).kind, 'cmd', 'cmd.exe는 항상 마지막');
  assert.deepEqual(shellSpawn('busybox', 'echo "a b"'), { args: ['sh', '-c', 'echo "a b"'], verbatim: false });
  assert.deepEqual(shellSpawn('cmd', 'echo "a b"'), { args: ['/d', '/s', '/c', '"echo "a b""'], verbatim: true }, 'cmd는 따옴표로 감싸 그대로(Node의 \\" 이스케이프를 cmd가 못 푼다)');
  assert.deepEqual(shellSpawn('powershell', 'Get-Date').args, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Date']);
  assert.deepEqual(shellSpawn('sh', 'ls').args, ['-c', 'ls']);
});

test('MSYS 경로 정규화 — /c/Users/x → C:/Users/x, URL·상대 경로는 그대로', () => {
  assert.equal(normalizeMsysPaths('/d/a/argo/argo\n'), 'D:/a/argo/argo\n');
  assert.equal(normalizeMsysPaths('HOME=/c/Users/me and "/c/x y"'), 'HOME=C:/Users/me and "C:/x y"');
  assert.equal(normalizeMsysPaths('http://host/c/y and ./c/z and /usr/bin'), 'http://host/c/y and ./c/z and /usr/bin');
});

test('자가 진단 폴백 — 동봉 파일이 실행 안 되면(백신 격리·실행 거부) 다음 후보, 전부 없으면 cmd.exe + tried 사유; 폴백 판정은 스탠드얼론에서만; 폴백이면 10분마다 재진단', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-shell-')); await mkdir(join(root, 'bin')); await writeFile(join(root, 'bin', BUSYBOX_FILE), 'not-a-binary');
  const T0 = 1_800_000_000_000; resetShellCache();
  const bad = await resolveShell({ platform: 'win32', env: {}, cwd: root, argv1: null, probe: async () => 'EACCES', now: T0 });
  assert.equal(bad.kind, 'cmd'); assert.deepEqual(bad.tried.map((t) => `${t.kind}:${t.reason}`), ['busybox:EACCES']);
  assert.equal(isShellFallback(bad, { ARGO_STANDALONE: '1' }), true); assert.equal(isShellFallback(bad, {}), false, '개발 실행(동봉 없음)은 폴백이 아니다');
  let probes = 0;
  assert.equal((await resolveShell({ platform: 'win32', env: {}, cwd: root, argv1: null, probe: async () => { probes += 1; return true; }, now: T0 + FALLBACK_RECHECK_MS - 1 })).kind, 'cmd', '재진단 간격 전엔 캐시'); assert.equal(probes, 0);
  const back = await resolveShell({ platform: 'win32', env: {}, cwd: root, argv1: null, probe: async () => { probes += 1; return true; }, now: T0 + FALLBACK_RECHECK_MS });
  assert.equal(back.kind, 'busybox', '폴백 상태는 10분 뒤 재진단 — 백신 예외·재설치 뒤 재시작 없이 복구(1R L3)'); assert.equal(probes, 1);
  assert.equal((await resolveShell({ platform: 'win32', env: {}, cwd: root, argv1: null, probe: async () => { throw new Error('probe must not run'); }, now: T0 + 10 * FALLBACK_RECHECK_MS })).kind, 'busybox', '동봉이 잡히면 프로세스당 1회');
  assert.deepEqual(await resolveShell({ platform: 'darwin' }), { kind: 'sh', file: '/bin/sh', tried: [] });
  resetShellCache();
});

test('실행 계획(planShellRun) — 비윈도우 /bin/sh, 윈도우 라우팅별 실행기·인자·verbatim·정규화·폴백 플래그(runBash 배선의 단일 원천, 1R L2)', async () => {
  const mac = await planShellRun('ls', { platform: 'darwin' }); assert.deepEqual([mac.kind, mac.file, mac.args, mac.verbatim, mac.normalize, mac.fallback], ['sh', '/bin/sh', ['-c', 'ls'], false, false, false]);
  const root = await mkdtemp(join(tmpdir(), 'argo-plan-')); const bb = join(root, 'busybox64u.exe'); await writeFile(bb, 'x'); const gb = join(root, 'bash.exe'); await writeFile(gb, 'x');
  resetShellCache();
  const cmd = await planShellRun('dir /b', { platform: 'win32', env: { ARGO_SHELL: bb, ARGO_STANDALONE: '1' }, probe: async () => { throw new Error('cmd 라우트는 진단 없음'); } });
  assert.deepEqual([cmd.kind, cmd.file, cmd.verbatim, cmd.fallback, cmd.args.at(-1)], ['cmd', 'cmd.exe', true, false, '"dir /b"']);
  const ps = await planShellRun('Get-Date', { platform: 'win32', env: { ARGO_SHELL: bb } }); assert.deepEqual([ps.kind, ps.file, ps.args[0]], ['powershell', 'powershell.exe', '-NoProfile']);
  const ok = await planShellRun('ls', { platform: 'win32', env: { ARGO_SHELL: bb, ARGO_STANDALONE: '1' }, cwd: root, argv1: null, probe: async () => true, force: true });
  assert.deepEqual([ok.kind, ok.file, ok.args, ok.normalize, ok.fallback], ['busybox', bb, ['sh', '-c', 'ls'], false, false]);
  const gitbash = await planShellRun('pwd', { platform: 'win32', env: { ARGO_SHELL: gb, ARGO_STANDALONE: '1' }, cwd: root, argv1: null, probe: async () => true, force: true });
  assert.deepEqual([gitbash.kind, gitbash.normalize, gitbash.fallback, gitbash.args], ['gitbash', true, true, ['-c', 'pwd']], 'Git Bash면 출력 정규화 + 스탠드얼론 폴백 표시');
  const fb = await planShellRun('ls', { platform: 'win32', env: { ARGO_SHELL: bb, ARGO_STANDALONE: '1' }, cwd: root, argv1: null, probe: async () => 'EACCES', force: true });
  assert.deepEqual([fb.kind, fb.verbatim, fb.fallback, fb.tried.map((t) => t.reason)], ['cmd', true, true, ['EACCES', 'missing']], 'ARGO_SHELL 거부 → cwd/bin 동봉 없음 → cmd');
  resetShellCache();
});

test('폴백 알림기 — 회사당 프로세스 1회, tried 사유 동봉, 적재 실패는 삼킴(1R L2)', async () => {
  const { makeShellFallbackNoter } = await import('../src/engine/native-query.mjs');
  const calls = []; const noter = makeShellFallbackNoter(async (ws, ev) => { calls.push([ws, ev]); }, new Set());
  const plan = { kind: 'cmd', file: 'cmd.exe', tried: [{ kind: 'busybox', reason: 'EACCES' }, { kind: 'gitbash', reason: 'missing' }] };
  noter('c1')(plan); noter('c1')(plan); noter('c2')(plan);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0][1], { type: 'shell-fallback', ok: false, kind: 'cmd', file: 'cmd.exe', tried: ['busybox: EACCES', 'gitbash: missing'] });
  const bad = makeShellFallbackNoter(async () => { throw new Error('disk'); }, new Set()); assert.doesNotThrow(() => bad('c3')(plan));
});

test('동봉 다운로드 — 해시 고정(불일치 throw), 일시 장애 재시도(2회 실패 뒤 성공), 같은 해시 파일이 있으면 재다운로드 없음, 로컬 경로', async () => {
  const { fetchBusybox, BUSYBOX_SHA256, VENDOR_DIR, BUSYBOX_FILE: BB } = await import('../scripts/fetch-busybox.mjs');
  const { createHash } = await import('node:crypto'); const { readFileSync } = await import('node:fs');
  assert.equal(createHash('sha256').update(readFileSync(join(VENDOR_DIR, BB))).digest('hex'), BUSYBOX_SHA256, '레포 동봉본(vendor/)이 고정 해시와 일치 — 바꿀 땐 상수·파일을 함께');
  const dir = await mkdtemp(join(tmpdir(), 'argo-busybox-')); const noVendor = join(dir, 'no-vendor'); // 다운로드 갈래 검증용(동봉본 없는 상황)
  const body = Buffer.from('fake-busybox-binary'); const good = createHash('sha256').update(body).digest('hex');
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }); return { ok: true, arrayBuffer: async () => body }; };
  const r = await fetchBusybox(dir, { sha256: good, fetchImpl: flaky, localPath: null, vendorDir: noVendor, waitMs: 1 });
  assert.equal(calls, 3, '2회 실패 뒤 3회째 성공'); assert.equal(r.bytes, body.length); assert.equal(r.cached, false);
  const r2 = await fetchBusybox(dir, { sha256: good, fetchImpl: async () => { throw new Error('must not download'); }, localPath: null, vendorDir: noVendor });
  assert.equal(r2.cached, true, '같은 해시 파일이 있으면 배포 서버를 두드리지 않는다');
  await assert.rejects(fetchBusybox(join(dir, 'other'), { sha256: 'deadbeef', fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }), localPath: null, vendorDir: noVendor }), /해시 불일치/);
  await assert.rejects(fetchBusybox(join(dir, 'other2'), { sha256: good, fetchImpl: async () => { throw new Error('down'); }, localPath: null, vendorDir: noVendor, attempts: 2, waitMs: 1 }), /다운로드 실패\(2회\)/);
  const local = join(dir, 'local.exe'); await writeFile(local, body);
  assert.equal((await fetchBusybox(join(dir, 'other3'), { sha256: good, localPath: local, vendorDir: noVendor, fetchImpl: async () => { throw new Error('must not download'); } })).bytes, body.length, 'ARGO_BUSYBOX_PATH 오프라인');
  assert.equal((await fetchBusybox(join(dir, 'other4'), { localPath: null, fetchImpl: async () => { throw new Error('must not download'); } })).bytes, 675840, '동봉본 우선 — 네트워크 없음');
});

test('자가 진단 동시성·타임아웃·배선 — 동시 첫 호출은 프로브 1회 공유(2R N3), 멈춘 후보는 2초 상한(N4), runBash가 폴백을 알림기에 넘긴다(N5)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-shell-cc-')); const bb = join(root, 'busybox64u.exe'); await writeFile(bb, 'x');
  resetShellCache(); let probes = 0;
  const slow = async () => { probes += 1; await new Promise((r) => setTimeout(r, 60)); return true; };
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => resolveShell({ platform: 'win32', env: { ARGO_SHELL: bb }, cwd: root, argv1: null, probe: slow })));
  assert.equal(probes, 1, '동시 5건 → 프로브 1회'); assert.deepEqual(rs.map((r) => r.kind), ['busybox', 'busybox', 'busybox', 'busybox', 'busybox']);
  // 멈춘 후보(실행은 되지만 응답이 없는 exe — 백신이 첫 실행을 잡는 상황) → 2초 상한 뒤 다음 후보
  const hang = join(root, 'hang-bash'); await writeFile(hang, '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
  resetShellCache(); const t0 = Date.now();
  const r = await resolveShell({ platform: 'win32', env: { ARGO_SHELL: hang }, cwd: root, argv1: null, force: true });
  assert.equal(r.kind, 'cmd'); assert.deepEqual(r.tried.map((t) => t.reason), ['timeout', 'missing']); assert.ok(Date.now() - t0 < 4000, `상한 2초(실측 ${Date.now() - t0}ms)`);
  // runBash 배선: 스탠드얼론에서 폴백이면 onShellFallback(plan) — 맥에서 platform 주입으로 핀
  const { builtinRunners } = await import('../src/engine/builtin-tools.mjs');
  resetShellCache(); const seen = [];
  const t = builtinRunners({ cwd: root, env: { PATH: process.env.PATH, ARGO_SHELL: join(root, 'nope.exe'), ARGO_STANDALONE: '1' }, platform: 'win32', onShellFallback: (plan) => seen.push(plan) });
  await t.Bash({ command: 'ls' }); // cmd.exe가 없는 맥에선 spawn error로 끝난다 — 여기선 배선만 본다
  assert.equal(seen.length, 1); assert.equal(seen[0].kind, 'cmd'); assert.equal(seen[0].fallback, true); assert.ok(seen[0].tried.length >= 2 && seen[0].tried.every((x) => x.reason === 'missing'), 'ARGO_SHELL·cwd bin·실행 파일 bin 전부 없음');
  resetShellCache();
});

