// 윈도우 셸 백엔드(순수 판정) — 라우터·사다리·spawn 인자·MSYS 경로 정규화·자가 진단 폴백. 실제 실행은 native-engine.test(윈도우 CI)가 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCommand, shellCandidates, shellSpawn, normalizeMsysPaths, resolveShell, resetShellCache, isShellFallback, BUSYBOX_FILE } from '../src/engine/shell-backend.mjs';

test('라우터 — bash 문법은 sh, cmd 고유 문법은 cmd, 동사-명사는 powershell (2026-09-06 윈도우 시뮬 59건 기준)', () => {
  const sh = ['ls -la', 'pwd', 'cat package.json | head -5', 'grep -n "x" a.md', 'find . -name "*.json" | wc -l', 'git status && git log --oneline -1',
    'mkdir -p a/b && cd a/b && pwd', 'export FOO=1; echo "$FOO"', 'X=$(node -e "console.log(1)"); echo "$X"', "cat <<'EOF' > h.txt\nline\nEOF\ncat h.txt", "sed -n '1,3p' a",
    'test -f a && echo yes || echo no', '[ -d src ] && echo dir', 'for f in *.json; do echo "F:$f"; done', 'set -e; false; echo x', 'set -o pipefail; false | true',
    'date +%Y%m%d', 'printf "%s\\n" a b | sort', 'echo 100%', 'echo $HOME', 'type node', 'type -a git', 'command -v node', 'rmdir empty', 'powershell -Command "Get-Date -Format yyyy"', 'pwsh -c "1+1"',
    'findstr /i name package.json', 'where node', 'tasklist | head', 'start=1; echo $start', 'echo "dir listing"', 'cd src && ls', ''];
  for (const c of sh) assert.equal(classifyCommand(c), 'sh', c);
  const cmd = ['dir', 'dir /b', 'type package.json', 'type sim-out\\pkg.txt', 'type "a b.txt"', 'copy a.txt b.txt', 'del a.txt', 'erase a.txt', 'move a b', 'ren a b', 'rename a b', 'md x', 'rd x', 'cls', 'call build.bat', 'start .', 'mklink /D a b',
    'set FOO=1 && echo %FOO%', 'echo %USERPROFILE%', 'cd %USERPROFILE%\\Desktop', 'echo "%TEMP%"', 'rmdir /s /q build', 'cd src && dir /b | findstr mjs', 'ls; dir'];
  for (const c of cmd) assert.equal(classifyCommand(c), 'cmd', c);
  const ps = ['Get-ChildItem -Recurse', 'Get-Content a.txt', 'Get-Date -Format yyyy', 'Set-Location src'];
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

test('자가 진단 폴백 — 동봉 파일이 실행 안 되면(백신 격리·실행 거부) 다음 후보, 전부 없으면 cmd.exe + tried 사유; 폴백 판정은 스탠드얼론에서만', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-shell-')); await mkdir(join(root, 'bin')); await writeFile(join(root, 'bin', BUSYBOX_FILE), 'not-a-binary');
  resetShellCache();
  const bad = resolveShell({ platform: 'win32', env: {}, cwd: root, argv1: null, probe: () => 'EACCES', force: true });
  assert.equal(bad.kind, 'cmd'); assert.deepEqual(bad.tried.map((t) => `${t.kind}:${t.reason}`), ['busybox:EACCES']);
  assert.equal(isShellFallback(bad, { ARGO_STANDALONE: '1' }), true); assert.equal(isShellFallback(bad, {}), false, '개발 실행(동봉 없음)은 폴백이 아니다');
  resetShellCache();
  const ok = resolveShell({ platform: 'win32', env: {}, cwd: root, argv1: null, probe: () => true, force: true });
  assert.equal(ok.kind, 'busybox'); assert.deepEqual(ok.tried, []); assert.equal(isShellFallback(ok, { ARGO_STANDALONE: '1' }), false);
  const cached = resolveShell({ platform: 'win32', env: {}, cwd: root, argv1: null, probe: () => { throw new Error('probe must not run'); } });
  assert.equal(cached.kind, 'busybox', '프로세스당 1회 캐시');
  assert.deepEqual(resolveShell({ platform: 'darwin' }), { kind: 'sh', file: '/bin/sh', tried: [] });
  resetShellCache();
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

