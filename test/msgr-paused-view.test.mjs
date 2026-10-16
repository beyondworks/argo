// 메신저가 쉬는 동안 설정 › 연결 화면의 세 칸(0.1.113, 유건 캡처 2026-10-16) — 스위치 켬이면 쉬는 중 안내, 꺼짐·모름이면 main과 똑같이.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { msgrPausedView, runtimeAction } from '../app/c/[ws]/settings/msgr-card.mjs';

const MAIN = { descKey: 'settings.msgr.downloadHelp', showHelp: true, runtimeKey: null, runtimeButton: true, notifyNoteKey: null };

test('스위치 켬 — 카드 설명은 쉬는 중, 조직 안내 숨김, 응답 상태는 쉬는 중 문구 + 단추 없음, 알림 칸 아래 안내', () => {
  assert.deepEqual(msgrPausedView(true), {
    descKey: 'settings.msgr.pausedHelp', showHelp: false, runtimeKey: 'settings.msgr.runtime.paused', runtimeButton: false, notifyNoteKey: 'settings.notify.msgrPaused',
  });
});

test('스위치 꺼짐·모름(로드 전·옛 서버·오류) — main과 같은 키·단추', () => {
  for (const v of [false, undefined, null, 'true', 1]) assert.deepEqual(msgrPausedView(v), MAIN, String(v));
  // 꺼짐이면 단추 판정은 종전 runtimeAction 그대로(offline → 다시 연결)
  assert.equal(runtimeAction('offline', { polling: false }), 'reconnect');
});

test('사전 — 세 문구 ko·en', async () => {
  const dict = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  assert.match(dict, /'settings\.msgr\.pausedHelp': \['Argo Messenger는 안정화를 위해 잠시 쉬고 있습니다\. 지금까지의 기록은 아래에서 볼 수 있습니다\.', 'Argo Messenger is taking a short break/);
  assert.match(dict, /'settings\.msgr\.runtime\.paused': \['메신저가 안정화를 위해 쉬고 있습니다\. 다시 열리면 자동으로 이어집니다\.', 'Messenger is resting/);
  assert.match(dict, /'settings\.notify\.msgrPaused': \['메신저가 쉬는 동안에는 메신저로 알림이 가지 않습니다\. 텔레그램을 켜거나 Argo 앱에서 확인하세요\.', 'While Messenger is resting/);
});

// 배선 확인(보조 — 행동은 위 판정 시험이 잠근다): 세 칸이 msgrPausedView의 값을 쓰고, 스위치 값은 이관 영역 응답 하나에서 온다
test('배선 — 설정 화면은 세 칸을 msgrPausedView로만 그리고, 스위치 값은 이관 영역(onArchiveState)에서 받는다', async () => {
  const page = await readFile(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  assert.match(page, /<NotifyChannelsCard ws=\{ws\} paused=\{msgrPaused\} \/>/);
  assert.match(page, /<MsgrCard ws=\{ws\} agents=\{data\?\.agents \?\? \[\]\} paused=\{msgrPaused\} onArchiveState=\{onArchiveState\} \/>/);
  assert.match(page, /\{t\(pv\.descKey\)\}/);
  assert.match(page, /pv\.runtimeKey \? t\(pv\.runtimeKey\)/);
  assert.match(page, /const runtimeButton = !pv\.runtimeButton \? null/);
  assert.match(page, /pv\.notifyNoteKey && /);
  assert.match(page, /\{pv\.showHelp && st\?\.signedIn && !st\.orgs\?\.length && /, '쉬는 동안 개인 공간 "팀과 함께 쓰려면" 줄도 숨긴다');
  assert.doesNotMatch(page, /\{t\('settings\.msgr\.downloadHelp'\)\}/, '설명을 직접 그리는 옛 줄이 남지 않는다');
});
