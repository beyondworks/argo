import { isAuthRetryableFetchError } from '@supabase/supabase-js';

const RETRY_MS = 5_000;

function isRetryable(error) {
  return isAuthRetryableFetchError(error) || error instanceof TypeError;
}

// Cold start is different from a real sign-out: auth-js keeps stored credentials
// after retryable refresh failures, so remain indeterminate and retry until the
// refresh succeeds or a real SIGNED_OUT event arrives.
export function createSessionRecovery({ auth, hasStoredSession, applySession, setWaiting,
  addEventListener = globalThis.addEventListener?.bind(globalThis),
  removeEventListener = globalThis.removeEventListener?.bind(globalThis),
  setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis),
  retryMs = RETRY_MS }) {
  let active = false;
  let timer = null;
  let inFlight = null;
  let generation = 0;

  const clearRetry = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const finish = (session) => { clearRetry(); setWaiting(false); applySession(session); };
  const schedule = () => {
    clearRetry();
    if (active) timer = setTimer(() => { timer = null; return retryNow(); }, retryMs);
  };
  const read = async () => {
    const readGeneration = generation;
    try {
      const { data, error } = await auth.getSession();
      if (!active || generation !== readGeneration) return;
      if (!error) { finish(data.session ?? null); return; }
      if (hasStoredSession() && isRetryable(error)) { setWaiting(true); schedule(); return; }
      finish(null);
    } catch (error) {
      if (!active || generation !== readGeneration) return;
      // A thrown read never establishes that credentials were rejected. If
      // credentials remain on disk, keep them and retry instead of guessing.
      if (hasStoredSession()) { setWaiting(true); schedule(); return; }
      throw error;
    }
  };
  const retryNow = () => {
    if (!active) return Promise.resolve();
    clearRetry();
    if (!inFlight) inFlight = read().finally(() => { inFlight = null; });
    return inFlight;
  };
  const online = () => retryNow();

  return {
    async start() { active = true; addEventListener?.('online', online); await retryNow(); },
    stop() { active = false; generation += 1; clearRetry(); removeEventListener?.('online', online); },
    retryNow,
    chooseSignIn() { generation += 1; finish(null); },
    onAuthStateChange(event, session) {
      // Auth events after the initial read started are authoritative. Invalidate
      // that read before applying them so stale identities cannot win later.
      if (event === 'SIGNED_OUT') { generation += 1; finish(null); return; }
      if (session) { generation += 1; finish(session); }
      else if (!hasStoredSession()) { generation += 1; finish(null); }
    },
  };
}
