; Argo NSIS 훅 — 설치 폴더의 본체·사이드카만 종료한다.
; 업데이트 설치기는 구버전 앱의 자식이므로 트리 종료는 설치기 자신도 죽인다.
; PowerShell 정책/AV가 멈춰도 설치기는 기다리지 않도록 분리 실행 + 고정 대기를 유지한다.
; 정리가 늦거나 실패하면 NSIS의 "파일 사용 중" 재시도 화면이 처리한다.
!include LogicLib.nsh

; 분리된 정리가 늦거나 실패해도 제거가 등록 정보를 지우며 성공한 척하면 안 된다.
; 실행 중인 파일에 append 권한으로 열기만 시도한다(쓰기 없음). 10초 뒤에도 잠겨 있으면
; 사용자 Retry/Cancel, silent 설치는 취소한다. 다른 경로의 프로세스를 조회/종료하지 않는다.
!macro ARGO_ENSURE_FILE_UNLOCKED filePath
  Push $0
  Push $1
  Push $2
  StrCpy $0 "${filePath}"
  StrCpy $2 0
  ${Do}
    ${IfNot} ${FileExists} "$0"
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FileOpen $1 "$0" a
    ${IfNot} ${Errors}
      FileClose $1
      ${ExitDo}
    ${EndIf}
    IntOp $2 $2 + 1
    ${If} $2 >= 50
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(^FileError_NoIgnore)" /SD IDCANCEL IDRETRY +3
      SetErrorLevel 2
      Abort
      StrCpy $2 0
    ${EndIf}
    Sleep 200
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
!macroend

; Tauri는 utils.nsh → 이 훅 순서로 include하고, 각 PRE 훅 뒤에 이름 기반
; CheckIfAppIsRunning을 호출한다. 동명 종료 대신 본체·node의 파일 잠금만 확인한다.
!ifmacrodef CheckIfAppIsRunning
  !macroundef CheckIfAppIsRunning
!endif
!macro CheckIfAppIsRunning executableName productName
  !insertmacro ARGO_ENSURE_FILE_UNLOCKED "$INSTDIR\${executableName}"
  !insertmacro ARGO_ENSURE_FILE_UNLOCKED "$INSTDIR\node.exe"
!macroend

!macro ARGO_STOP_INSTALLED_PROCESSES
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  ReadEnvStr $0 "ARGO_NSIS_MAIN_EXE"
  ReadEnvStr $1 "ARGO_NSIS_NODE_EXE"
  ; 본체 이름은 제품명 argo가 아닌 Tauri 크레이트명(app.exe)이다.
  StrCpy $2 "$INSTDIR\${MAINBINARYNAME}.exe"
  StrCpy $3 "$INSTDIR\node.exe"
  ; 경로는 코드에 보간하지 않는다. 레지스터 → 프로세스 환경 → 자식 상속으로
  ; 공백·작은따옴표·와일드카드 문자를 그대로 전달한다(사용자/시스템 환경 변경 없음).
  System::Call 'kernel32::SetEnvironmentVariableW(w "ARGO_NSIS_MAIN_EXE", w r2) i .r4'
  ${If} $4 != 0
    System::Call 'kernel32::SetEnvironmentVariableW(w "ARGO_NSIS_NODE_EXE", w r3) i .r4'
    ${If} $4 != 0
      ; x86 설치기의 PowerShell에서도 x64 실행 경로를 읽도록 CIM을 쓴다.
      ; -contains는 문자열 동등 비교다. 다른 경로의 동명 본체·node에는 적용하지 않는다.
      nsExec::Exec 'cmd /c start "" /min powershell -NoProfile -NonInteractive -Command "$$targets=@($$env:ARGO_NSIS_MAIN_EXE,$$env:ARGO_NSIS_NODE_EXE); Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$targets -contains $$_.ExecutablePath } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
      Pop $4
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "ARGO_NSIS_MAIN_EXE", w r0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "ARGO_NSIS_NODE_EXE", w r1)'
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ARGO_STOP_INSTALLED_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ARGO_STOP_INSTALLED_PROCESSES
!macroend
