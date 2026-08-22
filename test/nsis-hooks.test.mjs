// 윈도우 NSIS 훅 — 업데이트 직전 실행 중인 앱·사이드카를 죽이는 훅이 **실제 실행 파일 이름**을 겨냥하는지 잠근다.
// 실사고(2026-08-22 VM 실측): 메인 바이너리는 크레이트명 app.exe인데 훅은 argo.exe를 죽여 아무 효과가 없었고,
// 잠긴 app.exe·node.exe 위로 설치가 진행돼 "업데이트 후 실행 파일 없음" 제보(정@규, 08-20)로 이어졌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('hooks.nsh — taskkill은 하드코딩 이름이 아니라 ${MAINBINARYNAME}.exe를 겨냥한다', async () => {
  const s = await readFile(new URL('../src-tauri/windows/hooks.nsh', import.meta.url), 'utf8');
  const kills = [...s.matchAll(/taskkill[^\n']*\/IM\s+([^\s']+)/g)].map((m) => m[1]);
  assert.ok(kills.length >= 2, 'PREINSTALL·PREUNINSTALL 양쪽에 taskkill이 있어야 한다');
  for (const k of kills) assert.equal(k, '${MAINBINARYNAME}.exe', `하드코딩된 프로세스명: ${k}`);
  assert.match(s, /taskkill \/F \/T /, '/T(프로세스 트리) — 사이드카 node.exe가 자식으로 함께 죽어야 한다');
});
