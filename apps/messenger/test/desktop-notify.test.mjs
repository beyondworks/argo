import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 데스크톱 알림·독 배지(2026-09-18 유건 0.1.29 제보 "가려도·최소화해도 알림이 안 온다").
const conf = (f) => JSON.parse(readFileSync(new URL(`../src-tauri/${f}`, import.meta.url), 'utf8'));

test('macOS 창은 가려져도 웹뷰를 멈추지 않는다 — 알림·독 배지·안 읽음이 모두 웹뷰 안에서 돈다', () => {
  // 창 닫기 = 앱 가리기(lib.rs)라 가린 동안 WKWebView가 기본(Suspend)으로 멈추면 방송도 폴도 멈춘다. macOS 14+에서만 적용.
  // tauri.macos.conf.json은 창 배열을 통째로 바꾸므로(JSON 병합에서 배열은 교체) 기본 창 설정과 한 벌이어야 한다.
  const base = conf('tauri.conf.json').app.windows;
  const mac = conf('tauri.macos.conf.json').app.windows;
  assert.deepEqual(mac.map(({ backgroundThrottling, ...w }) => w), base, 'macOS 창 설정이 기본 창 설정과 어긋났다');
  assert.ok(mac.every((w) => w.backgroundThrottling === 'disabled'));
  assert.ok(base.every((w) => w.backgroundThrottling === undefined), '기본 파일에 넣으면 iOS까지 번진다(iOS·Android 설정은 창을 물려받는다)');
});

test('askNotifyOnce — 아직 안 정한 상태에서 한 번만 묻고, 정한 뒤·물은 뒤에는 다시 묻지 않는다', async () => {
  const src = readFileSync(new URL('../src/notify.js', import.meta.url), 'utf8');
  // notify.js는 diag.jsx·Tauri 모듈을 불러 노드에서 직접 못 연다 — 판정 함수만 떼어 같은 코드로 돌린다
  const body = src.slice(src.indexOf('export async function askNotifyOnce'), src.indexOf('// 메시지 소리'));
  const make = (perm, reqResult = 'granted') => {
    const calls = { req: 0 };
    const fn = new Function('isMobilePlatform', 'notifyPermission', 'requestNotifyPermission', `${body.replace('export ', '')}; return askNotifyOnce;`)(false, async () => perm, async () => { calls.req += 1; return reqResult; });
    return { fn, calls };
  };
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
  { const { fn, calls } = make('default'); const s = store(); assert.equal(await fn(s), 'granted'); assert.equal(calls.req, 1); await fn(s); assert.equal(calls.req, 1, '두 번째 로그인에는 묻지 않는다'); }
  for (const p of ['granted', 'denied', 'unsupported']) { const { fn, calls } = make(p); assert.equal(await fn(store()), p); assert.equal(calls.req, 0, `${p}이면 묻지 않는다`); }
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
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /notify_mac::notify_status, notify_mac::notify_request, notify_mac::notify_send/);
});
