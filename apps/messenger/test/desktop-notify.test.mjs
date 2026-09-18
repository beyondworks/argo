import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 데스크톱 알림·독 배지(2026-09-18 유건 0.1.29 제보 "가려도·최소화해도 알림이 안 온다").

// 가린 창의 웹뷰 정지는 원인이 아니었다(2026-09-18 검수용 번들 실측, Tauri 기본 backgroundThrottling): 숨김 300초 동안 1초 타이머가
// 151회 돌았고 최대 간격 2.36초, 최소화 60초도 31회. 그래서 창 설정은 바꾸지 않았다 — 알림이 안 온 원인은 OS 전달 경로(아래)였다.

test('askNotifyOnce — 아직 안 정한 상태에서 한 번만 묻고, 정한 뒤·물은 뒤에는 다시 묻지 않는다', async () => {
  const src = readFileSync(new URL('../src/notify.js', import.meta.url), 'utf8');
  // notify.js는 diag.jsx·Tauri 모듈을 불러 노드에서 직접 못 연다 — 판정 함수만 떼어 같은 코드로 돌린다
  const body = src.slice(src.indexOf('export async function askNotifyOnce'), src.indexOf('// 메시지 소리'));
  const make = (perm, reqResult = 'granted', tauri = true) => {
    const calls = { req: 0 };
    const fn = new Function('isMobilePlatform', 'inTauri', 'notifyPermission', 'requestNotifyPermission', `${body.replace('export ', '')}; return askNotifyOnce;`)(false, () => tauri, async () => perm, async () => { calls.req += 1; return reqResult; });
    return { fn, calls };
  };
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
  { const { fn, calls } = make('default'); const s = store(); assert.equal(await fn(s), 'granted'); assert.equal(calls.req, 1); await fn(s); assert.equal(calls.req, 1, '두 번째 로그인에는 묻지 않는다'); }
  for (const p of ['granted', 'denied', 'unsupported']) { const { fn, calls } = make(p); assert.equal(await fn(store()), p); assert.equal(calls.req, 0, `${p}이면 묻지 않는다`); }
  // 브라우저(Tauri 밖)는 미결정이어도 자동으로 묻지 않는다 — 권한 창이 자동화 브라우저 제어권을 가져가 모든 세션의 브라우저 검증을 막았다(2026-09-18). 설정 버튼만 묻는다
  { const { fn, calls } = make('default', 'granted', false); const s = store(); assert.equal(await fn(s), 'default'); assert.equal(calls.req, 0, '브라우저는 자동 요청 없음'); assert.equal(s.getItem('msgr-notify-asked'), null, '물은 것으로 적지 않는다'); }
});

// 검수 #604 MEDIUM — 플러그인 2.4.0 데스크톱은 권한을 늘 Granted로 답한다. 맥에서 네이티브가 실패·시간 초과일 때 플러그인으로 내려가면
// 거짓 "허용"이 된다(설정에 "켜짐", askNotifyOnce는 묻지 않음). notify.js의 실제 함수 본문을 스텁 주입으로 돌려 이 분기를 잠근다.
test('맥 네이티브가 실패·시간 초과여도 권한을 허용으로 보지 않는다 — 플러그인(늘 Granted)은 맥이 아니거나 번들 밖일 때만', async () => {
  const src = readFileSync(new URL('../src/notify.js', import.meta.url), 'utf8');
  const { resolvePermission } = await import('../src/notify-decide.mjs');
  const body = src.slice(src.indexOf('export async function notifyPermission'), src.indexOf('// 메시지 소리')).replaceAll('export ', '');
  const run = async (native) => {
    const diag = []; let pluginAsked = 0;
    const plugin = async () => ({ isPermissionGranted: async () => { pluginAsked += 1; return true; }, requestPermission: async () => { pluginAsked += 1; return 'granted'; } });
    const nativeMac = async (cmd) => native[cmd] ?? null;
    const f = new Function('isMobilePlatform', 'inTauri', 'nativeMac', 'plugin', 'pushDiag', 'resolvePermission', 'Notification',
      `${body}; return { notifyPermission, requestNotifyPermission, askNotifyOnce };`)(false, () => true, nativeMac, plugin, (...a) => diag.push(a), resolvePermission, undefined);
    return { f, diag, pluginAsked: () => pluginAsked };
  };
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
  const timeout = { ok: false, error: 'notification center did not answer' };

  { // 상태 조회 시간 초과 → 'default'(플러그인 안 부름), 진단에 남음, askNotifyOnce는 묻는다
    const r = await run({ notify_status: timeout, notify_request: { ok: true, value: 'denied' } });
    assert.equal(await r.f.notifyPermission(), 'default');
    assert.equal(r.pluginAsked(), 0, '맥 네이티브 실패에 플러그인(늘 Granted)으로 내려가지 않는다');
    assert.ok(r.diag.length > 0);
    assert.equal(await r.f.askNotifyOnce(store()), 'denied', '모르는 상태면 OS에 묻는다');
  }
  { // 권한 요청 시간 초과 → OS 상태를 다시 읽는다(여기선 그것도 실패 → 'default')
    const r = await run({ notify_request: timeout, notify_status: timeout });
    assert.equal(await r.f.requestNotifyPermission(), 'default');
    assert.equal(r.pluginAsked(), 0);
  }
  { // 요청은 실패했지만 다시 읽은 OS 상태가 거부 → 'denied'
    const r = await run({ notify_request: timeout, notify_status: { ok: true, value: 'denied' } });
    assert.equal(await r.f.requestNotifyPermission(), 'denied');
  }
  { // 맥 네이티브 정상 → OS 값 그대로
    const r = await run({ notify_status: { ok: true, value: 'denied' } });
    assert.equal(await r.f.notifyPermission(), 'denied');
  }
  { // 번들 밖('unsupported')·맥 아님(null) → 플러그인 경로
    const r = await run({ notify_status: { ok: true, value: 'unsupported' } });
    assert.equal(await r.f.notifyPermission(), 'granted'); assert.equal(r.pluginAsked(), 1);
    const w = await run({});
    assert.equal(await w.f.notifyPermission(), 'granted'); assert.equal(w.pluginAsked(), 1);
  }
});

test('전송 실패는 삼키지 않는다 — 네이티브 결과를 돌려주고 진단에 남긴다(macOS는 UN 직결)', () => {
  const src = readFileSync(new URL('../src/notify.js', import.meta.url), 'utf8');
  const send = src.slice(src.indexOf('export async function sendNotify'), src.indexOf('export async function setBadge'));
  assert.match(send, /nativeMac\('notify_send'/);
  assert.match(send, /pushDiag\('notify', `알림 전송 실패/);
  assert.match(src, /import\.meta\.env\.TAURI_ENV_PLATFORM === 'darwin'/);
  const rs = readFileSync(new URL('../src-tauri/src/notify_mac.rs', import.meta.url), 'utf8');
  assert.match(rs, /addNotificationRequest_withCompletionHandler\(&req, Some\(&block\)\)/, '완료 블록으로 오류를 받는다');
  assert.doesNotMatch(rs, /NSUserNotification\b/, '폐기 API를 쓰지 않는다');
  // 거부 상태에서도 UN은 addNotificationRequest를 성공으로 받아 준다(검수용 번들 실측) — 보내기 전에 상태를 봐야 "보냈는데 안 뜸"이 진단에 남는다
  const rsSend = rs.slice(rs.indexOf('pub async fn notify_send'), rs.indexOf('define_class!'));
  assert.ok(rsSend.indexOf('current_status(&c)?') > -1 && rsSend.indexOf('current_status(&c)?') < rsSend.indexOf('addNotificationRequest_withCompletionHandler'), '전송 전에 권한 상태를 확인한다');
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /notify_mac::notify_status, notify_mac::notify_request, notify_mac::notify_send/);
});
