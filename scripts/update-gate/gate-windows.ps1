# 업데이트 경로 관문 — Windows(NSIS). 맥 관문(gate.sh)과 같은 질문을 Windows 설치 경로로 묻는다:
# "지금 공개된 버전에서 앱 안 업데이트로 새 빌드를 받으면, 다시 뜬 앱이 새 버전으로 답하고 데이터가 남는가."
# 2026-10-15: 0.1.108 공개 뒤 Windows 기기 한 대의 요청이 전부 끊긴 제보 — winpc를 더 쓰지 않아(유건) 발행마다 여기서 본다.
#
# 앱 안 업데이트와 같은 조건(tauri-plugin-updater passive 모드):
#   앱(app.exe)만 끝내고 사이드카 node는 그대로 둔 채, 버전명 설치기를 /P /R /UPDATE /ARGS로 실행한다(플러그인 nsis_args — 릴리스 스킬 7.6).
#   옛 사이드카가 파일을 잡고 있거나 3001을 쥐고 남는 경우가 여기서 드러난다.
# 이 러너는 세션 0이라 화면(WebView2)을 볼 수 없다 — 판정 줄에 '화면 미확인'을 남긴다. 업데이트 막대 클릭·latest.json 조회도 보지 않는다(설치기 단계만).
#
# 입력(환경변수):
#   OUT          증거 폴더(steps.log·RESULT·파일 목록·앱 로그)
#   NEW_SETUP    새 빌드 버전명 설치기 경로(argo_<v>_x64-setup.exe). 없으면 TO_VERSION의 공개 설치기를 받는다(관문 자체 시험용)
#   TO_VERSION   NEW_SETUP이 없을 때만
#   FROM_VERSION 시작 버전(비우면 지금 공개된 Latest)
# 출력: OUT/RESULT 한 줄 — 'PASS <시작> -> <새> …' 또는 'FAIL …'. 실패면 종료 코드 1.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'beyondworks/argo-agent'
$Out = $env:OUT; New-Item -ItemType Directory -Force $Out | Out-Null
$Log = Join-Path $Out 'steps.log'
$Work = Join-Path $env:RUNNER_TEMP 'gate-win'; New-Item -ItemType Directory -Force $Work | Out-Null

function Note($s) { $line = "[$(Get-Date -Format HH:mm:ss)] $s"; Write-Host $line; Add-Content $Log $line }
function Verdict($kind, $msg) { Note "${kind}: $msg"; Set-Content (Join-Path $Out 'RESULT') "$kind $msg"; if ($kind -ne 'PASS') { exit 1 } }
function Newer($a, $b) { [version]$a -gt [version]$b }
function Reg { Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'argo' } | Select-Object -First 1 }
# 앱 서버는 3001이 기본이고, 막혀 있으면 3011·3021…로 옮긴다(src-tauri lib.rs 폴백). 응답한 첫 포트를 쓴다.
function Ping { foreach ($p in 3001, 3011, 3021, 3031) { try { $r = Invoke-RestMethod "http://127.0.0.1:$p/api/ping" -TimeoutSec 3; if ($r.argo) { return [pscustomobject]@{ port = $p; version = $r.version; buildId = $r.buildId } } } catch {} }; return $null }
function WaitPing($want, $sec) { $t0 = Get-Date; do { $p = Ping; if ($p -and (-not $want -or $p.version -eq $want)) { return $p }; Start-Sleep 2 } while (((Get-Date) - $t0).TotalSeconds -lt $sec); return (Ping) }
# 설치기 실행 — 그 프로세스만 기다린다. Start-Process -Wait는 자식까지 기다려, /R로 다시 뜬 앱(설치기의 자식) 때문에 끝나지 않는다(windows-latest 실측 30분 초과).
function RunSetup($file, $argv, $limitSec) { $p = Start-Process $file -ArgumentList $argv -PassThru; if (-not $p.WaitForExit($limitSec * 1000)) { return $null }; return $p.ExitCode }
function Show($p) { if ($p) { "port=$($p.port) version=$($p.version) buildId=$($p.buildId)" } else { '응답 없음' } }
function Procs { Get-Process app, node -ErrorAction SilentlyContinue | ForEach-Object { $path = try { $_.Path } catch { '' }; Note "  $($_.ProcessName) pid=$($_.Id) start=$($_.StartTime.ToString('HH:mm:ss')) $path" } }
function Owner($port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  [pscustomobject]@{ pid = $c.OwningProcess; name = $p.ProcessName; start = $p.StartTime; path = $(try { $p.Path } catch { '' }) }
}
function Files($loc, $tag) {
  Get-ChildItem $loc -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
    ForEach-Object { '{0,12} {1}' -f $(if ($_.PSIsContainer) { '<dir>' } else { $_.Length }), $_.FullName.Substring($loc.Length) } | Set-Content (Join-Path $Out "files-$tag.txt")
  # 사이드카 서버 트리는 설치 폴더의 server\(windows-latest 실측). 구운 서버 설정(argo-server-config.json)은 값이 아니라 있는지·크기만
  foreach ($rel in 'app.exe', 'node.exe', 'server\server.js', 'server\package.json', 'server\argo-server-config.json') {
    $f = Join-Path $loc $rel
    if (Test-Path $f) { Note "[$tag] $rel $((Get-Item $f).Length) bytes" } else { Note "[$tag] $rel 없음" }
  }
  $pkg = Join-Path $loc 'server\package.json'
  if (Test-Path $pkg) { Note "[$tag] 서버 package.json version=$((Get-Content $pkg -Raw | ConvertFrom-Json).version)" }
}

# 1) 시작 버전·새 빌드
$From = $env:FROM_VERSION
if (-not $From) {
  try { $From = (Invoke-RestMethod "https://github.com/$Repo/releases/latest/download/latest.json").version } catch { Verdict FAIL "could not read the public latest.json: $($_.Exception.Message)" }
}
$PubSetup = Join-Path $Work "argo_${From}_x64-setup.exe"
try { Invoke-WebRequest "https://github.com/$Repo/releases/download/v$From/argo_${From}_x64-setup.exe" -OutFile $PubSetup } catch { Verdict FAIL "could not download the public v$From installer" }
$NewSetup = $env:NEW_SETUP
if (-not $NewSetup) {
  if (-not $env:TO_VERSION) { Verdict FAIL 'neither NEW_SETUP nor TO_VERSION given' }
  $NewSetup = Join-Path $Work "argo_$($env:TO_VERSION)_x64-setup.exe"
  try { Invoke-WebRequest "https://github.com/$Repo/releases/download/v$($env:TO_VERSION)/argo_$($env:TO_VERSION)_x64-setup.exe" -OutFile $NewSetup } catch { Verdict FAIL "could not download the public v$($env:TO_VERSION) installer" }
}
if (-not (Test-Path $NewSetup)) { Verdict FAIL "new build installer missing: $NewSetup" }
$New = [regex]::Match((Split-Path $NewSetup -Leaf), '^argo_([0-9]+\.[0-9]+\.[0-9]+)_x64-setup\.exe$').Groups[1].Value
if (-not $New) { Verdict FAIL "new build installer is not a versioned argo_<v>_x64-setup.exe: $(Split-Path $NewSetup -Leaf)" }
if (-not (Newer $New $From)) { Verdict FAIL "new build $New is not newer than $From — nothing to update" }
Note "시작 $From ($((Get-Item $PubSetup).Length) bytes) -> 새 $New ($((Get-Item $NewSetup).Length) bytes)"

# 2) 시작 버전 설치·실행
$code = RunSetup $PubSetup @('/S') 600
if ($code -ne 0) { Verdict FAIL "public $From silent install exit=$code" }
$r = Reg; if (-not $r) { Verdict FAIL "public $From not registered after install" }
$Loc = $r.InstallLocation.Trim().Trim('"').TrimEnd('\') # 레지스트리 값이 큰따옴표로 감싸여 있다(windows-latest 실측)
if (-not (Test-Path (Join-Path $Loc 'app.exe'))) { Verdict FAIL "app.exe not found under InstallLocation '$($r.InstallLocation)'" }
Note "설치 $($r.DisplayVersion) at $Loc"
Files $Loc 'before'
Start-Process (Join-Path $Loc 'app.exe')
$p0 = WaitPing $From 180
Note "시작 버전 서버: $(Show $p0)"
if (-not $p0 -or $p0.version -ne $From) { Procs; Verdict FAIL "public $From never answered /api/ping ($(Show $p0))" }

# 3) 데이터 표식 — 업데이트 뒤에도 남아야 한다(회사 폴더는 앱이 만든 데이터 루트 아래)
$Data = Join-Path $env:LOCALAPPDATA 'com.beyondworks.argo'
$Ws = Join-Path $Data 'workspaces'
New-Item -ItemType Directory -Force (Join-Path $Ws 'gate-co') | Out-Null
$Mark = "gate-$From-$(Get-Random)"
Set-Content (Join-Path $Ws 'gate-co\gate-marker.txt') $Mark
# 사용자 데이터 = 회사 폴더(workspaces\ 두 단계)만 비교한다 — 데이터 루트의 EBWebView\(WebView2 캐시·BrowserMetrics)는 브라우저가 수시로 지우고 만든다(0.1.107→0.1.108 실측 오탐)
function DataItems { if (Test-Path $Ws) { (Get-ChildItem $Ws -Force -Recurse -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($Ws.Length) }) | Sort-Object } }
$before = DataItems
Procs

# 4) 앱 안 업데이트와 같은 조건 — 앱만 끝내고 사이드카 node는 남긴다
Get-Process app -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
$old = Owner $p0.port
Note "앱 종료 뒤 포트 $($p0.port): $(if ($old) { "$($old.name) pid=$($old.pid)" } else { '비어 있음' })"
$t0 = Get-Date
$code = RunSetup $NewSetup @('/P', '/R', '/UPDATE', '/ARGS') 600
$secs = [int]((Get-Date) - $t0).TotalSeconds
Note "업데이트 설치기 exit=$code (${secs}초)"
if ($null -eq $code) { Procs; Verdict FAIL "update installer $From -> $New did not finish within 600s" }
if ($code -ne 0) { Procs; Verdict FAIL "update installer $From -> $New exit=$code" }
$r = Reg
Note "업데이트 뒤 DisplayVersion=$($r.DisplayVersion) InstallLocation=$($r.InstallLocation)"
Files $Loc 'after'
if ($r.DisplayVersion -ne $New) { Verdict FAIL "DisplayVersion=$($r.DisplayVersion) after updating to $New" }

# 5) /R로 다시 뜬 앱 — 새 버전이 답해야 한다(옛 사이드카가 3001을 쥐고 옛 버전으로 답하면 결함)
$p1 = WaitPing $New 240
Note "업데이트 뒤 서버: $(Show $p1)"
Procs
$own = if ($p1) { Owner $p1.port } else { Owner 3001 }
if ($own) { Note "포트 $(if ($p1) { $p1.port } else { 3001 }) 주인: $($own.name) pid=$($own.pid) start=$($own.start.ToString('HH:mm:ss')) $($own.path)" }

# 앱 로그 — 사이드카 stderr는 tauri 로그 플러그인이 [server] 줄로 남긴다. 긴 토큰 모양은 가린다
$Logs = Join-Path $Data 'logs'
if (Test-Path $Logs) { Get-ChildItem $Logs -File | ForEach-Object { (Get-Content $_.FullName -Raw) -replace '[A-Za-z0-9_\-\.]{32,}', '<가림>' | Set-Content (Join-Path $Out "applog-$($_.Name)") } }

if (-not $p1) { Verdict FAIL "after updating to $New nothing answers /api/ping (relaunch failed?) — 화면 미확인" }
if ($p1.version -ne $New) { Verdict FAIL "after updating to $New the server still answers $($p1.version) on port $($p1.port) (old sidecar kept the port?) — 화면 미확인" }
if ($own -and $own.start -lt $t0) { Verdict FAIL "port $($p1.port) is held by a process started before the update (pid $($own.pid)) — 화면 미확인" }

# 6) 데이터 보존
$markNow = Get-Content (Join-Path $Ws 'gate-co\gate-marker.txt') -ErrorAction SilentlyContinue
$after = DataItems
$lost = $before | Where-Object { $_ -notin $after -and $_ -notmatch '\\logs|\.lock$|\.tmp-' }
if ($markNow -ne $Mark) { Verdict FAIL "data marker lost after updating to $New — 화면 미확인" }
if ($lost) { Note "사라진 데이터 항목: $($lost -join ', ')"; Verdict FAIL "data entries disappeared after updating to ${New}: $(@($lost)[0..4] -join ', ') — 화면 미확인" }

Verdict PASS "$From -> $New installed (exit 0, ${secs}s), relaunched, server answers $New (buildId $($p1.buildId)) on port $($p1.port), data kept — 화면 미확인(세션 0)"
