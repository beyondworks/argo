// D52(2026-09-19 설치본 실측): 배너를 누르면 앱은 앞으로 오지만 그 글의 방으로 가지 않았다 — 네이티브 대리자에 클릭 처리가 없었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notifyTag, notifyChannel } from '../src/notify-target.mjs';
const CH = '1b41d741-0000-4000-8000-000000000001';
test('알림 식별자는 채널을 싣고, 클릭 식별자에서 그 채널을 되찾는다', () => {
  for (const kind of ['r', 'm', 'a']) assert.equal(notifyChannel(notifyTag(kind, 976, CH)), CH);
  assert.equal(notifyTag('r', 976, CH), `r:976@${CH}`, '글 id는 그대로 — 같은 글의 알림은 OS가 하나로 바꿔 끼운다');
  assert.equal(notifyTag('r', 976, undefined), 'r:976', '채널을 모르면 종전 식별자');
  for (const bad of ['r:976', 'argo-123', `r:976@not-a-uuid`, `r:976@${CH}x`, '', null]) assert.equal(notifyChannel(bad), null, String(bad));
});
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
test('배선: 네이티브 대리자가 클릭을 받아 창을 되살리고 구조화된 대상을 웹뷰에 보낸다', () => {
  const rs = read('../src-tauri/src/notify_mac.rs');
  assert.match(rs, /#\[unsafe\(method\(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:\)\)\]/);
  assert.match(rs, /content\(\)\.userInfo\(\)/);
  assert.match(rs, /window\.unminimize\(\);[\s\S]*window\.show\(\);[\s\S]*window\.set_focus\(\);/, '⌘M 최소화도 되살린다');
  assert.match(rs, /app\.emit\("native-notification-tap", tap\)/);
  assert.match(rs, /handler\.call\(\(\)\);/, '완료 처리기를 불러야 OS가 응답을 끝낸다');
  assert.match(read('../src-tauri/src/lib.rs'), /notify_mac::install_delegate\(mtm, app\.handle\(\)\.clone\(\)\)/);
  assert.match(rs, /remember_tap\(tap\.clone\(\)\)/, '콜드 스타트 클릭 보관(검수 #650)');
  assert.match(rs, /pub fn native_notification_pending_tap\(\) -> Option<NotificationTap>/, '가져가면 비운다');
  assert.match(read('../src-tauri/src/lib.rs'), /notify_mac::native_notification_pending_tap/, '명령 등록');
});
test('배선: 앱이 클릭 이벤트를 navTo(조직 전환 포함)로 잇고, 모든 OS 알림이 채널을 싣는다', () => {
  const app = read('../src/App.jsx');
  assert.match(app, /mountNativeNotificationTaps\(\{[^}]*onTap: \(\{ channelId \}\) => \{ if \(!disposed\) setNavTo\(channelId\); \}/);
  const calls = [...app.matchAll(/osNotify\([^;]*?(`[amr]:\$\{payload\.id\}`), payload\.channel_id/g)].map((m) => m[1]);
  assert.ok(calls.length >= 5, `osNotify 호출 ${calls.length}`);
  assert.ok(calls.every((c) => c.startsWith('`')), '메시지 claim 식별자와 채널을 분리하지 않은 알림이 남았다');
});
