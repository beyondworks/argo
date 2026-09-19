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

  const clearRetry = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const finish = (session) => { clearRetry(); setWaiting(false); applySession(session); };
  const schedule = () => {
    clearRetry();
    if (active) timer = setTimer(() => { timer = null; return retryNow(); }, retryMs);
  };
  const read = async () => {
    try {
      const { data, error } = await auth.getSession();
      if (!error) { finish(data.session ?? null); return; }
      if (hasStoredSession() && isRetryable(error)) { setWaiting(true); schedule(); return; }
      finish(null);
    } catch (error) {
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
    stop() { active = false; clearRetry(); removeEventListener?.('online', online); },
    retryNow,
    onAuthStateChange(event, session) {
      if (event === 'SIGNED_OUT') { finish(null); return; }
      if (session) finish(session);
      else if (!hasStoredSession()) finish(null);
    },
  };
}
