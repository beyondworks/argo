// 모바일 푸시 등록 — iOS(APNs)·Android(FCM) 기기 토큰을 서버(msgr_push_register)에 묶고, 알림 탭·전경 수신을 앱에 넘긴다.
// 발송은 서버(트리거 msgr_push_enqueue → 엣지 msgr-push). 데스크톱은 notify.js(OS 로컬 알림)가 맡고 여기는 아무것도 하지 않는다.
// 토큰은 회전하므로 로그인·앱 재개마다 다시 등록한다(플러그인 README).
import { inTauri, isMobilePlatform } from './platform.js';
import { getSound } from './notify.js';

let mod = null;
async function plugin() {
  if (mod === null) { try { mod = (inTauri() && isMobilePlatform) ? await import('@spicavi/tauri-plugin-push-notifications') : false; } catch { mod = false; } }
  return mod || null;
}

/** 권한 요청 → 토큰 → 서버 등록. 반환: 'registered' | 'denied' | 'unsupported' | 'error:<msg>' */
export async function registerPush(supabase, { device = '' } = {}) {
  const p = await plugin(); if (!p || !supabase) return 'unsupported';
  try {
    if (!(await p.requestPermission())) return 'denied';
    const token = await p.registerForPush();
    if (!token) return 'error:no-token';
    const platform = /iP(hone|ad|od)/i.test(navigator.userAgent) ? 'ios' : 'android';
    const { error } = await supabase.rpc('msgr_push_register', { platform, token, device: device || navigator.userAgent.slice(0, 80), sound: getSound() }); // 소리 이름 = 서버가 APNs sound(<이름>.caf)에 그대로 쓴다
    return error ? `error:${error.message}` : 'registered';
  } catch (e) { return `error:${e?.message ?? e}`; }
}

/** 탭(콜드 스타트 포함)·전경 수신 리스너. onTap({ channel_id, message_id }), onForeground({ title, body, data }). 해제 함수를 돌려준다. */
export async function listenPush({ onTap, onForeground } = {}) {
  const p = await plugin(); if (!p) return () => {};
  const offs = [];
  try {
    if (onTap) offs.push(await p.onNotificationTapped((n) => onTap({ channel_id: n?.data?.channel_id, message_id: n?.data?.message_id })));
    if (onForeground) offs.push(await p.onNotificationReceived((n) => onForeground({ title: n?.title, body: n?.body, data: n?.data ?? {} })));
  } catch { /* 플러그인 없음·권한 거부 — 조용히 */ }
  return () => { for (const off of offs) { try { typeof off === 'function' && off(); } catch { /* 무해 */ } } };
}
