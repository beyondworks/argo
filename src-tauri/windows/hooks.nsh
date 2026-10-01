; Argo NSIS 훅 — 설치 폴더의 본체·사이드카만 종료한다.
; 업데이트 설치기는 구버전 앱의 자식이므로 트리 종료는 설치기 자신도 죽인다.
; PowerShell 정책/AV가 멈춰도 설치기는 기다리지 않도록 분리 실행 + 고정 대기를 유지한다.
; 정리가 늦거나 실패하면 NSIS의 "파일 사용 중" 재시도 화면이 처리한다.
!include LogicLib.nsh
; 터미널 명령 argo(아래 ARGO_CLI_* 매크로)가 PATH 항목을 문자열로 다룬다 — WordFunc(Tauri 템플릿이 먼저 include)의 WordReplace를 설치기·제거기 양쪽에 선언한다.
!insertmacro WordReplace
!insertmacro un.WordReplace

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

; ───────────────────────────────────────────────────────────────────────────────────────────────────
; 터미널 명령 argo — 앱을 설치하면 따라온다(설계 2-4, 반대 검토 H1·M-e, 2026-10-01).
;  · $INSTDIR\cli\argo.cmd 를 만든다(앱 번들 node.exe + server\bin\argo.mjs, ARGO_CLI_APP=1).
;  · 사용자 PATH(HKCU\Environment\Path)에 $INSTDIR\cli 를 **끝에** 한 번만 추가한다. REG_EXPAND_SZ로 쓴다(%VAR%를 펼치지 않는다).
;    다른 프로그램의 argo가 이미 PATH에 있으면(`where argo`에 우리 폴더 밖의 줄이 있으면) 추가하지 않고 conflict로 남긴다 — 덮어쓰지도 가리지도 않는다.
;    PATH 값을 안전하게 읽을 수 없으면(NSIS 문자열 한도 1024자 초과·읽기 실패) 손대지 않고 path-skipped로 남긴다(긴 PATH가 잘려 사용자 PATH가 망가지는 것을 막는다).
;    "값 없음"은 읽기 오류와 구분한다 — 사용자 PATH가 비어 있는 사용자도 등록된다.
;  · 결과는 %LOCALAPPDATA%\com.beyondworks.argo\cli-install.json({"status":"installed|conflict|path-skipped"}, ASCII)에 남긴다 — 앱 설정 화면이 읽는다. 다른 argo의 경로는 앱이 PATH를 직접 훑어 보여 준다(NSIS는 ANSI로 써서 한글 경로가 깨진다).
;  · 업데이트(passive)에서도 같은 훅이 실행된다 — 이미 들어 있으면 PATH를 다시 쓰지 않는다.
;  · 제거는 **정확히 같은** PATH 항목만 지우고 cli 폴더·결과 파일을 삭제한다. 업데이트 모드에서는 옛 제거기가 실행되지 않는다(installer.nsi).
; 알려진 한계: .cmd 래퍼는 Ctrl+C 뒤 "일괄 작업을 끝내시겠습니까" 질문이 뜰 수 있고 &·^ 인자 처리에 한계가 있다(실기기 확인 필요).
!define ARGO_CLI_MARK "argo-cli-shim v1 com.beyondworks.argo"
!define ARGO_HKCU_ENV 0x80000001
!define ARGO_KEY_READ 0x20019

; 결과 파일 — $R8(installed|conflict|path-skipped)을 ASCII JSON으로. 앱(src/cli-install.mjs cliInstallStatus)이 읽는다.
!macro ARGO_CLI_STATE_VAR
  ReadEnvStr $R7 "LOCALAPPDATA"
  ${If} $R7 != ""
    CreateDirectory "$R7\${BUNDLEID}"
    FileOpen $R6 "$R7\${BUNDLEID}\cli-install.json" w
    ${IfNot} ${Errors}
      FileWrite $R6 '{"status":"$R8"}$\r$\n'
      FileClose $R6
    ${EndIf}
  ${EndIf}
!macroend

!macro ARGO_CLI_BROADCAST
  ; 열려 있는 탐색기·새 터미널이 바뀐 환경변수를 읽게 한다(응답 없는 창은 5초 뒤 포기)
  System::Call 'user32::SendMessageTimeoutW(i 0xffff, i 0x1A, i 0, w "Environment", i 2, i 5000, *i .r0)'
!macroend

!macro ARGO_CLI_POSTINSTALL
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ; 1) argo.cmd — ASCII만(cmd는 OEM 코드 페이지로 읽는다)
  CreateDirectory "$INSTDIR\cli"
  FileOpen $0 "$INSTDIR\cli\argo.cmd" w
  ${IfNot} ${Errors}
    FileWrite $0 "@echo off$\r$\n"
    FileWrite $0 "rem ${ARGO_CLI_MARK} - created by the Argo installer, safe to delete$\r$\n"
    FileWrite $0 "setlocal$\r$\n"
    FileWrite $0 'set "ARGO_CLI_APP=1"$\r$\n'
    FileWrite $0 '"%~dp0..\node.exe" "%~dp0..\server\bin\argo.mjs" %*$\r$\n'
    FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
    FileClose $0
    ; 2) 다른 argo — `where argo`에서 우리 폴더가 아닌 줄이 하나라도 있으면 findstr이 0으로 끝난다. 경로는 환경변수로 넘긴다(공백·특수문자 보간 금지, 끝의 \\ 는 findstr이 따옴표 이스케이프로 읽으므로 뺀다).
    StrCpy $R8 "ok"
    System::Call 'kernel32::SetEnvironmentVariableW(w "ARGO_NSIS_CLI_DIR", w "$INSTDIR\cli") i .r1'
    ${If} $1 != 0
      nsExec::Exec 'cmd /d /c "where argo 2>nul | findstr /v /i /c:$\"%ARGO_NSIS_CLI_DIR%$\" >nul"'
      Pop $2
      ${If} $2 == 0
        StrCpy $R8 "conflict"
      ${EndIf}
    ${Else}
      StrCpy $R8 "path-skipped" ; 판정 못 하면 PATH를 건드리지 않는다
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "ARGO_NSIS_CLI_DIR", i 0)'
    ; 3) PATH 추가 — conflict·판정 불가면 건너뜀
    ${If} $R8 == "ok"
      ; 값의 크기부터 본다: 0 = 있음(바이트 수는 $4), 2 = 값 없음, 그 밖 = 읽을 수 없음
      System::Call 'advapi32::RegOpenKeyExW(i ${ARGO_HKCU_ENV}, w "Environment", i 0, i ${ARGO_KEY_READ}, *i .r1) i .r2'
      ${If} $2 == 0
        System::Call 'advapi32::RegQueryValueExW(i r1, w "Path", i 0, *i .r3, i 0, *i .r4) i .r2'
        System::Call 'advapi32::RegCloseKey(i r1)'
      ${Else}
        StrCpy $2 "-1"
      ${EndIf}
      StrCpy $R9 ""
      ${If} $2 == 0
        ${If} $4 <= 2000 ; 문자 1000개 이하(UTF-16) — NSIS 문자열 한도(1024)에 맞는다
          ReadRegStr $R9 HKCU "Environment" "Path"
          ${If} ${Errors}
            StrCpy $R8 "path-skipped"
          ${EndIf}
        ${Else}
          StrCpy $R8 "path-skipped"
        ${EndIf}
      ${ElseIf} $2 != 2
        StrCpy $R8 "path-skipped"
      ${EndIf}
      ${If} $R8 == "ok"
        ; 이미 들어 있으면(;로 감싸 정확히 같은 항목만) 다시 쓰지 않는다
        ${WordReplace} ";$R9;" ";$INSTDIR\cli;" ";" "+*" $R6
        ${If} $R6 == ";$R9;"
          ${If} $R9 == ""
            StrCpy $R6 "$INSTDIR\cli"
          ${Else}
            StrCpy $R6 "$R9;$INSTDIR\cli"
          ${EndIf}
          WriteRegExpandStr HKCU "Environment" "Path" "$R6"
          !insertmacro ARGO_CLI_BROADCAST
        ${EndIf}
        StrCpy $R8 "installed"
      ${EndIf}
    ${EndIf}
    !insertmacro ARGO_CLI_STATE_VAR
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro ARGO_CLI_POSTUNINSTALL
  Push $0
  Push $R6
  Push $R7
  Push $R9
  ReadRegStr $R9 HKCU "Environment" "Path"
  ${IfNot} ${Errors}
    ; ;로 감싸 정확히 같은 항목만 지운다 — 앞뒤 ;를 정리해 다른 항목은 바이트 그대로 둔다
    ${un.WordReplace} ";$R9;" ";$INSTDIR\cli;" ";" "+*" $R6
    ${If} $R6 != ";$R9;"
      StrCpy $0 $R6 1
      ${If} $0 == ";"
        StrCpy $R6 $R6 "" 1
      ${EndIf}
      StrCpy $0 $R6 1 -1
      ${If} $0 == ";"
        StrCpy $R6 $R6 -1
      ${EndIf}
      WriteRegExpandStr HKCU "Environment" "Path" "$R6"
      !insertmacro ARGO_CLI_BROADCAST
    ${EndIf}
  ${EndIf}
  Delete "$INSTDIR\cli\argo.cmd"
  RmDir "$INSTDIR\cli"
  ReadEnvStr $R7 "LOCALAPPDATA"
  ${If} $R7 != ""
    Delete "$R7\${BUNDLEID}\cli-install.json"
  ${EndIf}
  Pop $R9
  Pop $R7
  Pop $R6
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro ARGO_CLI_POSTINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro ARGO_CLI_POSTUNINSTALL
!macroend
