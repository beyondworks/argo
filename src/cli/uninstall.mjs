// argo uninstall — 단독 설치(install.sh 맥·리눅스 계정 모드, install.ps1)가 만든 것만 지운다(2026-10-06 유건 승인):
// 프로그램 폴더, 표식이 있는 우리 argo 명령, (윈도우) 우리가 넣은 사용자 PATH 항목. 데이터(~/.argo — 회사·대화·로그인)는 남긴다.
// 대상 판정은 설치 스크립트가 프로그램 폴더에 남긴 .argo-install.json뿐이다 — 앱·저장소·--local 설치에는 없어 지우지 않는다.
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const STANDALONE_MARK = 'argo-cli-shim v1 argo-selfhost';
export function standaloneRecord(appDir) {
  try { const r = JSON.parse(readFileSync(join(appDir, '.argo-install.json'), 'utf8')); return r?.kind === 'standalone' ? r : null; } catch { return null; }
}
/** argo service install이 만드는 상주 파일(리눅스 systemd·맥 launchd) — 있으면 그 상주가 지울 프로그램을 가리키므로 먼저 해제해야 한다. */
export const serviceFiles = (home = homedir()) => [join(home, '.config', 'systemd', 'user', 'argo-cli.service'), join(home, 'Library', 'LaunchAgents', 'com.beyondworks.argo-cli.plist')];
const ourShim = (f) => { try { return readFileSync(f, 'utf8').slice(0, 512).includes(STANDALONE_MARK); } catch { return false; } };

// 윈도우: 실행 중인 node.exe가 프로그램 폴더 안이라 이 프로세스는 지울 수 없다. 지울 값을 박은 스크립트를 임시 폴더에 쓰고
// 종료 코드 WIN_UNINSTALL_EXIT로 끝내면, argo.cmd가 node가 끝난 뒤 같은 창에서 그 스크립트를 실행한다(install.ps1이 만든 argo.cmd).
// 숨긴 분리 프로세스로 지우던 방식은 Windows CI에서 실행되지 않았다(같은 인자의 동기 실행은 지워짐 — 10/6 실측).
// 파일은 UTF-8 BOM — PowerShell 5.1은 BOM 없는 파일을 ANSI로 읽어 한글 사용자 이름이 든 경로가 깨진다.
// argo.cmd에서 실행하면(ARGO_UNINSTALL_FROM_CMD) argo.cmd와 빈 폴더는 남겨 두고 argo.cmd가 마지막에 스스로 지운다 — 실행 중인 배치 파일과 그 폴더를
// 먼저 지우면 cmd가 돌아와 경로를 못 찾아 오류 두 줄·종료 코드 1을 냈다(제거는 끝났는데도, Windows CI 10/6 실측).
// 지우기 전 확인(검수 #843 M3): 프로그램 폴더는 설치 기록이 있는 폴더만, shim은 표식 있는 argo.cmd만, 레지스트리는 HKCU 아래의 …Environment 키만.
export const WIN_UNINSTALL_EXIT = 77;
export const WIN_UNINSTALL_SCRIPT = 'argo-uninstall.ps1';
const WIN_BODY = `if (-not (Test-Path -LiteralPath (Join-Path $AppDir '.argo-install.json'))) { return }
for ($i = 0; $i -lt 40 -and (Test-Path -LiteralPath $AppDir); $i++) { try { Remove-Item -LiteralPath $AppDir -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500 } }
if (-not $env:ARGO_UNINSTALL_FROM_CMD -and $Shim -and $Shim.EndsWith('\\argo.cmd') -and (Test-Path -LiteralPath $Shim) -and ((Get-Content -LiteralPath $Shim -TotalCount 3) -join ' ') -match 'argo-cli-shim v1 argo-selfhost') { Remove-Item -LiteralPath $Shim -Force -ErrorAction SilentlyContinue }
if ($PathEntry -and $EnvKey -match '^HKCU:\\\\(.+\\\\)?Environment$' -and (Test-Path $EnvKey)) {
  $k = Get-Item -Path $EnvKey
  $raw = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $all = @($raw -split ';' | Where-Object { $_ -ne '' })
  $keep = @($all | Where-Object { $_.TrimEnd('\\') -ine $PathEntry.TrimEnd('\\') })
  if ($keep.Count -ne $all.Count) {
    Set-ItemProperty -Path $EnvKey -Name Path -Value ($keep -join ';') -Type ExpandString
    try {
      if (-not ('ArgoEnv' -as [type])) { Add-Type -Namespace '' -Name ArgoEnv -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);' }
      $r = [UIntPtr]::Zero; [void][ArgoEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
    } catch {}
  }
}
$base = Split-Path -Parent $AppDir
if (-not $env:ARGO_UNINSTALL_FROM_CMD) { foreach ($d in @((Join-Path $base 'bin'), $base)) { if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue } } }
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;
/** 지울 값을 PowerShell 작은따옴표 문자열로 박는다 — 유니코드 작은따옴표(‘’‚‛)도 PowerShell은 따옴표로 읽어 두 번 쓴다. */
export function winUninstallScript({ appDir, shim, pathEntry, envKey }) {
  const q = (v) => `'${String(v ?? '').replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`;
  return `\ufeff$AppDir = ${q(appDir)}\n$Shim = ${q(shim)}\n$PathEntry = ${q(pathEntry)}\n$EnvKey = ${q(envKey ?? 'HKCU:\\Environment')}\n${WIN_BODY}`;
}

/** 반환: { ok:false, reason:'not-standalone'|'service', file? } 또는 { ok:true, removed:[…] } — 윈도우는 { pending:true, script }(argo.cmd가 종료 뒤 실행). */
export function uninstallStandalone({ appDir, home = homedir(), platform = process.platform, tmp = tmpdir() }) {
  const rec = standaloneRecord(appDir);
  if (!rec) return { ok: false, reason: 'not-standalone' };
  const svc = serviceFiles(home).find((f) => existsSync(f));
  if (svc) return { ok: false, reason: 'service', file: svc };
  const shim = rec.shim && ourShim(rec.shim) ? rec.shim : null; // 표식이 없으면(사용자가 바꿔 둠) 남의 파일로 보고 그대로 둔다
  if (platform === 'win32') {
    const script = join(tmp, WIN_UNINSTALL_SCRIPT);
    writeFileSync(script, winUninstallScript({ appDir, shim, pathEntry: rec.pathEntry, envKey: rec.envKey }), 'utf8');
    return { ok: true, pending: true, script, removed: [appDir, shim, rec.pathEntry].filter(Boolean) };
  }
  if (shim) rmSync(shim, { force: true });
  rmSync(appDir, { recursive: true, force: true });
  return { ok: true, removed: [appDir, shim].filter(Boolean) };
}
