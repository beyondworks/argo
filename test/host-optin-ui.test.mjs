// "이 컴퓨터 로그인 사용" 옵트인 — 실패 자체 제거 계약(유건 지시 2026-08-26 "실패 자체가 있으면 안 돼").
// 실사용 제보(v0.1.47): 미검지 상태에서 버튼이 노출돼 클릭→서버 거절→무언 복귀(0.1초 깜빡)로 보였다.
// 소스 계약: ① 버튼은 성공 가능 상태(hostReady)에서만, ② 아닐 땐 설치/로그인 안내를 처음부터,
// ③ 실패 사유(msg) 렌더 자리가 옵트인 행에 존재(엣지 방어선).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../app/runner-connect.jsx', import.meta.url), 'utf8');

test('버튼은 hostReady(설치 + 로그인/판정불가)일 때만 렌더된다', () => {
  assert.match(src, /const hostReady = !!st\?\.hostInstalled && \(!!st\?\.hostAuthed \|\| !!st\?\.hostAuthUnknown\)/, 'hostReady 판정');
  assert.match(src, /hostReady \? \(\s*<button[^>]*onClick=\{useHost\}/, '버튼이 hostReady 분기 안에 있어야(무조건 노출 회귀 금지)');
});

test('비준비 상태는 안내를 렌더 — 미설치(설치 링크)·미로그인(터미널 안내)', () => {
  assert.match(src, /hostNeedInstall/, '미설치 안내 키');
  assert.match(src, /hostInstallGuide/, '설치 링크 라벨');
  assert.match(src, /hostNeedLogin/, '미로그인 안내 키');
});

test('옵트인 행에 실패 사유(msg) 렌더 자리가 있다 — 무언 실패 회귀 금지', () => {
  assert.match(src, /busyWasHost\.current && <span[^>]*>\{msg\}/, 'host 실패 msg 렌더');
});

test('i18n — 새 키 ko/en 등록', async () => {
  const i18n = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of ['settings.runners.hostNeedInstall', 'settings.runners.hostInstallGuide', 'settings.runners.hostNeedLogin']) {
    assert.ok(i18n.includes(`'${k}'`), `${k} 등록`);
  }
});
