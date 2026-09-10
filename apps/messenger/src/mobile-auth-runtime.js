import { getCurrent, onOpenUrl as deepLinkOnOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl as openerOpenUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { supabase, SB_URL } from './supabase.js';
import { isMobileNative } from './platform.js';
import { createMobileAuth, createMobileAuthRuntime, MOBILE_AUTH_CALLBACK } from './mobile-auth.mjs';

// iOS는 외부 브라우저 대신 애플 표준 로그인 창(ASWebAuthenticationSession, src-tauri/plugins/web-auth)을 쓴다.
// 외부 브라우저 경로는 Chrome 등 서드파티 브라우저가 서버 리디렉션의 argo-messenger:// 스킴을 앱에 넘기지 않아
// 로그인이 '대기' 상태에서 멈췄다(2026-09-10 실기: Safari만 동작). 로그인 창은 콜백 URL을 직접 돌려주므로
// 딥링크와 같은 receive 경로로 흘려보낸다. Android는 딥링크(인텐트) 경로 그대로.
const isIos = import.meta.env.TAURI_ENV_PLATFORM === 'ios';
const receivers = new Set();
async function onOpenUrl(handler) {
  receivers.add(handler);
  // iOS는 로그인 시트(web-auth)가 콜백을 receivers로 직접 넘긴다 — argo-messenger:// 스킴을 앱에 등록하지 않는다(시트와 충돌).
  if (isIos) return () => receivers.delete(handler);
  const stop = await deepLinkOnOpenUrl(handler);
  return () => { stop(); receivers.delete(handler); };
}
function openUrl(url) {
  if (!isIos) return openerOpenUrl(url);
  invoke('plugin:web-auth|start', { url, callbackScheme: MOBILE_AUTH_CALLBACK.split(':')[0] })
    .then((result) => { if (result?.url) { for (const handler of receivers) handler([result.url]); } else runtime.cancel(); })
    .catch(() => runtime.cancel());
  return Promise.resolve();
}

let controller = null;
if (isMobileNative && supabase) {
  try { controller = createMobileAuth({ auth: supabase.auth, storage: localStorage, supabaseUrl: SB_URL, openUrl }); }
  catch { /* Login presents a fixed error; do not expose configuration or SDK error bodies. */ }
}
const runtime = createMobileAuthRuntime({ controller, onOpenUrl, getCurrent });
export const getMobileAuthSnapshot = runtime.getSnapshot;
export const subscribeMobileAuth = runtime.subscribe;
export const startMobileSignIn = runtime.start;
export const cancelMobileSignIn = runtime.cancel;
export function mountMobileAuth() {
  if (!isMobileNative) return () => {};
  return runtime.mount();
}
