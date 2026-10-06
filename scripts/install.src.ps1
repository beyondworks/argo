# Argo — 윈도우 argo 명령 단독 설치(2026-10-06 유건 승인). PowerShell에서:
#   irm https://github.com/beyondworks/argo-agent/releases/latest/download/install.ps1 | iex
# 하는 일: node를 담은 자산(argo-cli-<버전>-windows-x64.zip, scripts/stage-cli-dist.mjs)을 해시 확인 뒤 %LOCALAPPDATA%\argo-cli\app에 두고
#   %LOCALAPPDATA%\argo-cli\bin\argo.cmd를 만들어 사용자 PATH(HKCU)에 한 번만 넣는다. 데이터는 %USERPROFILE%\.argo(앱 폴더와 따로, 동기화 켜짐).
# 데스크톱 앱이 설치돼 있으면 설치하지 않는다 — 앱 설치기가 같은 argo 명령을 등록하고, CLI가 둘이면 데이터 폴더가 갈린다.
# 업데이트 = 같은 명령 다시 실행, 제거 = argo uninstall(데이터는 남는다).
# iex로 실행되므로 exit를 쓰지 않는다(사용자 PowerShell 창이 닫힌다) — 오류는 throw로 알린다.
# 이 파일은 원본이다. 배포본 install.ps1은 node scripts/build-install-ps1.mjs가 만든다(ASCII만 — PowerShell 5.1이 irm으로 받은 UTF-8을
# 잘못 읽어 한글이 깨지고 0x85가 줄바꿈으로 읽힐 수 있다). 한글 문구는 반드시 큰따옴표 문자열 안에 쓴다.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1은 진행 표시 때문에 내려받기가 몇 배 느리다
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  function Say([string]$m) { Write-Host "[argo] $m" }
  function Fail([string]$m) { throw "[argo] $m" }
  $mark = 'argo-cli-shim v1 argo-selfhost'
  $appMark = 'argo-cli-shim v1 com.beyondworks.argo'

  # 0) 플랫폼 — 32비트 PowerShell은 PROCESSOR_ARCHITEW6432에 실제 값이 있다
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { $plat = 'windows-x64' }
    'ARM64' { Fail "ARM64 윈도우는 후속 지원 예정입니다 — 현재 x64만 지원합니다" }
    default { Fail "미지원 아키텍처: $arch" }
  }
  if (-not $env:LOCALAPPDATA) { Fail "LOCALAPPDATA 환경변수가 없습니다" }

  # 1) 데스크톱 앱이 있으면 설치하지 않는다
  if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'com.beyondworks.argo\cli-install.json')) {
    Fail "Argo 데스크톱 앱이 설치돼 있습니다 — 앱 설치기가 argo 명령을 등록합니다(앱과 같은 데이터). 새 터미널에서 argo를 실행하세요"
  }
  $isOurs = { param($file, $m) try { (Get-Content -LiteralPath $file -TotalCount 3 -ErrorAction Stop) -join "`n" -match [regex]::Escape($m) } catch { $false } }
  foreach ($c in @(Get-Command argo -All -ErrorAction SilentlyContinue)) {
    if ($c.Source -and (& $isOurs $c.Source $appMark)) { Fail "Argo 데스크톱 앱이 등록한 argo 명령이 있습니다($($c.Source)) — 앱의 argo를 그대로 쓰세요" }
  }

  # 2) 최신 릴리스의 자산
  $api = if ($env:ARGO_INSTALL_API) { $env:ARGO_INSTALL_API } else { 'https://api.github.com/repos/beyondworks/argo-agent/releases/latest' }
  Say "최신 릴리스 확인 중…"
  $rel = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'argo-install' }
  $asset = @($rel.assets | Where-Object { $_.browser_download_url -match "/argo-cli-[^/]*-$plat\.zip$" }) | Select-Object -First 1
  if (-not $asset) { Fail "최신 릴리스에 윈도우용 argo 명령($plat)이 없습니다 — 잠시 뒤 다시 시도하거나 데스크톱 앱을 쓰세요" }
  $url = $asset.browser_download_url
  Say "다운로드: $url"

  $base = Join-Path $env:LOCALAPPDATA 'argo-cli'
  $app = Join-Path $base 'app'
  $binDir = Join-Path $base 'bin'
  $shim = Join-Path $binDir 'argo.cmd'
  $tmp = Join-Path $base ('.install.' + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $hadApp = Test-Path -LiteralPath $app
  $changed = $false; $success = $false
  try {
    $zip = Join-Path $tmp 'cli.zip'; $sumFile = Join-Path $tmp 'cli.sha256'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    try { Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile $sumFile } catch { Fail "해시 파일(.sha256)을 받지 못해 설치하지 않습니다" }
    $want = ((Get-Content -LiteralPath $sumFile -TotalCount 1) -split '\s+')[0].ToLower()
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
    if (-not $want -or $want -ne $got) { Fail "내려받은 파일의 해시가 맞지 않아 설치하지 않습니다(기대 $want, 실제 $got)" }
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    $cand = Join-Path $tmp 'argo-cli'
    $node = Join-Path $cand 'node.exe'
    if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath (Join-Path $cand 'bin\argo.mjs'))) { Fail "자산 구조가 예상과 다릅니다(argo-cli\node.exe·bin\argo.mjs 부재)" }
    $version = (Get-Content -LiteralPath (Join-Path $cand 'package.json') -Raw | ConvertFrom-Json).version

    # 3) 크루가 답하는 중이면 교체하지 않는다(맥·리눅스와 같은 규칙)
    $cliHome = if ($env:ARGO_CLI_HOME) { $env:ARGO_CLI_HOME } else { Join-Path $env:USERPROFILE '.argo' }
    $busy = "const fs=require('fs'),path=require('path');const root=process.argv[1];const ls=d=>{try{return fs.readdirSync(d,{withFileTypes:true})}catch{return[]}};for(const c of ls(root).filter(e=>e.isDirectory()&&!e.name.startsWith('.')))for(const f of ls(path.join(root,c.name,'chats')).filter(e=>e.isFile()&&e.name.endsWith('.status.json'))){try{const s=JSON.parse(fs.readFileSync(path.join(root,c.name,'chats',f.name),'utf8'));if(s.ts&&Date.now()-s.ts<120000)process.exit(3)}catch{}}"
    & $node -e $busy (Join-Path $cliHome 'cli-workspaces')
    if ($LASTEXITCODE -eq 3) { Fail "크루가 답하는 중입니다 — 끝난 뒤 다시 설치하세요" }

    # 4) 교체 — 실행 중인 argo가 파일을 잡고 있으면 옮기지 못한다
    $changed = $true
    if ($hadApp) {
      try { Move-Item -LiteralPath $app -Destination (Join-Path $tmp 'previous-app') }
      catch { $changed = $false; Fail "실행 중인 argo가 있어 교체하지 못했습니다 — argo 창을 모두 닫고 다시 실행하세요" }
    }
    Move-Item -LiteralPath $cand -Destination $app
    $prev = $env:ARGO_CLI_APP; $env:ARGO_CLI_APP = '0'
    # stderr 한 줄(경고)을 PowerShell 5.1이 오류로 바꿔 Stop에 걸리지 않게 이 호출만 Continue — 판정은 종료 코드로만(검수 #843 M2)
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & (Join-Path $app 'node.exe') (Join-Path $app 'bin\argo.mjs') status *> (Join-Path $tmp 'status.log'); $st = $LASTEXITCODE } finally { $env:ARGO_CLI_APP = $prev; $ErrorActionPreference = $eap }
    if ($st -ne 0) { Get-Content -LiteralPath (Join-Path $tmp 'status.log') | Write-Host; Fail "argo 명령 실행 확인 실패 — 이전 설치로 복구합니다" }

    # 5) argo.cmd — ASCII만(cmd는 OEM 코드 페이지로 읽는다). setlocal로 호출한 cmd 창의 환경을 바꾸지 않는다.
    $other = @(Get-Command argo -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -and -not (& $isOurs $_.Source $mark) }) | Select-Object -First 1
    $skip = $null
    if ((Test-Path -LiteralPath $shim) -and -not (& $isOurs $shim $mark)) { $skip = $shim }
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    if (-not $skip) {
      $lines = @('@echo off', "rem $mark - created by the Argo install.ps1, removed by argo uninstall", 'setlocal', 'set "ARGO_CLI_APP=0"', '"%~dp0..\app\node.exe" "%~dp0..\app\bin\argo.mjs" %*', 'exit /b %ERRORLEVEL%')
      Set-Content -LiteralPath "$shim.tmp" -Value $lines -Encoding ASCII
      Move-Item -LiteralPath "$shim.tmp" -Destination $shim -Force
    }

    # 6) 사용자 PATH — 남의 argo가 있으면 가리지 않게 넣지 않는다. 원래 형식(REG_EXPAND_SZ)을 지키고 %VAR%를 펼치지 않는다. 같은 항목이 있으면 쓰지 않는다.
    $envKey = if ($env:ARGO_INSTALL_ENV_KEY) { $env:ARGO_INSTALL_ENV_KEY } else { 'HKCU:\Environment' }
    if (-not $skip -and -not $other) {
      if (-not (Test-Path $envKey)) { New-Item -Path $envKey -Force | Out-Null }
      $key = Get-Item -Path $envKey
      $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
      $items = @($raw -split ';' | Where-Object { $_ -ne '' })
      if (-not ($items | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) {
        $new = (@($items) + $binDir) -join ';'
        Set-ItemProperty -Path $envKey -Name Path -Value $new -Type ExpandString
        # 열려 있는 탐색기·새 터미널에 알림 — 실패해도(C# 컴파일이 막힌 PC) 설치는 계속한다(검수 #843 L4)
        try {
          if (-not ('ArgoEnv' -as [type])) {
            Add-Type -Namespace '' -Name ArgoEnv -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
          }
          $r = [UIntPtr]::Zero
          [void][ArgoEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
        } catch { Say "새 터미널 창에서 PATH가 바로 보이지 않으면 로그아웃 뒤 다시 로그인하세요" }
      }
      if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) { $env:Path = "$env:Path;$binDir" } # 이 창에서도 바로
    }

    # 7) argo uninstall이 지울 대상 — 이 설치가 만든 것만(데이터는 적지 않는다)
    # PATH에 우리 bin이 있으면 누가 넣었든(이전 설치 포함) 제거 대상으로 적는다 — 다시 설치한 뒤에도 argo uninstall이 지운다(검수 #843 M1)
    $inUserPath = $false
    if (Test-Path $envKey) { $inUserPath = [bool](@(([string](Get-Item -Path $envKey).GetValue('Path', '', 'DoNotExpandEnvironmentNames')) -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }) }
    $record = [ordered]@{ kind = 'standalone'; platform = $plat; shim = $(if ($skip) { $null } else { $shim }); pathEntry = $(if ($inUserPath) { $binDir } else { $null }); envKey = $envKey }
    [IO.File]::WriteAllText((Join-Path $app '.argo-install.json'), ($record | ConvertTo-Json -Compress))
    $success = $true
  } finally {
    if ($changed -and -not $success) {
      Say "새 설치 확인 실패 — 이전 설치를 복구합니다"
      if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination (Join-Path $tmp 'failed-app') }
      if ($hadApp -and (Test-Path -LiteralPath (Join-Path $tmp 'previous-app'))) { Move-Item -LiteralPath (Join-Path $tmp 'previous-app') -Destination $app }
      Say "복구 자료: $tmp"
    } else {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Say "설치 완료 — argo 명령 (버전: $version)"
  $direct = "set ARGO_CLI_APP=0 && `"$app\node.exe`" `"$app\bin\argo.mjs`""
  if ($skip) { Say "다른 프로그램의 argo 명령이 있어 argo 명령을 등록하지 않았습니다(그 파일은 그대로 둡니다): $skip"; Say "Argo는 이렇게 실행합니다(cmd): $direct" }
  elseif ($other) { Say "PATH에 다른 프로그램의 argo가 있어 PATH에 넣지 않았습니다: $($other.Source)"; Say "Argo는 이렇게 실행합니다: `"$shim`"" }
  else { Say "새 터미널 창을 열면 어디서든 argo를 쓸 수 있습니다" }
  Say "다음: argo  (로그인 — 브라우저가 열립니다)"
  Say "업데이트: 설치 명령을 다시 실행   제거: argo uninstall (데이터 $env:USERPROFILE\.argo 는 남습니다)"
}
