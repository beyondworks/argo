// 새 메일 OS 알림(15차, 유건 결정 3 — 오피스가 열려 있을 때만, 앱이 닫혀 있을 때의 푸시는 하지 않는다).
// 웹: Notification API. 데스크톱: Tauri 알림 플러그인(tauri-plugin-notification)이 같은 window.Notification을 채워 넣는다 — 그래서 한 갈래로 쓴다.
// 권한은 처음 켤 때만 묻는다(설정 화면). 자동 갱신(core/mail.js wantSync)이 새로 받은 안 읽은 받은편지함 메일을 넘기면 알린다.
// 메일 화면을 보고 있는 동안(창에 초점 + 메일 화면)은 목록에 바로 보이므로 알리지 않는다. 지연 로드(첫 화면 밖).
import { navigate } from './router.jsx';
import { getLang } from './i18n.js';
import { notifyText } from '../pages/mail-model.js';
import { hideAllOn } from './hide-all.js';

export const notifySupported = () => typeof window !== 'undefined' && typeof window.Notification === 'function';
/** 'granted' | 'denied' | 'default' | 'unsupported' */
export const notifyPermission = () => (notifySupported() ? window.Notification.permission : 'unsupported');
/** 처음 켤 때만 묻는다 — 이미 정해졌으면 그 값 */
export async function askPermission() {
  if (!notifySupported()) return 'unsupported';
  if (window.Notification.permission !== 'default') return window.Notification.permission;
  const r = await window.Notification.requestPermission();
  return r === 'prompt' || r === 'prompt-with-rationale' ? 'default' : r;
}
/** 알림 하나 — 누르면(웹) 그 메일을 연다. 데스크톱 알림은 누를 때의 동작이 없다(플러그인이 받지 않는다) */
export function showNotify({ title, body, id = null }) {
  if (notifyPermission() !== 'granted') return false;
  const n = new window.Notification(title, { body, tag: 'argo-office-mail' });
  if (n && typeof n === 'object') n.onclick = () => { window.focus(); navigate(id ? `/me/mail/${id}` : '/me/mail'); n.close?.(); };
  return true;
}
const watching = () => document.hasFocus() && !document.hidden && location.pathname.startsWith('/me/mail');
/** 자동 갱신이 넘긴 새 메일 — 1통이면 '보낸 사람 / 제목', 여러 통이면 '새 메일 N통 / 이름' */
export function notifyMail(list) {
  if (!list?.length || watching()) return false;
  const n = notifyText(list, getLang(), hideAllOn());
  return n ? showNotify(n) : false;
}
