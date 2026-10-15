# 업데이트 경로 관문 — Argo Messenger Windows(NSIS). 본체 관문(gate-windows.ps1)과 같은 질문을 메신저 설치 경로로 묻는다:
# "지금 공개된 메신저에서 앱 안 업데이트로 새 빌드를 받으면, 다시 뜬 앱이 새 버전 파일이고 데이터가 남는가."
# 2026-10-15: 메신저 0.1.62가 Windows 앱 안 업데이트를 확인하지 못한 채 공개됐다(gate-windows가 본체만 돌았다).
#
# 메신저는 사이드카·로컬 서버(3001)가 없다 — /api/ping 대신 다시 뜬 argo-messenger.exe 프로세스와 그 파일의 ProductVersion으로 판정한다.
# 앱 안 업데이트와 같은 조건(tauri-plugin-updater passive): 앱을 끝내고 버전명 설치기를 /P /R /UPDATE /ARGS로 실행한다.
# 이 러너는 세션 0이라 화면(WebView2)을 볼 수 없다 — 판정 줄에 '화면 미확인'을 남긴다.
#
# 입력(환경변수): OUT · NEW_SETUP(argo-messenger_<v>_x64-setup.exe) 또는 TO_VERSION · FROM_VERSION(비우면 공개 Latest)
#   EXPECT_FAIL=1 — 거짓 PASS 막기 자체 시험: 설치기 이름과 실제 버전이 다른 경우(옛 설치기를 새 이름으로) FAIL이어야 통과한다
# 출력: OUT/RESULT 한 줄 — 'PASS <시작> -> <새> …' 또는 'FAIL …'. 실패면 종료 코드 1(EXPECT_FAIL이면 반대).
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'beyondworks/argo-messenger'
$Name = 'Argo Messenger'; $Exe = 'argo-messenger.exe'; $Ident = 'com.beyondworks.argo.messenger'
$Out = $env:OUT; New-Item -ItemType Directory -Force $Out | Out-Null
$Log = Join-Path $Out 'steps.log'
$Work = Join-Path $env:RUNNER_TEMP 'gate-win-msgr'; New-Item -ItemType Directory -Force $Work | Out-Null
$ExpectFail = $env:EXPECT_FAIL -eq '1'

function Note($s) { $line = "[$(Get-Date -Format HH:mm:ss)] $s"; Write-Host $line; Add-Content $Log $line }
function Verdict($kind, $msg) {
  Note "${kind}: $msg"; Set-Content (Join-Path $Out 'RESULT') "$kind $msg"
  if ($ExpectFail) { if ($kind -eq 'FAIL' -and $msg -match 'DisplayVersion=|ProductVersion') { Note 'EXPECT_FAIL: 기대대로 버전 불일치로 FAIL'; exit 0 }; Note "EXPECT_FAIL: 버전 불일치 FAIL이 아니다($kind) — 관문이 거짓 PASS를 내거나 다른 이유로 멈췄다"; exit 1 } # 다른 이유(내려받기 실패 등)의 FAIL로 자체 시험이 통과하지 않게
  if ($kind -ne 'PASS') { exit 1 }
}
function Newer($a, $b) { [version]$a -gt [version]$b }
function V3($v) { $m = [regex]::Match([string]$v, '^\s*([0-9]+)\.([0-9]+)\.([0-9]+)'); if ($m.Success) { "$($m.Groups[1]).$($m.Groups[2]).$($m.Groups[3])" } else { '' } } # ProductVersion '0.1.62'·'0.1.62.0' 모두 0.1.62로
function Reg { Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $Name } | Select-Object -First 1 }
function RunSetup($file, $argv, $limitSec) { $p = Start-Process $file -ArgumentList $argv -PassThru; if (-not $p.WaitForExit($limitSec * 1000)) { return $null }; return $p.ExitCode } # 그 프로세스만 기다린다(/R로 뜬 앱은 자식 — 본체 관문 실측)
function AppProcs { Get-Process -Name ($Exe -replace '\.exe$', '') -ErrorAction SilentlyContinue }
function ShowProcs { AppProcs | ForEach-Object { $path = try { $_.Path } catch { '' }; Note "  $($_.ProcessName) pid=$($_.Id) start=$($_.StartTime.ToString('HH:mm:ss')) $path" } }
function WaitProc($after, $sec) { $t0 = Get-Date; do { $p = AppProcs | Where-Object { -not $after -or $_.StartTime -gt $after } | Select-Object -First 1; if ($p) { return $p }; Start-Sleep 2 } while (((Get-Date) - $t0).TotalSeconds -lt $sec); return $null }
function Files($loc, $tag) {
  Get-ChildItem $loc -Recurse -Depth 2 -ErrorAction SilentlyContinue | ForEach-Object { '{0,12} {1}' -f $(if ($_.PSIsContainer) { '<dir>' } else { $_.Length }), $_.FullName.Substring($loc.Length) } | Set-Content (Join-Path $Out "files-$tag.txt")
  $f = Join-Path $loc $Exe
  if (Test-Path $f) { $vi = (Get-Item $f).VersionInfo; Note "[$tag] $Exe $((Get-Item $f).Length) bytes ProductVersion=$($vi.ProductVersion) FileVersion=$($vi.FileVersion)" } else { Note "[$tag] $Exe 없음" }
}
function Fetch($ver, $dest) { Invoke-WebRequest "https://github.com/$Repo/releases/download/v$ver/argo-messenger_${ver}_x64-setup.exe" -OutFile $dest }

# 1) 시작 버전·새 빌드
$From = $env:FROM_VERSION
if (-not $From) {
  try { $From = (Invoke-RestMethod "https://github.com/$Repo/releases/latest/download/latest.json").version } catch { Verdict FAIL "could not read the public latest.json: $($_.Exception.Message)" }
}
$PubSetup = Join-Path $Work "argo-messenger_${From}_x64-setup.exe"
try { Fetch $From $PubSetup } catch { Verdict FAIL "could not download the public v$From messenger installer" }
$NewSetup = $env:NEW_SETUP
if (-not $NewSetup) {
  if (-not $env:TO_VERSION) { Verdict FAIL 'neither NEW_SETUP nor TO_VERSION given' }
  $NewSetup = Join-Path $Work "argo-messenger_$($env:TO_VERSION)_x64-setup.exe"
  try { Fetch $env:TO_VERSION $NewSetup } catch { Verdict FAIL "could not download the public v$($env:TO_VERSION) messenger installer" }
}
if (-not (Test-Path $NewSetup)) { Verdict FAIL "new build installer missing: $NewSetup" }
$New = [regex]::Match((Split-Path $NewSetup -Leaf), '^argo-messenger_([0-9]+\.[0-9]+\.[0-9]+)_x64-setup\.exe$').Groups[1].Value
if (-not $New) { Verdict FAIL "new build installer is not a versioned argo-messenger_<v>_x64-setup.exe: $(Split-Path $NewSetup -Leaf)" }
if (-not (Newer $New $From)) { Verdict FAIL "new build $New is not newer than $From — nothing to update" }
Note "시작 $From ($((Get-Item $PubSetup).Length) bytes) -> 새 $New ($((Get-Item $NewSetup).Length) bytes)"

# 2) 시작 버전 설치·실행
$code = RunSetup $PubSetup @('/S') 600
if ($code -ne 0) { Verdict FAIL "public $From silent install exit=$code" }
$r = Reg; if (-not $r) { Verdict FAIL "public $From not registered after install (DisplayName '$Name')" }
$Loc = ([string]$r.InstallLocation).Trim().Trim('"').TrimEnd('\')
if (-not $Loc -or -not (Test-Path (Join-Path $Loc $Exe))) { $Loc = Split-Path (([string]$r.DisplayIcon).Trim().Trim('"') -replace ',\d+$', '') } # InstallLocation이 비면 아이콘 경로의 폴더
if (-not (Test-Path (Join-Path $Loc $Exe))) { Verdict FAIL "$Exe not found (InstallLocation '$($r.InstallLocation)', DisplayIcon '$($r.DisplayIcon)')" }
Note "설치 $($r.DisplayVersion) at $Loc"
if ($r.DisplayVersion -ne $From) { Verdict FAIL "public install DisplayVersion=$($r.DisplayVersion), expected $From" }
Files $Loc 'before'
Start-Process (Join-Path $Loc $Exe)
$p0 = WaitProc $null 60
if (-not $p0) { Verdict FAIL "public $From $Exe did not start" }
Start-Sleep 8 # 첫 실행이 앱 데이터 폴더(WebView2 등)를 만들 시간
if (-not (AppProcs)) { Verdict FAIL "public $From $Exe exited right after start — 화면 미확인" }
Note "시작 버전 실행 중 pid=$($p0.Id)"

# 3) 데이터 표식 — 앱 데이터 폴더(식별자)에 둔다. 업데이트 설치기는 앱 데이터를 건드리지 않아야 한다
$DataDirs = @((Join-Path $env:LOCALAPPDATA $Ident), (Join-Path $env:APPDATA $Ident))
foreach ($d in $DataDirs) { New-Item -ItemType Directory -Force $d | Out-Null }
$Mark = "gate-msgr-$From-$(Get-Random)"
foreach ($d in $DataDirs) { Set-Content (Join-Path $d 'gate-marker.txt') $Mark }
Note "데이터 표식: $($DataDirs -join ', ')"
ShowProcs

# 4) 앱 안 업데이트와 같은 조건 — 앱을 끝내고 버전명 설치기를 /P /R /UPDATE /ARGS로
AppProcs | Stop-Process -Force
Start-Sleep 2
$t0 = Get-Date
$code = RunSetup $NewSetup @('/P', '/R', '/UPDATE', '/ARGS') 600
$secs = [int]((Get-Date) - $t0).TotalSeconds
Note "업데이트 설치기 exit=$code (${secs}초)"
if ($null -eq $code) { ShowProcs; Verdict FAIL "update installer $From -> $New did not finish within 600s" }
if ($code -ne 0) { ShowProcs; Verdict FAIL "update installer $From -> $New exit=$code" }
$r = Reg
Note "업데이트 뒤 DisplayVersion=$($r.DisplayVersion) InstallLocation=$($r.InstallLocation)"
Files $Loc 'after'
if ($r.DisplayVersion -ne $New) { Verdict FAIL "DisplayVersion=$($r.DisplayVersion) after updating to $New" }

# 5) /R로 다시 뜬 앱 — 업데이트 뒤에 시작한 새 프로세스이고, 그 파일이 새 버전이어야 한다
$p1 = WaitProc $t0 120
ShowProcs
if (-not $p1) { Verdict FAIL "after updating to $New no $Exe started after the update (relaunch failed?) — 화면 미확인" }
$path1 = try { $p1.Path } catch { '' }
$pv = if ($path1 -and (Test-Path $path1)) { (Get-Item $path1).VersionInfo.ProductVersion } else { '' }
Note "다시 뜬 앱 pid=$($p1.Id) start=$($p1.StartTime.ToString('HH:mm:ss')) path=$path1 ProductVersion=$pv"
if ((V3 $pv) -ne $New) { Verdict FAIL "relaunched $Exe is ProductVersion '$pv', expected $New — 화면 미확인" }
Start-Sleep 6
if (-not (AppProcs | Where-Object { $_.Id -eq $p1.Id })) { Verdict FAIL "relaunched $Exe $New exited within seconds — 화면 미확인" }

# 6) 데이터 보존
foreach ($d in $DataDirs) {
  $now = Get-Content (Join-Path $d 'gate-marker.txt') -ErrorAction SilentlyContinue
  if ($now -ne $Mark) { Verdict FAIL "data marker lost in $d after updating to $New — 화면 미확인" }
}
Verdict PASS "$From -> $New installed (exit 0, ${secs}s), relaunched $Exe pid $($p1.Id) started after update, ProductVersion $pv, data kept — 화면 미확인(세션 0)"
