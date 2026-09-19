import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { configured, customServer, SB_URL, SB_ANON, supabase, q } from './msgr-ui-feedback.supabase.mjs';

const storageKey = 'sb-fixture-auth-token';
const session = { user: { id: 'user-me', email: 'fixture@example.invalid' }, access_token: 'fixture', refresh_token: 'fixture-refresh' };
let connected = false;
let listener = null;

localStorage.setItem(storageKey, JSON.stringify({ ...session, expires_at: 1 }));
supabase.auth = {
  storageKey,
  getSession: async () => connected
    ? { data: { session }, error: null }
    : { data: { session: null }, error: new AuthRetryableFetchError('offline fixture', 503) },
  onAuthStateChange: (callback) => {
    listener = callback;
    queueMicrotask(() => callback('INITIAL_SESSION', null));
    return { data: { subscription: { unsubscribe() { listener = null; } } } };
  },
  signOut: async () => {
    localStorage.removeItem(storageKey);
    listener?.('SIGNED_OUT', null);
    return { error: null };
  },
};

window.__d56 = {
  recover() { connected = true; window.dispatchEvent(new Event('online')); },
  signedOut() { localStorage.removeItem(storageKey); listener?.('SIGNED_OUT', null); },
};

export { configured, customServer, SB_URL, SB_ANON, supabase, q };
