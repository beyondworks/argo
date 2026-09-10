import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { supabase, SB_URL } from './supabase.js';
import { isMobileNative } from './platform.js';
import { createMobileAuth, createMobileAuthRuntime } from './mobile-auth.mjs';

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
