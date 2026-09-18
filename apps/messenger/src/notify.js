// OS 알림 한 곳 — Tauri(데스크톱)는 알림 플러그인, 브라우저는 웹 Notification. 웹뷰에는 Notification API가 없어 데스크톱 앱이 한 번도 알림을 울린 적이
// 없었다(유건 제보 2026-09-11 밤 "답변 오면 알림도 와야 해"). 모바일은 아직 제외(푸시는 APNs·FCM 설계 뒤).
import { inTauri, isMobilePlatform } from './platform.js';
import { pushDiag } from './diag.jsx';

// macOS 데스크톱은 네이티브 명령(src-tauri/src/notify_mac.rs — UNUserNotificationCenter)으로 권한을 묻고 보낸다. 플러그인(2.4.0)의 macOS 경로는
// 폐기된 NSUserNotificationCenter에 결과를 버리고, 권한을 늘 "허용"으로 답해 OS에 한 번도 묻지 않았다 — 0.1.29까지 이 맥의 알림 설정에
// 앱이 아예 등록되지 않았다(2026-09-18 실측). 번들 밖(개발 실행)이면 네이티브가 'unsupported'를 돌려주고 플러그인으로 물러난다.
const isMacDesktop = () => import.meta.env.TAURI_ENV_PLATFORM === 'darwin' && inTauri();
async function nativeMac(cmd, args) {
  if (!isMacDesktop()) return null;
  try { const { invoke } = await import('@tauri-apps/api/core'); return { ok: true, value: await invoke(cmd, args) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

let mod = null;
async function plugin() {
  if (mod === null) { try { mod = inTauri() ? await import('@tauri-apps/plugin-notification') : false; } catch { mod = false; } }
  return mod || null;
}
export async function notifyPermission() { // 'granted' | 'denied' | 'default' | 'unsupported'
  if (isMobilePlatform) return 'unsupported';
  const n = await nativeMac('notify_status');
  if (n?.ok && n.value !== 'unsupported') return n.value; // 'granted' | 'denied' | 'default' — OS의 실제 상태
  const p = await plugin();
  if (p) { try { return (await p.isPermissionGranted()) ? 'granted' : 'default'; } catch { return 'unsupported'; } }
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}
export async function requestNotifyPermission() {
  if (isMobilePlatform) return 'unsupported';
  const n = await nativeMac('notify_request');
  if (n && !n.ok) pushDiag('notify', `권한 요청 실패: ${n.error}`);
  if (n?.ok && n.value !== 'unsupported') return n.value;
  const p = await plugin();
  if (p) { try { return await p.requestPermission(); } catch { return 'denied'; } }
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.requestPermission();
}
// 첫 실행·로그인 뒤 한 번만 OS 권한을 묻는다(아직 정하지 않은 상태일 때만). 거부·허용 뒤에는 다시 묻지 않는다 — 설정의 알림 줄이 상태와 안내를 보여 준다.
export async function askNotifyOnce(store = globalThis.localStorage) {
  if (isMobilePlatform) return 'unsupported';
  let asked = false; try { asked = store?.getItem('msgr-notify-asked') === '1'; } catch { /* 저장 불가 */ }
  const now = await notifyPermission();
  if (asked || now !== 'default') return now;
  try { store?.setItem('msgr-notify-asked', '1'); } catch { /* 저장 불가 */ }
  return requestNotifyPermission();
}
// 메시지 소리 — 설정에서 고른다(유건 2026-09-12: 안전띠 사인·나무 타격음 후보). 합성 음원 public/sounds/<이름>.wav, iOS 푸시는 같은 이름의 .caf(번들 루트).
// OS 알림은 무음으로 두고 앱이 직접 울린다 — 맥·윈도우·웹 어디서나 같은 소리, 알림 플러그인의 플랫폼별 소리 규격에 의존하지 않는다.
export const SOUNDS = ['seatbelt-single', 'seatbelt-hilo', 'wood-knock', 'wood-knock-double', 'wood-marimba'];
export const DEFAULT_SOUND = 'wood-knock';
export function getSound() { try { const v = localStorage.getItem('msgr-sound'); return SOUNDS.includes(v) ? v : DEFAULT_SOUND; } catch { return DEFAULT_SOUND; } }
export function setSound(name) { try { if (SOUNDS.includes(name)) localStorage.setItem('msgr-sound', name); } catch { /* 저장 불가 환경 */ } }
const bufs = new Map(); let ctx = null;
export async function playChime(name = getSound()) {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (!bufs.has(name)) bufs.set(name, await fetch(`/sounds/${name}.wav`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)));
    const src = ctx.createBufferSource(); src.buffer = bufs.get(name); src.connect(ctx.destination); src.start();
  } catch { /* 오디오 불가 환경(자동재생 차단 등) — 알림 자체는 그대로 */ }
}
// 반환 { ok, error? } — 전송이 OS에 닿지 못하면 진단(설정 → 진단)에 남긴다. 부르는 쪽(notifyReply·notifyMention)은 초점·음소거·방해 금지를
// 판정한 뒤에만 부른다(shouldNotify). 이름·인자는 그대로라 기존 호출부는 결과를 무시해도 된다.
export async function sendNotify(title, body = '', tag = '') {
  if (isMobilePlatform) return { ok: false, error: 'mobile' };
  const n = await nativeMac('notify_send', { title: String(title ?? ''), body: String(body ?? ''), tag: String(tag ?? '') });
  if (n?.ok) { playChime(); return { ok: true }; }
  if (n && n.error !== 'unsupported') { pushDiag('notify', `알림 전송 실패: ${n.error}`); return { ok: false, error: n.error }; }
  const p = await plugin();
  if (p) {
    try { if (await p.isPermissionGranted()) { p.sendNotification({ title, body }); playChime(); return { ok: true }; } return { ok: false, error: 'not granted' }; }
    catch (e) { pushDiag('notify', `알림 전송 실패: ${String(e?.message ?? e)}`); return { ok: false, error: String(e?.message ?? e) }; }
  }
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return { ok: false, error: 'not granted' };
    const w = new Notification(title, { body, tag, silent: true }); w.onclick = () => { window.focus(); w.close(); };
    playChime(); return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}
export async function setBadge(n) { // 앱 아이콘 숫자(맥 독·iOS 홈 화면) — 안 읽은 합계. Tauri 런타임은 macOS·iOS·리눅스만 지원(Android·Windows는 조용히 지나간다)
  if (!inTauri()) return;
  try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().setBadgeCount(n > 0 ? n : undefined); } catch { /* 무해 */ }
}
