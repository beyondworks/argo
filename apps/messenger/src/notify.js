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
export async function sendNotify(title, body = '', tag = '') {
  if (isMobilePlatform) return;
  const p = await plugin();
  if (p) { try { if (await p.isPermissionGranted()) p.sendNotification({ title, body }); } catch { /* 무해 */ } return; }
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag }); n.onclick = () => { window.focus(); n.close(); };
  } catch { /* 알림 불가 환경 */ }
}
export async function setBadge(n) { // 독 아이콘 숫자(맥) — 안 읽은 합계. 미지원 버전·플랫폼은 조용히 지나간다
  if (!inTauri() || isMobilePlatform) return;
  try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().setBadgeCount(n > 0 ? n : undefined); } catch { /* 무해 */ }
}
