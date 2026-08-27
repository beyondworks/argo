// 윈도우 NSIS 훅 — 업데이트 직전 실행 중인 앱·사이드카를 죽이는 훅의 계약을 잠근다.
// 실사고 1(2026-08-22 VM 실측): 메인 바이너리는 크레이트명 app.exe인데 훅은 argo.exe를 죽여 무효과 —
//   잠긴 파일 위로 설치가 진행돼 "업데이트 후 실행 파일 없음"(정@규, 08-20).
// 실사고 2(2026-08-27, v0.1.48 업데이트 설치 정지): nsExec가 powershell 자식을 무기한 대기 + /T(트리킬)가
//   구버전 앱이 띄운 설치기 자신을 죽일 수 있는 구조 → 훅은 ①무기한 대기 금지(분리 실행) ②트리킬 금지
//   ③무로그(taskkill '프로세스 없음'이 설치 화면에 오류로 오인 노출) 계약으로 전환.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const s = await readFile(new URL('../src-tauri/windows/hooks.nsh', import.meta.url), 'utf8');

test('hooks.nsh — taskkill은 하드코딩 이름이 아니라 ${MAINBINARYNAME}.exe를 겨냥한다', () => {
  const kills = [...s.matchAll(/taskkill[^\n']*\/IM\s+([^\s']+)/g)].map((m) => m[1]);
  assert.ok(kills.length >= 2, 'PREINSTALL·PREUNINSTALL 양쪽에 taskkill이 있어야 한다');
  for (const k of kills) assert.equal(k, '${MAINBINARYNAME}.exe', `하드코딩된 프로세스명: ${k}`);
});

test('hooks.nsh — 트리킬(/T) 금지: 업데이터(구버전 앱)의 자식인 설치기 자신을 죽인다', () => {
  assert.doesNotMatch(s, /taskkill[^\n]*\/T\b/, '/T 재도입 금지 — 사이드카는 경로 필터 node 정리가 맡는다(아래 테스트)');
  assert.match(s, /Get-Process node[^\n]*\$INSTDIR/, '경로 필터 node.exe 정리가 트리킬의 대체 수단으로 존재해야 한다');
});

test('hooks.nsh — 무기한 대기 금지: node 정리는 분리 실행(start) + 고정 Sleep', () => {
  // nsExec는 자식 종료까지 기다린다 — powershell이 기기 정책·AV에 물리면 설치가 통째로 멈춘다(실사고 2).
  const psLines = s.split('\n').filter((l) => /nsExec::\w+ .*powershell/.test(l));
  assert.ok(psLines.length >= 2, 'PREINSTALL·PREUNINSTALL 양쪽에 node 정리가 있어야 한다');
  for (const l of psLines) assert.match(l, /cmd \/c start/, `powershell 직접 대기 금지(분리 실행이어야): ${l.trim().slice(0, 60)}`);
  assert.match(s, /Sleep \d+/, '분리 실행 뒤 고정 대기가 있어야 정리 시간이 확보된다');
});

test('hooks.nsh — 무로그(Exec): taskkill "프로세스 없음"이 설치 화면에 노출되지 않는다', () => {
  assert.doesNotMatch(s, /ExecToLog/, 'ExecToLog 재도입 금지(오류 오인 노출 — 실사용 제보 2026-08-27)');
});
