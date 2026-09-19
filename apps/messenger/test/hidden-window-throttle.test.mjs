// D40(2026-09-19): 창을 가린(⌘H·최소화·닫기=가리기) 채 약 12분이 지나면 WKWebView 기본 정책(Suspend)이 WebContent를 멈춰
// 방송 수신·15초 합계 폴·setBadge·sendNotify가 전부 서고, 창을 되살릴 때 한꺼번에 처리됐다(계측 빌드 실측: 06:31:51~06:33:31 기록 0줄).
// 배지·알림이 웹뷰 JS에 있으므로 데스크톱 창은 억제를 끈다 — wry가 WKPreferences.inactiveSchedulingPolicy = None으로 적용(macOS 14+).
// 그것만으로는 앱 본체가 App Nap에 걸려 JS 수신이 30초 넘게 밀리고 배지·배너가 복원 때에야 적용됐다(3회차) → Info.plist NSAppSleepDisabled.
// src-tauri/Info.plist는 tauri 번들러가 macOS 앱 Info.plist에 합친다(계측 빌드의 번들 plist에서 값 확인).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
test('데스크톱 창은 가려져도 웹뷰를 멈추지 않는다(backgroundThrottling: disabled)', () => {
  assert.ok(conf.app.windows.length > 0);
  for (const w of conf.app.windows) assert.equal(w.backgroundThrottling, 'disabled', `${w.title ?? w.label}: 가린 창의 배지·알림이 멈춘다`);
});
test('앱 본체는 App Nap을 끈다(Info.plist NSAppSleepDisabled = true)', () => {
  const plist = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
  assert.match(plist, /<key>NSAppSleepDisabled<\/key>\s*<true\/>/, '가린 앱의 배지·알림 적용이 복원 때까지 밀린다');
});
