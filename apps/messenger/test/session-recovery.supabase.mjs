import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { configured, customServer, SB_URL, SB_ANON, supabase, q } from './msgr-ui-feedback.supabase.mjs';

const storageKey = 'sb-fixture-auth-token';
const session = { user: { id: 'user-me', email: 'fixture@example.invalid' }, access_token: 'fixture', refresh_token: 'fixture-refresh' };
const nextSession = { user: { id: 'new-user', email: 'new@example.invalid' }, access_token: 'new-fixture', refresh_token: 'new-fixture-refresh' };
const params = new URLSearchParams(location.search);
const raceMode = params.get('race');
const delayedMode = params.get('delayed') ?? (raceMode === 'relogin' ? 'retry' : raceMode ? '1' : null);
let connected = false;
let listener = null;
let resolveInitial = null;
let readCount = 0;
let signOutAttempts = 0;
const initialRead = delayedMode ? new Promise((resolve) => { resolveInitial = resolve; }) : null;

localStorage.setItem(storageKey, JSON.stringify({ ...session, expires_at: 1 }));
supabase.auth = {
  storageKey,
  getSession: async () => {
    readCount += 1;
    if (delayedMode === 'retry' && readCount === 1) {
      return { data: { session: null }, error: new AuthRetryableFetchError('offline fixture', 503) };
    }
    if (initialRead) return initialRead;
    return connected
      ? { data: { session }, error: null }
      : { data: { session: null }, error: new AuthRetryableFetchError('offline fixture', 503) };
  },
  onAuthStateChange: (callback) => {
    listener = callback;
    queueMicrotask(() => callback('INITIAL_SESSION', null));
    if (raceMode === 'signedout') setTimeout(() => { window.__d56.signedOut(); window.__d56.resolveOld(); }, 100);
    if (raceMode === 'new') setTimeout(() => { window.__d56.newSession(); window.__d56.resolveOld(); }, 100);
    if (raceMode === 'relogin') setTimeout(() => {
      window.__d56.beginDelayedRetry();
      setTimeout(() => {
        [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('다시 로그인'))?.click();
        window.__d56.resolveOld();
      }, 100);
    }, 100);
    if (params.get('signout') === 'observe' || params.get('signout') === 'retry') setTimeout(() => {
      [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('다시 로그인'))?.click();
      if (params.get('signout') === 'retry') setTimeout(() => {
        [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('다시 로그인'))?.click();
      }, 200);
    }, 100);
    return { data: { subscription: { unsubscribe() { listener = null; } } } };
  },
  signOut: async () => {
    signOutAttempts += 1;
    if (['fail', 'observe', 'retry'].includes(params.get('signout')) && signOutAttempts === 1) return { error: new TypeError('fixture cleanup blocked') };
    localStorage.removeItem(storageKey);
    listener?.('SIGNED_OUT', null);
    return { error: null };
  },
};

window.__d56 = {
  recover() { connected = true; window.dispatchEvent(new Event('online')); },
  signedOut() { localStorage.removeItem(storageKey); listener?.('SIGNED_OUT', null); },
  beginDelayedRetry() { window.dispatchEvent(new Event('online')); },
  resolveOld() { resolveInitial?.({ data: { session }, error: null }); },
  newSession() {
    localStorage.setItem(storageKey, JSON.stringify({ ...nextSession, expires_at: 4_102_444_800 }));
    listener?.('SIGNED_IN', nextSession);
  },
  stored() { return localStorage.getItem(storageKey) !== null; },
};

export { configured, customServer, SB_URL, SB_ANON, supabase, q };
