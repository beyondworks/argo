// OS 알림 한 곳 — Tauri(데스크톱)는 알림 플러그인, 브라우저는 웹 Notification. 웹뷰에는 Notification API가 없어 데스크톱 앱이 한 번도 알림을 울린 적이
// 없었다(유건 제보 2026-09-11 밤 "답변 오면 알림도 와야 해"). 모바일은 아직 제외(푸시는 APNs·FCM 설계 뒤).
import { inTauri, isMobilePlatform } from './platform.js';

let mod = null;
async function plugin() {
  if (mod === null) { try { mod = inTauri() ? await import('@tauri-apps/plugin-notification') : false; } catch { mod = false; } }
  return mod || null;
}
export async function notifyPermission() { // 'granted' | 'denied' | 'default' | 'unsupported'
  if (isMobilePlatform) return 'unsupported';
  const p = await plugin();
  if (p) { try { return (await p.isPermissionGranted()) ? 'granted' : 'default'; } catch { return 'unsupported'; } }
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}
export async function requestNotifyPermission() {
  if (isMobilePlatform) return 'unsupported';
  const p = await plugin();
  if (p) { try { return await p.requestPermission(); } catch { return 'denied'; } }
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.requestPermission();
}
// 메시지 소리 = 기내 안전띠 사인 차임(두 음, 합성 — public/sounds/chime.wav, 유건 지시 2026-09-12). OS 알림은 무음으로 두고 앱이 직접 울린다 —
// 맥·윈도우·웹 어디서나 같은 소리, 알림 플러그인의 플랫폼별 소리 규격에 의존하지 않는다.
let chimeBuf = null; let ctx = null;
export async function playChime() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    chimeBuf ??= await fetch('/sounds/chime.wav').then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
    const src = ctx.createBufferSource(); src.buffer = chimeBuf; src.connect(ctx.destination); src.start();
  } catch { /* 오디오 불가 환경(자동재생 차단 등) — 알림 자체는 그대로 */ }
}
export async function sendNotify(title, body = '', tag = '') {
  if (isMobilePlatform) return;
  const p = await plugin();
  if (p) { try { if (await p.isPermissionGranted()) { p.sendNotification({ title, body }); playChime(); } } catch { /* 무해 */ } return; }
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag, silent: true }); n.onclick = () => { window.focus(); n.close(); };
    playChime();
  } catch { /* 알림 불가 환경 */ }
}
export async function setBadge(n) { // 독 아이콘 숫자(맥) — 안 읽은 합계. 미지원 버전·플랫폼은 조용히 지나간다
  if (!inTauri() || isMobilePlatform) return;
  try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().setBadgeCount(n > 0 ? n : undefined); } catch { /* 무해 */ }
}
