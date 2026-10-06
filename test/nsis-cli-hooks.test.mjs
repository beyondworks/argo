// 윈도우 설치 프로그램의 argo 등록(src-tauri/windows/hooks.nsh ARGO_CLI_*) — 설계 2-4(2026-10-01).
// 이 맥·리눅스에서는 NSIS 설치기를 실행할 수 없다. 그래서 두 층으로 잠근다:
//  ① 계약 단언(소스 문자열 — 약한 게이트라 인정): PATH는 REG_EXPAND_SZ로 끝에 한 번, 남의 argo는 건너뜀, 읽을 수 없으면 손대지 않음, 제거는 정확히 같은 항목만.
//  ② 컴파일 — makensis가 있으면(ARGO_MAKENSIS=<경로>, 필요하면 NSISDIR) 템플릿과 같은 include 순서의 하네스로 hooks.nsh가 **컴파일되는지** 본다. 없으면 건너뛴다.
// 실제 실행(`/S` 설치 → HKCU Path 1회, 가짜 argo.cmd가 있을 때 conflict, `/S` 제거 뒤 나머지 항목 바이트 동일, 새 cmd에서 argo status)은 windows-latest·실기기에서만 확인된다 — 미검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('../src-tauri/windows/hooks.nsh', import.meta.url));
const s = await readFile(HOOKS, 'utf8');
const section = (name) => s.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`))?.[1] ?? '';

test('설치 훅 — argo.cmd는 번들 node.exe로 server\\bin\\argo.mjs를 실행하고 ARGO_CLI_APP=1을 넘긴다', () => {
  const m = section('ARGO_CLI_POSTINSTALL');
  assert.match(m, /CreateDirectory "\$INSTDIR\\cli"/);
  assert.match(m, /FileOpen \$0 "\$INSTDIR\\cli\\argo\.cmd" w/);
  assert.match(m, /set "ARGO_CLI_APP=1"/);
  assert.ok(m.includes('"%~dp0..\\node.exe" "%~dp0..\\server\\bin\\argo.mjs" %*'));
  assert.match(m, /exit \/b %ERRORLEVEL%/);
  assert.match(m, /\$\{ARGO_CLI_MARK\}/, '앱이 우리 파일로 알아보는 표식');
  assert.doesNotMatch(m.slice(m.indexOf('FileOpen'), m.indexOf('FileClose')), /[^\x00-\x7F]/, 'cmd는 OEM 코드 페이지로 읽는다 — ASCII만');
});

test('설치 훅 — 사용자 PATH(HKCU) 끝에 한 번만, REG_EXPAND_SZ로(%VAR% 보존), 전체 재작성은 값이 바뀔 때만', () => {
  const m = section('ARGO_CLI_POSTINSTALL');
  assert.match(m, /WriteRegExpandStr HKCU "Environment" "Path" "\$R6"/);
  assert.doesNotMatch(s, /WriteRegStr HKCU "Environment"|WriteRegStr HKLM|HKLM "SYSTEM/, '시스템 PATH·REG_SZ로 쓰면 %USERPROFILE% 항목이 펼쳐진다');
  assert.match(m, /StrCpy \$R6 "\$R9;\$INSTDIR\\cli"/, '끝에 붙인다 — 다른 도구의 명령 순서를 바꾸지 않는다');
  assert.match(m, /\$\{WordReplace\} ";\$R9;" ";\$INSTDIR\\cli;" ";" "\+\*" \$R6\s+\$\{If\} \$R6 == ";\$R9;"/, '이미 들어 있으면(정확히 같은 항목) 다시 쓰지 않는다 — 업데이트(passive)도 같은 훅');
  assert.match(m, /WriteRegExpandStr[\s\S]*ARGO_CLI_BROADCAST/, 'PATH를 쓴 직후 방송');
  assert.match(section('ARGO_CLI_BROADCAST'), /SendMessageTimeoutW\(i 0xffff, i 0x1A, i 0, w "Environment"/, 'WM_SETTINGCHANGE');
});

test('설치 훅 — 값이 없는 사용자는 등록하고, 읽을 수 없거나 너무 길면 손대지 않는다(path-skipped)', () => {
  const m = section('ARGO_CLI_POSTINSTALL');
  assert.match(m, /RegQueryValueExW/, '값 없음(2)과 읽기 실패를 구분하려고 크기부터 본다');
  assert.match(m, /\$\{ElseIf\} \$2 != 2\s+StrCpy \$R8 "path-skipped"/, '값 없음(2)만 빈 PATH로 보고, 그 밖의 오류는 건드리지 않는다');
  // 길이 기준 = 읽은 값 + 덧붙일 ";$INSTDIR\cli" + 여유 3이 컴파일 때 정해지는 NSIS 문자열 한도(${NSIS_MAX_STRLEN})에 들어가는가 — 값 길이만 보면 덧붙인 결과가 한도를 넘어 잘려 쓰인다(독립 검수 #800 LOW-2)
  assert.match(m, /StrLen \$R5 "\$INSTDIR\\cli"/, '덧붙일 항목의 길이를 잰다');
  assert.match(m, /IntOp \$R4 \$4 \/ 2[^\n]*\n\s*IntOp \$R4 \$R4 - 1/, '바이트 → 문자 수(끝 NUL 제외)');
  assert.match(m, /IntOp \$R5 \$R5 \+ 3\s+IntOp \$R4 \$R4 \+ \$R5\s+\$\{If\} \$R4 <= \$\{NSIS_MAX_STRLEN\}/, '읽은 값 + 항목 + 여유 3 <= NSIS_MAX_STRLEN');
  assert.doesNotMatch(m, /<= 2000/, '고정 상수로 비교하지 않는다');
  assert.match(m, /ReadRegStr \$R9 HKCU "Environment" "Path"\s+\$\{If\} \$\{Errors\}\s+StrCpy \$R8 "path-skipped"/);
});

test('설치 훅 — 다른 프로그램의 argo가 PATH에 있으면 추가하지 않고 conflict로 남긴다', () => {
  const m = section('ARGO_CLI_POSTINSTALL');
  assert.ok(m.includes('where argo 2>nul | findstr /v /i /c:$\\"%ARGO_NSIS_CLI_DIR%$\\" /c:$\\"%ARGO_NSIS_SA_DIR%$\\" >nul'), '우리 폴더·단독 argo 폴더가 아닌 줄이 하나라도 있으면 findstr이 0');
  assert.match(m, /SetEnvironmentVariableW\(w "ARGO_NSIS_CLI_DIR", w "\$INSTDIR\\cli"\)/, '경로는 환경변수로 넘긴다(보간 금지)');
  assert.match(m, /\$\{If\} \$2 == 0\s+StrCpy \$R8 "conflict"/);
  assert.match(m, /\$\{If\} \$R8 == "ok"\s+; 값의 크기부터/, 'conflict면 PATH 단계로 가지 않는다');
});

// 경우 표 P2(2026-10-06): 설치 명령(install.ps1)으로 넣은 단독 argo는 충돌이 아니라 바꿀 대상 — 그 PATH 항목만 정확히 빼고 앱 cli를 넣는다
test('설치 훅 — 단독 argo(argo-selfhost 표식)가 있으면 충돌로 보지 않고 그 PATH 항목만 빼고 앱 cli를 넣는다', () => {
  const m = section('ARGO_CLI_POSTINSTALL');
  assert.ok(m.includes('findstr /m /c:$\\"argo-cli-shim v1 argo-selfhost$\\" $\\"%LOCALAPPDATA%\\argo-cli\\bin\\argo.cmd$\\"'), '표식이 있는 우리 단독 argo.cmd만');
  assert.match(m, /StrCpy \$R3 "\$R7\\argo-cli\\bin"/);
  assert.match(m, /\$\{If\} \$R3 == ""\s+System::Call 'kernel32::SetEnvironmentVariableW\(w "ARGO_NSIS_SA_DIR", w "\$INSTDIR\\cli"\)/, '단독 argo가 없으면 빈 /c:(모든 줄과 맞음)를 쓰지 않는다');
  assert.match(m, /\$\{WordReplace\} ";\$R9;" ";\$R3;" ";" "\+\*" \$R6/, ';로 감싸 정확히 같은 항목만 뺀다');
  assert.match(m, /\$\{ElseIf\} \$R2 == "1"\s+WriteRegExpandStr HKCU "Environment" "Path" "\$R9"/, '앱 cli가 이미 있어도 단독 항목을 뺐으면 쓴다');
  const pushes = [...m.matchAll(/^\s*Push (\$\w+)/gm)].map((x) => x[1]); const pops = [...m.slice(m.lastIndexOf('ARGO_CLI_STATE_VAR')).matchAll(/^\s*Pop (\$\w+)/gm)].map((x) => x[1]); // 끝의 복원 구간만(nsExec 결과를 꺼내는 Pop $2는 제외)
  assert.deepEqual(pops, [...pushes].reverse(), 'Push·Pop 짝(레지스터 보존)');
});

test('설치 훅 — 결과는 ASCII 한 줄로 %LOCALAPPDATA%\\<번들 id>\\cli-install.json에', () => {
  const m = section('ARGO_CLI_STATE_VAR');
  assert.match(m, /ReadEnvStr \$R7 "LOCALAPPDATA"/);
  assert.match(m, /cli-install\.json" w/);
  assert.ok(m.includes(`'{"status":"$R8"}`));
  assert.ok(section('ARGO_CLI_POSTINSTALL').includes('ARGO_CLI_STATE_VAR'));
});

test('제거 훅 — PATH 값이 NSIS 문자열 한도에 가까우면 잘린 값을 되써서 사용자 PATH를 망가뜨리지 않도록 건드리지 않는다(독립 검수 #800 LOW-2)', () => {
  const m = section('ARGO_CLI_POSTUNINSTALL');
  assert.match(m, /RegQueryValueExW\(i r1, w "Path"/, '크기부터 본다');
  assert.match(m, /IntOp \$R4 \$R4 \+ 3[^\n]*\n\s*\$\{If\} \$R4 <= \$\{NSIS_MAX_STRLEN\}/, '";" 감싸기(+2)와 여유를 더해도 한도 안일 때만 읽고 되쓴다');
  assert.match(m, /\$\{If\} \$2 == 0[\s\S]*ReadRegStr \$R9 HKCU "Environment" "Path"/, '크기 확인을 통과한 값만 읽는다');
});

test('제거 훅 — 정확히 같은 PATH 항목만 지우고(앞뒤 ; 정리) cli 폴더·결과 파일을 지운다, 값이 바뀔 때만 쓴다', () => {
  const m = section('ARGO_CLI_POSTUNINSTALL');
  assert.match(m, /\$\{un\.WordReplace\} ";\$R9;" ";\$INSTDIR\\cli;" ";" "\+\*" \$R6\s+\$\{If\} \$R6 != ";\$R9;"/);
  assert.match(m, /WriteRegExpandStr HKCU "Environment" "Path" "\$R6"/);
  assert.match(m, /Delete "\$INSTDIR\\cli\\argo\.cmd"\s+RmDir "\$INSTDIR\\cli"/, 'RmDir /r 금지 — 우리 파일만');
  assert.match(m, /Delete "\$R7\\\$\{BUNDLEID\}\\cli-install\.json"/);
  assert.doesNotMatch(m, /RmDir \/r/);
});

test('기존 종료 훅은 그대로 — PREINSTALL·PREUNINSTALL은 종전 정리를, POST 훅은 argo 등록·제거를 부른다', () => {
  assert.match(s, /!macro NSIS_HOOK_PREINSTALL\s+!insertmacro ARGO_STOP_INSTALLED_PROCESSES/);
  assert.match(s, /!macro NSIS_HOOK_PREUNINSTALL\s+!insertmacro ARGO_STOP_INSTALLED_PROCESSES/);
  assert.match(s, /!macro NSIS_HOOK_POSTINSTALL\s+!insertmacro ARGO_CLI_POSTINSTALL/);
  assert.match(s, /!macro NSIS_HOOK_POSTUNINSTALL\s+!insertmacro ARGO_CLI_POSTUNINSTALL/);
});

// makensis 위치 — 환경변수 > PATH(which) > 윈도우 러너의 기본 설치 위치(GitHub windows 이미지는 NSIS를 포함한다)
const winNsis = process.platform === 'win32' ? ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'].find((f) => existsSync(f)) : '';
const makensis = process.env.ARGO_MAKENSIS || winNsis || (process.platform === 'win32' ? '' : spawnSync('which', ['makensis'], { encoding: 'utf8' }).stdout.trim());
test('hooks.nsh가 템플릿과 같은 include 순서에서 컴파일된다', { skip: !makensis && 'makensis 없음(ARGO_MAKENSIS)' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-nsis-compile-'));
  try {
    const harness = `Unicode true
!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "StrFunc.nsh"
\${StrCase}
\${StrLoc}
!define BUNDLEID "com.beyondworks.argo"
!define MAINBINARYNAME "app"
!include "${HOOKS.replaceAll('\\', '/')}"
Name "harness"
OutFile "${join(dir, 'harness.exe').replaceAll('\\', '/')}"
InstallDir "$PROGRAMFILES\\Argo"
RequestExecutionLevel user
Section Install
  !insertmacro NSIS_HOOK_PREINSTALL
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
Section Uninstall
  !insertmacro NSIS_HOOK_PREUNINSTALL
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
`;
    await writeFile(join(dir, 'harness.nsi'), harness);
    const r = spawnSync(makensis, ['-V2', join(dir, 'harness.nsi')], { encoding: 'utf8', env: process.env });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-3000));
    assert.doesNotMatch(r.stdout, /\berror\b/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
