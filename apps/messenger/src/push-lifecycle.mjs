// One coordinator per server client. Tokens and credentials remain in memory only.
export function createPushSession({ getSession, getToken, registerToken, unregisterToken, timeoutMs = 5000 }) {
  let current;
  const owners = new Map();
  const requests = new Set();
  const bounded = async (action) => {
    const abort = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => action(abort.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('push-timeout')); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const activate = (uid) => {
    if (current?.uid === uid && current.active) return;
    if (current) current.active = false;
    const previous = owners.get(uid);
    current = { uid, active: true, tokens: previous?.tokens ?? new Set(), requests: previous?.requests ?? new Set() };
    owners.set(uid, current);
  };
  const deactivate = (uid) => { if (current?.uid === uid) current.active = false; };
  const register = async (options = {}) => {
    const owner = current;
    if (!owner?.active) return 'cancelled';
    try {
      const session = await bounded(getSession);
      if (!owner.active || session?.user?.id !== owner.uid) return 'cancelled';
      const result = await bounded(() => getToken(true));
      if (!owner.active) return 'cancelled';
      if (!result.token) return result.status;
      // A previous account's HTTP request must finish before this account can claim the same native token.
      await Promise.allSettled([...requests]);
      if (!owner.active) return 'cancelled';
      owner.tokens.add(result.token);
      const request = bounded((signal) => registerToken(result.token, session, options, signal));
      owner.requests.add(request); requests.add(request);
      try { await request; } finally { owner.requests.delete(request); requests.delete(request); }
      return owner.active ? 'registered' : 'cancelled';
    } catch { return 'error:registration'; }
  };
  const detach = async (uid) => {
    const owner = owners.get(uid) ?? { uid, tokens: new Set(), requests: new Set() };
    owner.active = false;
    if (current?.uid === uid) current.active = false;
    let warning = false;
    try {
      const session = await bounded(getSession);
      if (session?.user?.id !== uid) return { warning: true };
      // A restarted app has no in-memory token. Ask native for its existing token without a permission prompt.
      if (!owner.tokens.size) {
        const result = await bounded(() => getToken(false));
        if (result.token) owner.tokens.add(result.token);
        else if (result.status !== 'unsupported') warning = true;
      }
      const pending = await Promise.allSettled([...owner.requests]);
      if (pending.some((r) => r.status === 'rejected')) warning = true;
      const results = await Promise.allSettled([...owner.tokens].map((token) => bounded((signal) => unregisterToken(token, session, signal))));
      if (results.some((r) => r.status === 'rejected')) warning = true;
      if (!warning) owners.delete(uid);
    } catch { warning = true; }
    return { warning };
  };
  return { activate, deactivate, register, detach };
}

// React cleanup can happen before native listener registration resolves.
export function mountPushListeners(listen, callbacks, onError = () => {}) {
  let active = true;
  let off;
  const guarded = Object.fromEntries(Object.entries(callbacks).map(([key, fn]) => [key, (...args) => { if (active) fn(...args); }]));
  Promise.resolve().then(() => listen(guarded)).then((dispose) => {
    if (active) off = dispose;
    else dispose?.();
  }).catch(onError);
  return () => { active = false; off?.(); off = undefined; };
}
