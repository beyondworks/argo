// argo uninstall — 단독 설치(install.sh 맥·리눅스 계정 모드, install.ps1)가 만든 것만 지운다(2026-10-06 유건 승인):
// 프로그램 폴더, 표식이 있는 우리 argo 명령, (윈도우) 우리가 넣은 사용자 PATH 항목. 데이터(~/.argo — 회사·대화·로그인)는 남긴다.
// 대상 판정은 설치 스크립트가 프로그램 폴더에 남긴 .argo-install.json뿐이다 — 앱·저장소·--local 설치에는 없어 지우지 않는다.
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

export const STANDALONE_MARK = 'argo-cli-shim v1 argo-selfhost';
export function standaloneRecord(appDir) {
  try { const r = JSON.parse(readFileSync(join(appDir, '.argo-install.json'), 'utf8')); return r?.kind === 'standalone' ? r : null; } catch { return null; }
}
/** argo service install이 만드는 상주 파일(리눅스 systemd·맥 launchd) — 있으면 그 상주가 지울 프로그램을 가리키므로 먼저 해제해야 한다. */
export const serviceFiles = (home = homedir()) => [join(home, '.config', 'systemd', 'user', 'argo-cli.service'), join(home, 'Library', 'LaunchAgents', 'com.beyondworks.argo-cli.plist')];
const ourShim = (f) => { try { return readFileSync(f, 'utf8').slice(0, 512).includes(STANDALONE_MARK); } catch { return false; } };

// 윈도우: 이 프로세스(프로그램 폴더 안의 node.exe)가 끝난 뒤 지운다. ASCII만(PowerShell 5.1이 BOM 없는 파일을 ANSI로 읽는다).
// 지우기 전 확인(검수 #843 M3): 인자가 어긋나도 엉뚱한 것을 지우지 않게 — 프로그램 폴더는 설치 기록이 있는 폴더만, shim은 표식 있는 argo.cmd만,
// 레지스트리는 HKCU 아래의 …Environment 키만.
const WIN_SCRIPT = `param([string]$ParentPid, [string]$AppDir, [string]$Shim, [string]$PathEntry, [string]$EnvKey)
if (-not (Test-Path -LiteralPath (Join-Path $AppDir '.argo-install.json'))) { return }
try { Wait-Process -Id ([int]$ParentPid) -Timeout 60 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 500
for ($i = 0; $i -lt 40 -and (Test-Path -LiteralPath $AppDir); $i++) { try { Remove-Item -LiteralPath $AppDir -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500 } }
if ($Shim -and $Shim.EndsWith('\\argo.cmd') -and (Test-Path -LiteralPath $Shim) -and ((Get-Content -LiteralPath $Shim -TotalCount 3) -join ' ') -match 'argo-cli-shim v1 argo-selfhost') { Remove-Item -LiteralPath $Shim -Force -ErrorAction SilentlyContinue }
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
foreach ($d in @((Join-Path $base 'bin'), $base)) { if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue } }
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;

/** 반환: { ok:false, reason:'not-standalone'|'service', file? } 또는 { ok:true, removed:[…], pending(윈도우 — 종료 뒤 지움) }. */
export function uninstallStandalone({ appDir, home = homedir(), platform = process.platform, spawnImpl = spawn, pid = process.pid, tmp = tmpdir() }) {
  const rec = standaloneRecord(appDir);
  if (!rec) return { ok: false, reason: 'not-standalone' };
  const svc = serviceFiles(home).find((f) => existsSync(f));
  if (svc) return { ok: false, reason: 'service', file: svc };
  const shim = rec.shim && ourShim(rec.shim) ? rec.shim : null; // 표식이 없으면(사용자가 바꿔 둠) 남의 파일로 보고 그대로 둔다
  if (platform === 'win32') {
    const script = join(tmp, `argo-uninstall-${pid}.ps1`);
    writeFileSync(script, WIN_SCRIPT);
    spawnImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(pid), '-AppDir', appDir, '-Shim', shim ?? '', '-PathEntry', rec.pathEntry ?? '', '-EnvKey', rec.envKey ?? 'HKCU:\\Environment'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); // 창은 windowsHide로 숨긴다(-WindowStyle Hidden은 창 없는 세션에서 실패할 수 있어 쓰지 않는다). 이름 있는 인자 — 빈 값이 위치를 밀지 않게(검수 #843 M3)
    return { ok: true, pending: true, removed: [appDir, shim, rec.pathEntry].filter(Boolean) };
  }
  if (shim) rmSync(shim, { force: true });
  rmSync(appDir, { recursive: true, force: true });
  return { ok: true, removed: [appDir, shim].filter(Boolean) };
}
