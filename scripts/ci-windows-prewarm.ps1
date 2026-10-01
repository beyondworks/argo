# Windows CI 예열 — 테스트가 처음 띄우는 큰 실행 파일을 미리 한 번 띄워 디스크에 올려 둔다(test.yml이 백그라운드로 실행).
# 실측(2026-10-01 관찰 워크플로, 유휴 러너): 32비트 PowerShell 첫 기동 16~70초·두 번째 0.2초, Chrome 첫 기동 5~74초·두 번째 1초.
# Defender 실시간 검사는 꺼져 있었다 — 러너 이미지 디스크가 파일을 처음 읽을 때만 느리다. 이 비용이 테스트 안에서 나면
# nsis-hooks(PowerShell 90초 예열)·K58(브라우저 60초 기동) 같은 시간 상한에 걸린다. 결과는 $env:RUNNER_TEMP\prewarm.log에 남는다.
$log = Join-Path $env:RUNNER_TEMP 'prewarm.log'
$ps32 = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe' # NSIS 설치기(32비트)가 부르는 사본 — nsis-hooks 테스트와 같은 것
$chrome = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
try {
  $t = Measure-Command { & $ps32 -NoProfile -NonInteractive -Command 'exit 0' }
  "powershell32 $([int]$t.TotalMilliseconds)ms" | Add-Content $log
  if (Test-Path $chrome) {
    $t = Measure-Command { & $chrome --headless=new "--user-data-dir=$(Join-Path $env:RUNNER_TEMP 'prewarm-chrome')" --no-first-run --dump-dom about:blank | Out-Null }
    "chrome $([int]$t.TotalMilliseconds)ms" | Add-Content $log
  } else { "chrome missing: $chrome" | Add-Content $log }
} catch { "error: $_" | Add-Content $log }
'done' | Add-Content $log
