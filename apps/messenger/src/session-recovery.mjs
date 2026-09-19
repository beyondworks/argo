import { isAuthRetryableFetchError } from '@supabase/supabase-js';

const RETRY_MS = 5_000;

function isRetryable(error) {
  return isAuthRetryableFetchError(error);
}

// Cold start is different from a real sign-out: auth-js keeps stored credentials
// after retryable refresh failures, so remain indeterminate and retry until the
// refresh succeeds or a real SIGNED_OUT event arrives.
export function createSessionRecovery({ auth, hasStoredSession, applySession, setWaiting, cleanupState = null,
  setFailure = () => {},
  addEventListener = globalThis.addEventListener?.bind(globalThis),
  removeEventListener = globalThis.removeEventListener?.bind(globalThis),
  addVisibilityListener = globalThis.document?.addEventListener?.bind(globalThis.document),
  removeVisibilityListener = globalThis.document?.removeEventListener?.bind(globalThis.document),
  setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis),
  retryMs = RETRY_MS }) {
  let active = false;
  let timer = null;
  let inFlight = null;
  let generation = 0;
  let cleanupPending = false;

  const clearRetry = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const finish = (session) => { clearRetry(); setFailure(null); setWaiting(false); applySession(session); };
  const schedule = () => {
    clearRetry();
    if (active) timer = setTimer(() => { timer = null; return retryNow(); }, retryMs);
  };
  const failClosed = (error, phase = 'session') => {
    clearRetry(); setWaiting(true); setFailure(error, phase);
  };
  const refreshCleanupState = () => {
    if (!cleanupState) return cleanupPending;
    cleanupPending = cleanupState.read();
    return cleanupPending;
  };
  const read = async () => {
    const readGeneration = generation;
    try {
      if (cleanupPending || refreshCleanupState()) { clearRetry(); setWaiting(true); return; }
      const { data, error } = await auth.getSession();
      if (!active || generation !== readGeneration) return;
      if (cleanupPending || refreshCleanupState()) { clearRetry(); setWaiting(true); return; }
      if (!error) { finish(data.session ?? null); return; }
      if (hasStoredSession() && isRetryable(error)) { setFailure(null); setWaiting(true); schedule(); return; }
      finish(null);
    } catch (error) {
      if (!active || generation !== readGeneration) return;
      // Keep credentials on disk, but only Supabase's retryable fetch error is
      // safe to loop. An arbitrary TypeError may be a broken storage adapter.
      if (hasStoredSession() && isRetryable(error)) { setFailure(null); setWaiting(true); schedule(); return; }
      failClosed(error);
    }
  };
  const retryNow = () => {
    if (!active) return Promise.resolve();
    clearRetry();
    if (!inFlight) inFlight = read().finally(() => { inFlight = null; });
    return inFlight;
  };
  const online = () => retryNow();
  const focus = () => retryNow();
  const visibility = () => {
    if (globalThis.document?.visibilityState !== 'hidden') return retryNow();
  };
  const storage = (event) => {
    if (!cleanupState?.matches(event)) return;
    try {
      if (refreshCleanupState()) {
        generation += 1; clearRetry(); setFailure(null); setWaiting(true);
      }
    } catch (error) { cleanupPending = true; generation += 1; failClosed(error); }
  };

  return {
    async start() {
      active = true;
      addEventListener?.('online', online); addEventListener?.('focus', focus); addEventListener?.('storage', storage);
      addVisibilityListener?.('visibilitychange', visibility);
      try {
        if (refreshCleanupState()) { setWaiting(true); return; }
      } catch (error) { cleanupPending = true; failClosed(error); return; }
      await retryNow();
    },
    stop() {
      active = false; generation += 1; clearRetry();
      removeEventListener?.('online', online); removeEventListener?.('focus', focus); removeEventListener?.('storage', storage);
      removeVisibilityListener?.('visibilitychange', visibility);
    },
    retryNow,
    async restartSignIn() {
      const attemptGeneration = ++generation;
      clearRetry(); setFailure(null); setWaiting(true);
      try {
        cleanupState?.begin(); cleanupPending = true;
        const { error } = await auth.signOut({ scope: 'local' });
        if (error) { setFailure(error, 'signout'); return { error }; }
        // Only SIGNED_OUT proves auth-js completed primary, PKCE/user companion
        // cleanup and broadcast. Promise success alone cannot open Auth.
        return { error: null };
      } catch (error) {
        if (generation !== attemptGeneration && !cleanupPending) return { error: null };
        setFailure(error, 'signout');
        return { error };
      }
    },
    onAuthStateChange(event, session) {
      // Auth events after the initial read started are authoritative. Invalidate
      // that read before applying them so stale identities cannot win later.
      if (event === 'SIGNED_OUT') {
        try { cleanupState?.complete(); cleanupPending = false; }
        catch (error) { cleanupPending = true; generation += 1; failClosed(error, 'signout'); return; }
        generation += 1; finish(null); return;
      }
      try { if (cleanupPending || refreshCleanupState()) { generation += 1; clearRetry(); setWaiting(true); return; } }
      catch (error) { cleanupPending = true; generation += 1; failClosed(error); return; }
      if (session) { generation += 1; finish(session); }
      else if (!hasStoredSession()) { generation += 1; finish(null); }
    },
  };
}
