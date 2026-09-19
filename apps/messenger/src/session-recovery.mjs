import { isAuthRetryableFetchError } from '@supabase/supabase-js';

const RETRY_MS = 5_000;

function isRetryable(error) {
  return isAuthRetryableFetchError(error);
}

// Cold start is different from a real sign-out: auth-js keeps stored credentials
// after retryable refresh failures, so remain indeterminate and retry until the
// refresh succeeds or a real SIGNED_OUT event arrives.
export function createSessionRecovery({ auth, hasStoredSession, applySession, setWaiting, cleanupState = null,
  onCleanupPending = () => {},
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
  let cleanupFlight = null;
  let cleanupReady = null;
  let generation = 0;
  let cleanupPhase = null;
  let markerWriteFailed = false;

  const clearRetry = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const finish = (session) => {
    clearRetry(); setFailure(null);
    const applied = applySession(session);
    if (session || !applied?.then) { setWaiting(false); return Promise.resolve(); }
    return applied.then(() => { if (cleanupPhase !== 'pending') setWaiting(false); });
  };
  const schedule = () => {
    clearRetry();
    if (active) timer = setTimer(() => { timer = null; return retryNow(); }, retryMs);
  };
  const failClosed = (error, phase = 'session') => {
    clearRetry(); setWaiting(true); setFailure(error, phase);
  };
  const refreshCleanupState = () => {
    if (!cleanupState) return cleanupPhase;
    const stored = cleanupState.read();
    const storedPhase = stored === true ? 'pending' : stored || null;
    cleanupPhase = storedPhase ?? (markerWriteFailed ? 'pending' : null);
    return cleanupPhase;
  };
  const enterCleanup = () => {
    clearRetry(); setFailure(null); setWaiting(true);
    if (!cleanupReady) cleanupReady = Promise.resolve().then(onCleanupPending);
    return cleanupReady;
  };
  const showCompletedCleanup = () => finish(null);
  const read = async () => {
    const readGeneration = generation;
    try {
      const beforeRead = refreshCleanupState();
      if (beforeRead === 'pending') { await enterCleanup(); return; }
      if (beforeRead === 'complete') { await showCompletedCleanup(); return; }
      const { data, error } = await auth.getSession();
      if (!active || generation !== readGeneration) return;
      const afterRead = refreshCleanupState();
      if (afterRead === 'pending') { await enterCleanup(); return; }
      if (afterRead === 'complete') { await showCompletedCleanup(); return; }
      if (!error) { await finish(data.session ?? null); return; }
      if (hasStoredSession() && isRetryable(error)) { setFailure(null); setWaiting(true); schedule(); return; }
      await finish(null);
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
      const phase = refreshCleanupState();
      generation += 1;
      if (phase === 'pending') { void enterCleanup().catch((error) => failClosed(error)); return; }
      cleanupReady = null;
      if (phase === 'complete') { void showCompletedCleanup(); return; }
      void retryNow();
    } catch (error) { cleanupPhase = 'pending'; generation += 1; failClosed(error); }
  };

  return {
    async start() {
      active = true;
      addEventListener?.('online', online); addEventListener?.('focus', focus); addEventListener?.('storage', storage);
      addVisibilityListener?.('visibilitychange', visibility);
      try {
        const phase = refreshCleanupState();
        if (phase === 'pending') { await enterCleanup(); return; }
        if (phase === 'complete') { await showCompletedCleanup(); return; }
      } catch (error) { cleanupPhase = 'pending'; failClosed(error); return; }
      await retryNow();
    },
    stop() {
      active = false; generation += 1; clearRetry();
      removeEventListener?.('online', online); removeEventListener?.('focus', focus); removeEventListener?.('storage', storage);
      removeVisibilityListener?.('visibilitychange', visibility);
    },
    retryNow,
    restartSignIn() {
      if (cleanupFlight) return cleanupFlight;
      cleanupFlight = (async () => {
        ++generation;
        clearRetry(); setFailure(null); setWaiting(true);
        cleanupPhase = 'pending';
        let markerPersisted = false;
        try {
          cleanupState?.begin();
          markerPersisted = true;
          markerWriteFailed = false;
          cleanupReady = null;
          await enterCleanup();
          const { error } = await auth.signOut({ scope: 'local' });
          if (error) { setFailure(error, 'signout'); return { error }; }
          // Only SIGNED_OUT proves auth-js completed primary, PKCE/user companion
          // cleanup and broadcast. Promise success alone cannot open Auth.
          return { error: null };
        } catch (error) {
          if (!markerPersisted) markerWriteFailed = true;
          if (cleanupPhase === 'complete') return { error: null };
          setFailure(error, 'signout');
          return { error };
        }
      })().finally(() => { cleanupFlight = null; });
      return cleanupFlight;
    },
    onAuthStateChange(event, session) {
      // Auth events after the initial read started are authoritative. Invalidate
      // that read before applying them so stale identities cannot win later.
      if (event === 'SIGNED_OUT') {
        generation += 1;
        return Promise.resolve(cleanupReady).then(() => {
          cleanupState?.complete(); cleanupPhase = 'complete'; markerWriteFailed = false; cleanupReady = null;
          return finish(null);
        }).catch((error) => { cleanupPhase = 'pending'; failClosed(error, 'signout'); });
      }
      try {
        const phase = refreshCleanupState();
        if (phase === 'pending') { generation += 1; void enterCleanup().catch((error) => failClosed(error)); return; }
        if (phase === 'complete') {
          const hasNewSession = cleanupState?.hasNewSession ? cleanupState.hasNewSession() : hasStoredSession();
          if (session && hasNewSession) {
            cleanupState?.clear(); cleanupPhase = null; markerWriteFailed = false; cleanupReady = null;
          } else { generation += 1; void showCompletedCleanup(); return; }
        }
      } catch (error) { cleanupPhase = 'pending'; generation += 1; failClosed(error); return; }
      if (session) { generation += 1; void finish(session); }
      else if (!hasStoredSession()) { generation += 1; void finish(null); }
    },
  };
}
