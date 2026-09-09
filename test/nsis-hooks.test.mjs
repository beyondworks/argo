// 윈도우 NSIS 훅 — 업데이트 직전 실행 중인 앱·사이드카를 죽이는 훅의 계약을 잠근다.
// 실사고 1(2026-08-22 VM 실측): 메인 바이너리는 크레이트명 app.exe인데 훅은 argo.exe를 죽여 무효과 —
//   잠긴 파일 위로 설치가 진행돼 "업데이트 후 실행 파일 없음"(정@규, 08-20).
// 실사고 2(2026-08-27, v0.1.48 업데이트 설치 정지): nsExec가 powershell 자식을 무기한 대기 + /T(트리킬)가
//   구버전 앱이 띄운 설치기 자신을 죽일 수 있는 구조 → 훅은 ①무기한 대기 금지(분리 실행) ②트리킬 금지
//   ③무로그(taskkill '프로세스 없음'이 설치 화면에 오류로 오인 노출) 계약으로 전환.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const s = await readFile(new URL('../src-tauri/windows/hooks.nsh', import.meta.url), 'utf8');

test('hooks.nsh — 설치·제거는 같은 정확한 경로 정리를 호출한다', () => {
  for (const name of ['PREINSTALL', 'PREUNINSTALL']) {
    assert.match(s, new RegExp(`!macro NSIS_HOOK_${name}\\s+!insertmacro ARGO_STOP_INSTALLED_PROCESSES`));
  }
  assert.match(s, /StrCpy \$2 "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/);
  assert.match(s, /StrCpy \$3 "\$INSTDIR\\node\.exe"/);
  assert.doesNotMatch(s, /taskkill|\s-like\s|Stop-Process\s+-Name/i);
  assert.match(s, /\$\$targets -contains \$\$_\.ExecutablePath/);
});

test('hooks.nsh — 경로는 프로세스 환경으로 전달하고 정리 후 복원한다', () => {
  for (const [name, saved, value] of [['MAIN', 0, 2], ['NODE', 1, 3]]) {
    assert.match(s, new RegExp(`ReadEnvStr \\$${saved} "ARGO_NSIS_${name}_EXE"`));
    assert.ok(s.includes(`SetEnvironmentVariableW(w "ARGO_NSIS_${name}_EXE", w r${value})`));
    assert.ok(s.includes(`SetEnvironmentVariableW(w "ARGO_NSIS_${name}_EXE", w r${saved})`));
  }
  const command = s.split('\n').find((line) => /nsExec::Exec .*powershell/.test(line));
  assert.ok(command);
  assert.match(command, /Get-CimInstance Win32_Process/);
  assert.doesNotMatch(command, /Get-Process/);
  assert.doesNotMatch(command, /\$INSTDIR/);
  assert.match(command, /cmd \/c start/);
  assert.match(s, /Sleep 1500/);
  assert.doesNotMatch(s, /ExecToLog|taskkill[^\n]*\/T\b/);
});

// Windows CI에서도 실제 격리 프로세스로 확인한다. 현재 Node나 사용자 앱은 종료 대상에 넣지 않는다.
test('hooks.nsh — Windows에서 특수문자 경로만 종료하고 다른 app.exe·node.exe를 보존한다', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-nsis-'));
  const target = join(root, "Argo O'Brien [review]");
  const foreign = join(root, "Argo O'Brien r");
  const children = [];
  try {
    for (const dir of [target, foreign]) {
      await mkdir(dir);
      for (const name of ['app.exe', 'node.exe']) {
        const exe = join(dir, name);
        await copyFile(process.execPath, exe);
        const child = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        children.push(child);
        await once(child, 'spawn');
      }
    }
    const payload = s.match(/-Command "([^\n]+)"'/)[1].replaceAll('$$', '$');
    const powershell = join(process.env.WINDIR, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const cleanup = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', payload], {
      stdio: 'ignore',
      env: { ...process.env, ARGO_NSIS_MAIN_EXE: join(target, 'app.exe'), ARGO_NSIS_NODE_EXE: join(target, 'node.exe') },
    });
    const [code] = await once(cleanup, 'exit');
    assert.equal(code, 0);
    for (let i = 0; i < 50 && children.slice(0, 2).some((c) => c.exitCode === null); i++) await delay(100);
    assert.ok(children.slice(0, 2).every((c) => c.exitCode !== null), '설치 경로의 두 프로세스는 종료되어야 한다');
    assert.ok(children.slice(2).every((c) => c.exitCode === null), '다른 경로의 동명 프로세스는 살아 있어야 한다');
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
