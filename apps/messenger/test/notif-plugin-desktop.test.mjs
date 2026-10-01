// 알림 배너 탭 → 채팅 이동(유건 요청 2026-10-01). 일반 알림 플러그인(tauri-plugin-notification)은 iOS에서 플러그인을 만드는 순간
// UNUserNotificationCenter delegate를 자기로 지정하고(NotificationManager.swift init), 원격 푸시 탭(UNPushNotificationTrigger)은 버린다.
// 씬 생명주기(0.1.27~)에서는 푸시 플러그인이 웹뷰 생성 때에야 delegate를 되찾아, 꺼진 앱을 연 배너 탭이 JS까지 오지 않을 수 있었다.
// 모바일 JS는 이 플러그인을 쓰지 않으므로(notify.js가 모바일이면 먼저 반환) 모바일 빌드에서는 플러그인 자체를 빼 둔다 — 설정 핀.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const section = (toml, header) => toml.split(header)[1]?.split('\n[')[0] ?? '';

test('일반 알림 플러그인은 데스크톱 의존성·데스크톱 빌더·데스크톱 권한에만 있다', () => {
  const cargo = read('../src-tauri/Cargo.toml');
  assert.doesNotMatch(section(cargo, '[dependencies]'), /tauri-plugin-notification/, '공용 의존성이면 iOS·Android에도 링크된다');
  assert.match(section(cargo, `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`), /^tauri-plugin-notification = "2"$/m);
  const lib = read('../src-tauri/src/lib.rs');
  const inits = lib.match(/tauri_plugin_notification::init\(\)/g) ?? [];
  assert.equal(inits.length, 1, '등록은 한 곳');
  assert.match(lib, /#\[cfg\(desktop\)\]\n\s*let builder = builder\.plugin\(tauri_plugin_notification::init\(\)\);/);
  assert.ok(!JSON.parse(read('../src-tauri/capabilities/mobile.json')).permissions.includes('notification:default'));
  assert.ok(JSON.parse(read('../src-tauri/capabilities/desktop.json')).permissions.includes('notification:default'), '윈도우·리눅스 알림은 그대로');
  // 푸시 플러그인(탭·전경 수신의 주인)은 모바일에 그대로
  assert.match(section(cargo, `[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]`), /tauri-plugin-push-notifications = "0\.1"/);
  assert.ok(JSON.parse(read('../src-tauri/capabilities/mobile.json')).permissions.includes('push-notifications:default'));
});

test('모바일 JS는 일반 알림 플러그인을 부르지 않는다 — 플러그인을 빼도 모바일 경로가 깨지지 않는다', () => {
  const src = read('../src/notify.js');
  for (const fn of ['notifyPermission', 'requestNotifyPermission', 'askNotifyOnce', 'sendNotify']) {
    const body = src.split(`export async function ${fn}(`)[1]?.split('\n}')[0] ?? '';
    assert.match(body.split('\n').slice(0, 2).join('\n'), /if \(isMobilePlatform\) return/, `${fn}는 모바일이면 먼저 반환`);
  }
  for (const f of ['../src/App.jsx', '../src/push.js']) assert.doesNotMatch(read(f), /plugin-notification|plugin:notification\|/, f);
});
