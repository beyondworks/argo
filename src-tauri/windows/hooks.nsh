; Argo NSIS 훅 — 설치/제거 직전에 실행 중인 앱·사이드카를 종료한다.
; 배경: 사이드카 node.exe가 $INSTDIR\node.exe를 잠그고 있으면 설치가
; "Error opening file for writing: ...node.exe" 재시도 다이얼로그에서 멈춘다.
; 구버전(≤0.1.3)은 앱 종료 후에도 고아 node가 남아 수동 종료 없이는 업데이트가 안 됐다.
; 전역 node.exe는 개발용일 수 있으므로 절대 건드리지 않는다 — 설치 폴더 경로의 프로세스만 종료.

!macro NSIS_HOOK_PREINSTALL
  ; 실행 중 업데이트 — 앱 프로세스 트리(자식 사이드카 포함) 종료. 없으면 조용히 지나간다.
  nsExec::ExecToLog 'taskkill /F /T /IM argo.exe'
  ; 고아 사이드카 — 설치 폴더에서 실행 중인 node.exe만 골라 종료
  ; 경로 패턴은 PS 홑따옴표 — 설치 경로에 공백이 있어도 -Command 바깥 큰따옴표와 충돌하지 않는다
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like $\'$INSTDIR\*$\' } | Stop-Process -Force"'
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM argo.exe'
  ; 경로 패턴은 PS 홑따옴표 — 설치 경로에 공백이 있어도 -Command 바깥 큰따옴표와 충돌하지 않는다
  nsExec::ExecToLog 'powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like $\'$INSTDIR\*$\' } | Stop-Process -Force"'
  Sleep 500
!macroend
