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
const delivered = new Set(); // 같은 콜백이 시트와 딥링크 양쪽으로 오면 한 번만 소비 — ponytail: 상한 없음(로그인 콜백은 세션당 몇 개)
function deliver(urls) {
  const fresh = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && !delivered.has(u));
  for (const u of fresh) delivered.add(u);
  if (fresh.length) for (const handler of receivers) handler(fresh);
}
async function onOpenUrl(handler) {
  receivers.add(handler);
  // 딥링크는 두 플랫폼 모두 받는다. iOS는 로그인 시트가 콜백을 직접 돌려주지만, argo-messenger:// 스킴이 앱에 등록된 뒤로는(0.1.7 복구 —
  // 스킴이 없던 0.1.4~0.1.6은 '애플리케이션을 열 수 없습니다'로 복귀 불가, 2026-09-11 실사고) 시트 밖(Safari·구글 앱)으로 샌 리디렉션이 앱 openURL로
  // 올 수 있다. 어느 경로로 오든 deliver가 한 번만 넘긴다(스킴 등록 시 시트 콜백이 앱으로 가 코드가 미교환되던 2026-09-10 관찰에도 대응).
  const stop = await deepLinkOnOpenUrl(deliver);
  return () => { stop(); receivers.delete(handler); };
}
function openUrl(url) {
  if (!isIos) return openerOpenUrl(url);
  invoke('plugin:web-auth|start', { url, callbackScheme: MOBILE_AUTH_CALLBACK.split(':')[0] })
    .then((result) => { if (result?.url) deliver([result.url]); else runtime.cancel(); })
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
