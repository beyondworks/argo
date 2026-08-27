; Argo NSIS 훅 — 설치/제거 직전에 실행 중인 앱·사이드카를 종료한다.
; 배경: 사이드카 node.exe가 $INSTDIR\node.exe를 잠그고 있으면 설치가
; "Error opening file for writing: ...node.exe" 재시도 다이얼로그에서 멈춘다.
; 구버전(≤0.1.3)은 앱 종료 후에도 고아 node가 남아 수동 종료 없이는 업데이트가 안 됐다.
; 전역 node.exe는 개발용일 수 있으므로 절대 건드리지 않는다 — 설치 폴더 경로의 프로세스만 종료.

!macro NSIS_HOOK_PREINSTALL
  ; 실행 파일 이름은 제품명(argo)이 아니라 크레이트명(app.exe)이다 — 'argo.exe'를 죽이던 이전 훅은 아무것도
  ; 못 죽였다(윈도우 VM 실측 2026-08-22: MainBinaryName=app.exe, 업데이트 중 app.exe·node.exe 생존).
  ; Tauri가 정의하는 ${MAINBINARYNAME}으로 묶어 크레이트명이 바뀌어도 따라가게 한다.
  ; 실행 중 업데이트 — 앱 프로세스 트리(자식 사이드카 포함) 종료. 없으면 조용히 지나간다.
  ; nsExec::Exec(무로그) — ExecToLog는 앱이 꺼져 있을 때 taskkill의 "프로세스를 찾을 수 없습니다"를
  ; 설치 화면에 그대로 노출해 오류로 오인됐다(실사용 제보 2026-08-27, v0.1.48 업데이트 중). 정상
  ; 부산물이므로 숨긴다 — 실패해도 설치는 계속되고, 잠긴 파일은 NSIS 자체 재시도 다이얼로그가 잡는다.
  nsExec::Exec 'taskkill /F /T /IM ${MAINBINARYNAME}.exe'
  ; 고아 사이드카 — 설치 폴더에서 실행 중인 node.exe만 골라 종료
  ; 경로 패턴은 PS 홑따옴표 — 설치 경로에 공백이 있어도 -Command 바깥 큰따옴표와 충돌하지 않는다
  nsExec::Exec 'powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like $\'$INSTDIR\*$\' } | Stop-Process -Force"'
  Sleep 500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM ${MAINBINARYNAME}.exe'
  ; 경로 패턴은 PS 홑따옴표 — 설치 경로에 공백이 있어도 -Command 바깥 큰따옴표와 충돌하지 않는다
  nsExec::Exec 'powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like $\'$INSTDIR\*$\' } | Stop-Process -Force"'
  Sleep 500
!macroend
