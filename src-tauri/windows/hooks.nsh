; Argo NSIS 훅 — 설치/제거 직전에 실행 중인 앱·사이드카를 종료한다.
; 배경: 사이드카 node.exe가 $INSTDIR\node.exe를 잠그고 있으면 설치가
; "Error opening file for writing: ...node.exe" 재시도 다이얼로그에서 멈춘다.
; 구버전(≤0.1.3)은 앱 종료 후에도 고아 node가 남아 수동 종료 없이는 업데이트가 안 됐다.
; 전역 node.exe는 개발용일 수 있으므로 절대 건드리지 않는다 — 설치 폴더 경로의 프로세스만 종료.
;
; 설계 제약(실사용 제보 2026-08-27, v0.1.48 업데이트 중 설치 정지):
; 1) **훅은 어떤 경우에도 무기한 대기하면 안 된다.** nsExec는 자식이 끝날 때까지 기다리므로,
;    powershell이 기기 정책·보안 프로그램에 물리면 설치가 통째로 멈춘다 → node 정리는
;    cmd start(분리 실행)로 발사만 하고 고정 시간만 기다린다. 정리가 못 끝났으면 NSIS의
;    "파일 사용 중" 재시도 다이얼로그가 잡는다 — 보이는 재시도가 보이지 않는 정지보다 낫다.
; 2) **트리 종료(/T) 금지.** 업데이트 설치기는 구버전 앱이 띄운다 — 앱이 아직 살아 있는 타이밍이면
;    /T가 자식인 설치기 자신을 죽인다. 앱 본체만 죽이고, 고아 자식(node)은 경로 필터 정리가 맡는다.
; 3) 무로그(Exec) — 앱이 꺼져 있을 때 taskkill의 "프로세스를 찾을 수 없습니다"가 설치 화면에
;    오류로 오인 노출됐다(같은 제보). 정상 부산물이므로 숨긴다.

!macro NSIS_HOOK_PREINSTALL
  ; 실행 파일 이름은 제품명(argo)이 아니라 크레이트명(app.exe)이다(윈도우 VM 실측 2026-08-22).
  ; Tauri가 정의하는 ${MAINBINARYNAME}으로 묶어 크레이트명이 바뀌어도 따라가게 한다.
  nsExec::Exec 'taskkill /F /IM ${MAINBINARYNAME}.exe'
  ; 고아 사이드카 — 설치 폴더에서 실행 중인 node.exe만 골라 종료. 분리 실행(무대기) — 위 설계 제약 1.
  ; 경로 패턴은 PS 홑따옴표 — 설치 경로에 공백이 있어도 -Command 바깥 큰따옴표와 충돌하지 않는다.
  nsExec::Exec 'cmd /c start "" /min powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like $\'$INSTDIR\*$\' } | Stop-Process -Force"'
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM ${MAINBINARYNAME}.exe'
  nsExec::Exec 'cmd /c start "" /min powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like $\'$INSTDIR\*$\' } | Stop-Process -Force"'
  Sleep 1500
!macroend
