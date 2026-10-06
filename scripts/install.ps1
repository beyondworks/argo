# Argo argo CLI installer for Windows (generated from scripts/install.src.ps1 by scripts/build-install-ps1.mjs - do not edit)
# Usage (PowerShell): irm https://github.com/beyondworks/argo-agent/releases/latest/download/install.ps1 | iex
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  function Say([string]$m) { Write-Host "[argo] $m" }
  function Fail([string]$m) { throw "[argo] $m" }
  $mark = 'argo-cli-shim v1 argo-selfhost'
  $appMark = 'argo-cli-shim v1 com.beyondworks.argo'

  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { $plat = 'windows-x64' }
    'ARM64' { Fail "ARM64 $([regex]::Unescape('\uc708\ub3c4\uc6b0\ub294\u0020\ud6c4\uc18d\u0020\uc9c0\uc6d0\u0020\uc608\uc815\uc785\ub2c8\ub2e4\u0020\u2014\u0020\ud604\uc7ac')) x64$([regex]::Unescape('\ub9cc\u0020\uc9c0\uc6d0\ud569\ub2c8\ub2e4'))" }
    default { Fail "$([regex]::Unescape('\ubbf8\uc9c0\uc6d0\u0020\uc544\ud0a4\ud14d\ucc98')): $arch" }
  }
  if (-not $env:LOCALAPPDATA) { Fail "LOCALAPPDATA $([regex]::Unescape('\ud658\uacbd\ubcc0\uc218\uac00\u0020\uc5c6\uc2b5\ub2c8\ub2e4'))" }

  if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'com.beyondworks.argo\cli-install.json')) {
    Fail "Argo $([regex]::Unescape('\ub370\uc2a4\ud06c\ud1b1\u0020\uc571\uc774\u0020\uc124\uce58\ub3fc\u0020\uc788\uc2b5\ub2c8\ub2e4\u0020\u2014\u0020\uc571\u0020\uc124\uce58\uae30\uac00')) argo $([regex]::Unescape('\uba85\ub839\uc744\u0020\ub4f1\ub85d\ud569\ub2c8\ub2e4'))($([regex]::Unescape('\uc571\uacfc\u0020\uac19\uc740\u0020\ub370\uc774\ud130'))). $([regex]::Unescape('\uc0c8\u0020\ud130\ubbf8\ub110\uc5d0\uc11c')) argo$([regex]::Unescape('\ub97c\u0020\uc2e4\ud589\ud558\uc138\uc694'))"
  }
  $isOurs = { param($file, $m) try { (Get-Content -LiteralPath $file -TotalCount 3 -ErrorAction Stop) -join "`n" -match [regex]::Escape($m) } catch { $false } }
  foreach ($c in @(Get-Command argo -All -ErrorAction SilentlyContinue)) {
    if ($c.Source -and (& $isOurs $c.Source $appMark)) { Fail "Argo $([regex]::Unescape('\ub370\uc2a4\ud06c\ud1b1\u0020\uc571\uc774\u0020\ub4f1\ub85d\ud55c')) argo $([regex]::Unescape('\uba85\ub839\uc774\u0020\uc788\uc2b5\ub2c8\ub2e4'))($($c.Source)) $([regex]::Unescape('\u2014\u0020\uc571\uc758')) argo$([regex]::Unescape('\ub97c\u0020\uadf8\ub300\ub85c\u0020\uc4f0\uc138\uc694'))" }
  }

  $api = if ($env:ARGO_INSTALL_API) { $env:ARGO_INSTALL_API } else { 'https://api.github.com/repos/beyondworks/argo-agent/releases/latest' }
  Say "$([regex]::Unescape('\ucd5c\uc2e0\u0020\ub9b4\ub9ac\uc2a4\u0020\ud655\uc778\u0020\uc911\u2026'))"
  $rel = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'argo-install' }
  $asset = @($rel.assets | Where-Object { $_.browser_download_url -match "/argo-cli-[^/]*-$plat\.zip$" }) | Select-Object -First 1
  if (-not $asset) { Fail "$([regex]::Unescape('\ucd5c\uc2e0\u0020\ub9b4\ub9ac\uc2a4\uc5d0\u0020\uc708\ub3c4\uc6b0\uc6a9')) argo $([regex]::Unescape('\uba85\ub839'))($plat)$([regex]::Unescape('\uc774\u0020\uc5c6\uc2b5\ub2c8\ub2e4\u0020\u2014\u0020\uc7a0\uc2dc\u0020\ub4a4\u0020\ub2e4\uc2dc\u0020\uc2dc\ub3c4\ud558\uac70\ub098\u0020\ub370\uc2a4\ud06c\ud1b1\u0020\uc571\uc744\u0020\uc4f0\uc138\uc694'))" }
  $url = $asset.browser_download_url
  Say "$([regex]::Unescape('\ub2e4\uc6b4\ub85c\ub4dc')): $url"

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
    try { Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile $sumFile } catch { Fail "$([regex]::Unescape('\ud574\uc2dc\u0020\ud30c\uc77c'))(.sha256)$([regex]::Unescape('\uc744\u0020\ubc1b\uc9c0\u0020\ubabb\ud574\u0020\uc124\uce58\ud558\uc9c0\u0020\uc54a\uc2b5\ub2c8\ub2e4'))" }
    $want = ((Get-Content -LiteralPath $sumFile -TotalCount 1) -split '\s+')[0].ToLower()
    $fs = [IO.File]::OpenRead($zip)
    try { $got = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($fs)) -replace '-', '').ToLower() } finally { $fs.Dispose() }
    if (-not $want -or $want -ne $got) { Fail "$([regex]::Unescape('\ub0b4\ub824\ubc1b\uc740\u0020\ud30c\uc77c\uc758\u0020\ud574\uc2dc\uac00\u0020\ub9de\uc9c0\u0020\uc54a\uc544\u0020\uc124\uce58\ud558\uc9c0\u0020\uc54a\uc2b5\ub2c8\ub2e4'))($([regex]::Unescape('\uae30\ub300')) $want, $([regex]::Unescape('\uc2e4\uc81c')) $got)" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
    $cand = Join-Path $tmp 'argo-cli'
    $node = Join-Path $cand 'node.exe'
    if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath (Join-Path $cand 'bin\argo.mjs'))) { Fail "$([regex]::Unescape('\uc790\uc0b0\u0020\uad6c\uc870\uac00\u0020\uc608\uc0c1\uacfc\u0020\ub2e4\ub985\ub2c8\ub2e4'))(argo-cli\node.exe$([regex]::Unescape('\u00b7'))bin\argo.mjs $([regex]::Unescape('\ubd80\uc7ac')))" }
    $version = (Get-Content -LiteralPath (Join-Path $cand 'package.json') -Raw | ConvertFrom-Json).version

    $cliHome = if ($env:ARGO_CLI_HOME) { $env:ARGO_CLI_HOME } else { Join-Path $env:USERPROFILE '.argo' }
    $busy = "const fs=require('fs'),path=require('path');const root=process.argv[1];const ls=d=>{try{return fs.readdirSync(d,{withFileTypes:true})}catch{return[]}};for(const c of ls(root).filter(e=>e.isDirectory()&&!e.name.startsWith('.')))for(const f of ls(path.join(root,c.name,'chats')).filter(e=>e.isFile()&&e.name.endsWith('.status.json'))){try{const s=JSON.parse(fs.readFileSync(path.join(root,c.name,'chats',f.name),'utf8'));if(s.ts&&Date.now()-s.ts<120000)process.exit(3)}catch{}}"
    & $node -e $busy (Join-Path $cliHome 'cli-workspaces')
    if ($LASTEXITCODE -eq 3) { Fail "$([regex]::Unescape('\ud06c\ub8e8\uac00\u0020\ub2f5\ud558\ub294\u0020\uc911\uc785\ub2c8\ub2e4\u0020\u2014\u0020\ub05d\ub09c\u0020\ub4a4\u0020\ub2e4\uc2dc\u0020\uc124\uce58\ud558\uc138\uc694'))" }

    $changed = $true
    if ($hadApp) {
      try { Move-Item -LiteralPath $app -Destination (Join-Path $tmp 'previous-app') }
      catch { $changed = $false; Fail "$([regex]::Unescape('\uc2e4\ud589\u0020\uc911\uc778')) argo$([regex]::Unescape('\uac00\u0020\uc788\uc5b4\u0020\uad50\uccb4\ud558\uc9c0\u0020\ubabb\ud588\uc2b5\ub2c8\ub2e4\u0020\u2014')) argo $([regex]::Unescape('\ucc3d\uc744\u0020\ubaa8\ub450\u0020\ub2eb\uace0\u0020\ub2e4\uc2dc\u0020\uc2e4\ud589\ud558\uc138\uc694'))" }
    }
    Move-Item -LiteralPath $cand -Destination $app
    $prev = $env:ARGO_CLI_APP; $env:ARGO_CLI_APP = '0'
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & (Join-Path $app 'node.exe') (Join-Path $app 'bin\argo.mjs') status *> (Join-Path $tmp 'status.log'); $st = $LASTEXITCODE } finally { $env:ARGO_CLI_APP = $prev; $ErrorActionPreference = $eap }
    if ($st -ne 0) { Get-Content -LiteralPath (Join-Path $tmp 'status.log') | Write-Host; Fail "argo $([regex]::Unescape('\uba85\ub839\u0020\uc2e4\ud589\u0020\ud655\uc778\u0020\uc2e4\ud328\u0020\u2014\u0020\uc774\uc804\u0020\uc124\uce58\ub85c\u0020\ubcf5\uad6c\ud569\ub2c8\ub2e4'))" }

    $other = @(Get-Command argo -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -and -not (& $isOurs $_.Source $mark) }) | Select-Object -First 1
    $skip = $null
    if ((Test-Path -LiteralPath $shim) -and -not (& $isOurs $shim $mark)) { $skip = $shim }
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    if (-not $skip) {
      $lines = @('@echo off', "rem $mark - created by the Argo install.ps1, removed by argo uninstall", 'setlocal', 'set "ARGO_CLI_APP=0"', 'set "ARGO_CLI_SHIM=cmd"', '"%~dp0..\app\node.exe" "%~dp0..\app\bin\argo.mjs" %*', 'if errorlevel 77 if not errorlevel 78 if exist "%TEMP%\argo-uninstall.ps1" set "ARGO_UNINSTALL_FROM_CMD=1" & powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\argo-uninstall.ps1" & (goto) 2>nul & del "%~f0" 2>nul & rmdir "%~dp0" 2>nul & rmdir "%~dp0.." 2>nul & exit /b 0', 'exit /b %ERRORLEVEL%')
      Set-Content -LiteralPath "$shim.tmp" -Value $lines -Encoding ASCII
      Move-Item -LiteralPath "$shim.tmp" -Destination $shim -Force
    }

    $envKey = if ($env:ARGO_INSTALL_ENV_KEY) { $env:ARGO_INSTALL_ENV_KEY } else { 'HKCU:\Environment' }
    if (-not $skip -and -not $other) {
      if (-not (Test-Path $envKey)) { New-Item -Path $envKey -Force | Out-Null }
      $key = Get-Item -Path $envKey
      $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
      $items = @($raw -split ';' | Where-Object { $_ -ne '' })
      if (-not ($items | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) {
        $new = (@($items) + $binDir) -join ';'
        Set-ItemProperty -Path $envKey -Name Path -Value $new -Type ExpandString
        try {
          if (-not ('ArgoEnv' -as [type])) {
            Add-Type -Namespace '' -Name ArgoEnv -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
          }
          $r = [UIntPtr]::Zero
          [void][ArgoEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
        } catch { Say "$([regex]::Unescape('\uc0c8\u0020\ud130\ubbf8\ub110\u0020\ucc3d\uc5d0\uc11c')) PATH$([regex]::Unescape('\uac00\u0020\ubc14\ub85c\u0020\ubcf4\uc774\uc9c0\u0020\uc54a\uc73c\uba74\u0020\ub85c\uadf8\uc544\uc6c3\u0020\ub4a4\u0020\ub2e4\uc2dc\u0020\ub85c\uadf8\uc778\ud558\uc138\uc694'))" }
      }
      if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) { $env:Path = "$env:Path;$binDir" }
    }

    $inUserPath = $false
    if (Test-Path $envKey) { $inUserPath = [bool](@(([string](Get-Item -Path $envKey).GetValue('Path', '', 'DoNotExpandEnvironmentNames')) -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }) }
    $record = [ordered]@{ kind = 'standalone'; platform = $plat; shim = $(if ($skip) { $null } else { $shim }); pathEntry = $(if ($inUserPath) { $binDir } else { $null }); envKey = $envKey }
    [IO.File]::WriteAllText((Join-Path $app '.argo-install.json'), ($record | ConvertTo-Json -Compress))
    $success = $true
  } finally {
    if ($changed -and -not $success) {
      Say "$([regex]::Unescape('\uc0c8\u0020\uc124\uce58\u0020\ud655\uc778\u0020\uc2e4\ud328\u0020\u2014\u0020\uc774\uc804\u0020\uc124\uce58\ub97c\u0020\ubcf5\uad6c\ud569\ub2c8\ub2e4'))"
      if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination (Join-Path $tmp 'failed-app') }
      if ($hadApp -and (Test-Path -LiteralPath (Join-Path $tmp 'previous-app'))) { Move-Item -LiteralPath (Join-Path $tmp 'previous-app') -Destination $app }
      Say "$([regex]::Unescape('\ubcf5\uad6c\u0020\uc790\ub8cc')): $tmp"
    } else {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Say "$([regex]::Unescape('\uc124\uce58\u0020\uc644\ub8cc\u0020\u2014')) argo $([regex]::Unescape('\uba85\ub839')) ($([regex]::Unescape('\ubc84\uc804')): $version)"
  $direct = "set ARGO_CLI_APP=0 && `"$app\node.exe`" `"$app\bin\argo.mjs`""
  if ($skip) { Say "$([regex]::Unescape('\ub2e4\ub978\u0020\ud504\ub85c\uadf8\ub7a8\uc758')) argo $([regex]::Unescape('\uba85\ub839\uc774\u0020\uc788\uc5b4')) argo $([regex]::Unescape('\uba85\ub839\uc744\u0020\ub4f1\ub85d\ud558\uc9c0\u0020\uc54a\uc558\uc2b5\ub2c8\ub2e4'))($([regex]::Unescape('\uadf8\u0020\ud30c\uc77c\uc740\u0020\uadf8\ub300\ub85c\u0020\ub461\ub2c8\ub2e4'))): $skip"; Say "Argo$([regex]::Unescape('\ub294\u0020\uc774\ub807\uac8c\u0020\uc2e4\ud589\ud569\ub2c8\ub2e4'))(cmd): $direct" }
  elseif ($other) { Say "PATH$([regex]::Unescape('\uc5d0\u0020\ub2e4\ub978\u0020\ud504\ub85c\uadf8\ub7a8\uc758')) argo$([regex]::Unescape('\uac00\u0020\uc788\uc5b4')) PATH$([regex]::Unescape('\uc5d0\u0020\ub123\uc9c0\u0020\uc54a\uc558\uc2b5\ub2c8\ub2e4')): $($other.Source)"; Say "Argo$([regex]::Unescape('\ub294\u0020\uc774\ub807\uac8c\u0020\uc2e4\ud589\ud569\ub2c8\ub2e4')): `"$shim`"" }
  else { Say "$([regex]::Unescape('\uc0c8\u0020\ud130\ubbf8\ub110\u0020\ucc3d\uc744\u0020\uc5f4\uba74\u0020\uc5b4\ub514\uc11c\ub4e0')) argo$([regex]::Unescape('\ub97c\u0020\uc4f8\u0020\uc218\u0020\uc788\uc2b5\ub2c8\ub2e4'))" }
  Say "$([regex]::Unescape('\ub2e4\uc74c')): argo  ($([regex]::Unescape('\ub85c\uadf8\uc778\u0020\u2014\u0020\ube0c\ub77c\uc6b0\uc800\uac00\u0020\uc5f4\ub9bd\ub2c8\ub2e4')))"
  Say "$([regex]::Unescape('\uc5c5\ub370\uc774\ud2b8')): $([regex]::Unescape('\uc124\uce58\u0020\uba85\ub839\uc744\u0020\ub2e4\uc2dc\u0020\uc2e4\ud589\u0020\u0020\u0020\uc81c\uac70')): argo uninstall ($([regex]::Unescape('\ub370\uc774\ud130')) $env:USERPROFILE\.argo $([regex]::Unescape('\ub294\u0020\ub0a8\uc2b5\ub2c8\ub2e4')))"
}
