// 모바일 푸시 등록 — iOS(APNs)·Android(FCM) 기기 토큰을 서버(msgr_push_register)에 묶고, 알림 탭·전경 수신을 앱에 넘긴다.
// 발송은 서버(트리거 msgr_push_enqueue → 엣지 msgr-push). 데스크톱은 notify.js(OS 로컬 알림)가 맡고 여기는 아무것도 하지 않는다.
// 토큰은 회전하므로 로그인·앱 재개마다 다시 등록한다(플러그인 README).
import { inTauri, isMobilePlatform } from './platform.js';
import { getSound } from './notify.js';
import { SB_URL, SB_ANON } from './supabase.js';
import { createPushSession, mountPushListeners } from './push-lifecycle.mjs';

let mod = null;
async function plugin() {
  if (mod === null) { try { mod = (inTauri() && isMobilePlatform) ? await import('@spicavi/tauri-plugin-push-notifications') : false; } catch { mod = false; } }
  return mod || null;
}

const clients = new WeakMap();
function coordinator(client) {
  if (!clients.has(client)) {
    // Pin authorization to the initiating account. A later login must not rebind an earlier request.
    const rpc = async (name, body, session, signal) => {
      const res = await fetch(`${SB_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
        method: 'POST', signal,
        headers: { apikey: SB_ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('push-request-failed');
    };
    clients.set(client, createPushSession({
      getSession: async () => { const { data, error } = await client.auth.getSession(); if (error) throw error; return data.session; },
      getToken: async (prompt) => {
        const p = await plugin(); if (!p) return { status: 'unsupported' };
        if (!(await (prompt ? p.requestPermission() : p.isPermissionGranted()))) return { status: 'denied' };
        const token = await p.registerForPush();
        return token ? { token } : { status: 'error:no-token' };
      },
      registerToken: (token, session, { device = '' }, signal) => rpc('msgr_push_register', {
        platform: import.meta.env.TAURI_ENV_PLATFORM === 'ios' ? 'ios' : 'android',
        token, device: device || navigator.userAgent.slice(0, 80), sound: getSound(),
      }, session, signal),
      unregisterToken: (token, session, signal) => rpc('msgr_push_unregister', { token }, session, signal),
    }));
  }
  return clients.get(client);
}

export function activatePush(client, uid) { if (isMobilePlatform && client) coordinator(client).activate(uid); }
export function deactivatePush(client, uid) { if (isMobilePlatform && client) coordinator(client).deactivate(uid); }
export async function registerPush(client, options) { return isMobilePlatform && client ? coordinator(client).register(options) : 'unsupported'; }
export async function detachPush(client, uid) { return isMobilePlatform && client ? coordinator(client).detach(uid) : { warning: false }; }
export function mountPush(callbacks) { return mountPushListeners(listenPush, callbacks); }

/** 탭(콜드 스타트 포함)·전경 수신 리스너. onTap({ channel_id, message_id }), onForeground({ title, body, data }). 해제 함수를 돌려준다. */
export async function listenPush({ onTap, onForeground } = {}) {
  const p = await plugin(); if (!p) return () => {};
  const offs = [];
  try {
    if (onTap) offs.push(await p.onNotificationTapped((n) => onTap({ channel_id: n?.data?.channel_id, message_id: n?.data?.message_id })));
    if (onForeground) offs.push(await p.onNotificationReceived((n) => onForeground({ title: n?.title, body: n?.body, data: n?.data ?? {} })));
  } catch { /* 플러그인 없음·권한 거부 — 조용히 */ }
  return () => { for (const off of offs) { try { typeof off === 'function' ? off() : off?.unregister?.(); } catch { /* 무해 */ } } }; // addPluginListener 는 unregister() 객체
}
