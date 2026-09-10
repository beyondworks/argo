// Mobile only: Supabase owns PKCE verifier generation, exchange and session refresh.
// This controller owns the single, persisted user-initiated callback intent. Never log URLs.
export const MOBILE_AUTH_CALLBACK = 'argo-messenger://auth/callback';
export const MOBILE_AUTH_TIMEOUT_MS = 5 * 60_000;
export const MOBILE_AUTH_STORAGE_KEY = 'argo-messenger-mobile-auth-v1';
const providers = new Set(['google', 'github']);
const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Parse only the registered callback; implicit tokens, alternate paths and ambiguity fail closed. */
export function parseMobileAuthCallback(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  if (value.split('?')[0] !== MOBILE_AUTH_CALLBACK) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const allowed = new Set(['code', 'argo_state', 'error', 'error_code', 'error_description']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const nonce = url.searchParams.get('argo_state');
  if (!noncePattern.test(nonce ?? '')) return null;
  const code = url.searchParams.get('code');
  const denied = url.searchParams.has('error');
  if (denied) {
    if (code !== null || !url.searchParams.get('error')) return null;
    if (value.includes('#')) {
      // Supabase redirectErrors mirrors nonempty query errors into the fragment and adds sb=.
      // Accept only that error-only mirror, never an implicit-token/success fragment.
      const fragment = new URLSearchParams(url.hash.slice(1));
      const errorKeys = ['error', 'error_code', 'error_description'];
      for (const key of fragment.keys()) {
        if (![...errorKeys, 'sb'].includes(key) || fragment.getAll(key).length !== 1) return null;
      }
      if (fragment.getAll('sb').length !== 1 || fragment.get('sb') !== '') return null;
      for (const key of errorKeys) {
        const queryValue = url.searchParams.get(key);
        if (queryValue ? fragment.get(key) !== queryValue : fragment.has(key)) return null;
      }
    }
    return { nonce, denied: true };
  }
  // 조각(fragment)은 '비어 있을 때만' 허용한다. 조각을 통째로 막던 규칙이 Supabase가 붙이는 빈 '#'까지 거부해
  // 정상 콜백이 조용히 버려졌다(2026-09-10 실기: 로그인 성공·창은 콜백 전달·앱은 대기 유지). 막아야 할 것은
  // 데이터를 실은 조각(#access_token=… 같은 암묵 토큰)이지 빈 조각이 아니다.
  const hash = value.indexOf('#');
  if (hash !== -1 && value.slice(hash + 1) !== '') return null;
  if (url.searchParams.has('error_code') || url.searchParams.has('error_description')) return null;
  if (!code || !/^[A-Za-z0-9._~-]{1,2048}$/.test(code)) return null;
  return { nonce, code, denied: false };
}

/** One singleton per app webview. Storage is the same persistent device storage used by Supabase. */
export function createMobileAuth({ auth, storage, supabaseUrl, openUrl, now = Date.now, randomUUID = () => crypto.randomUUID() }) {
  let server;
  try { server = new URL(supabaseUrl); } catch { throw new Error('start_failed'); }
  if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash || !['', '/'].includes(server.pathname)) throw new Error('start_failed');
  const origin = server.origin;
  let starting = false;
  let exchanging = false;
  function read() {
    try {
      const raw = storage.getItem(MOBILE_AUTH_STORAGE_KEY);
      if (!raw) return null;
      let p;
      try { p = JSON.parse(raw); } catch { storage.removeItem(MOBILE_AUTH_STORAGE_KEY); return null; }
      if (p?.version !== 1 || p.server !== origin || !providers.has(p.provider) || !noncePattern.test(p.nonce ?? '') || !Number.isFinite(p.startedAt) || !['starting', 'waiting'].includes(p.stage) || now() < p.startedAt || now() - p.startedAt >= MOBILE_AUTH_TIMEOUT_MS) {
        storage.removeItem(MOBILE_AUTH_STORAGE_KEY);
        return null;
      }
      return p;
    } catch { throw new Error('storage_unavailable'); }
  }
  function write(p) {
    try {
      const value = JSON.stringify(p);
      storage.setItem(MOBILE_AUTH_STORAGE_KEY, value);
      if (storage.getItem(MOBILE_AUTH_STORAGE_KEY) !== value) throw new Error('storage_unavailable');
    } catch { throw new Error('storage_unavailable'); }
  }
  function remove() {
    try { storage.removeItem(MOBILE_AUTH_STORAGE_KEY); } catch { throw new Error('storage_unavailable'); }
  }
  function removeOwn(nonce) { if (read()?.nonce === nonce) remove(); }
  return {
    pending() {
      const p = read();
      return p ? { provider: p.provider, expiresAt: p.startedAt + MOBILE_AUTH_TIMEOUT_MS } : null;
    },
    cancel() {
      // exchangeCodeForSession commits the SDK session itself; pretending to cancel it races refresh/sign-in.
      if (exchanging) return false;
      remove();
      return true;
    },
    async start(provider) {
      if (!providers.has(provider)) throw new Error('start_failed');
      if (starting || exchanging || read()) throw new Error('busy');
      starting = true;
      let nonce;
      try {
        nonce = randomUUID();
        if (!noncePattern.test(nonce)) throw new Error('start_failed');
        const p = { version: 1, server: origin, provider, nonce, startedAt: now(), stage: 'starting' };
        write(p);
        const redirectTo = `${MOBILE_AUTH_CALLBACK}?argo_state=${nonce}`;
        let response;
        try { response = await auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } }); }
        catch { throw new Error('start_failed'); }
        if (read()?.nonce !== nonce) throw new Error('cancelled');
        if (response?.error || !response?.data?.url) throw new Error('start_failed');
        let url;
        try { url = new URL(response.data.url); } catch { throw new Error('start_failed'); }
        // The OS browser may open only this configured Auth endpoint with the SDK's S256 challenge.
        if (url.origin !== origin || url.pathname !== '/auth/v1/authorize' || url.username || url.password || url.hash || url.searchParams.get('provider') !== provider || url.searchParams.get('redirect_to') !== redirectTo || url.searchParams.get('code_challenge_method')?.toLowerCase() !== 's256' || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '')) throw new Error('start_failed');
        write({ ...p, stage: 'waiting' });
        try { await openUrl(url.href); } catch { throw new Error('open_failed'); }
        return { status: 'waiting' };
      } catch (error) {
        if (nonce) removeOwn(nonce);
        throw error;
      } finally { starting = false; }
    },
    async consume(value) {
      const callback = parseMobileAuthCallback(value);
      if (!callback) return { status: 'ignored', reason: 'invalid_callback' };
      const p = read();
      if (!p || p.nonce !== callback.nonce || p.stage !== 'waiting' || exchanging) return { status: 'ignored', reason: 'unsolicited_callback' };
      // Consume before the first await: duplicate event + getCurrent and cold-start replay cannot exchange twice.
      remove();
      if (callback.denied) throw new Error('provider_denied');
      exchanging = true;
      try {
        let result;
        try { result = await auth.exchangeCodeForSession(callback.code); } catch { throw new Error('exchange_failed'); }
        if (result?.error || !result?.data?.session || !result?.data?.user) throw new Error('exchange_failed');
        return { status: 'signed_in' };
      } finally { exchanging = false; }
    },
  };
}

/** Lifecycle boundary shared by the singleton and tests; listeners never receive URLs or credentials. */
export function createMobileAuthRuntime({ controller, onOpenUrl, getCurrent, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let snapshot = Object.freeze({ waiting: false, error: null, exchanging: false });
  const listeners = new Set();
  let mounts = 0;
  let timer;
  let queue = Promise.resolve();
  const safeCodes = new Set(['start_failed', 'open_failed', 'exchange_failed', 'provider_denied', 'busy', 'cancelled', 'storage_unavailable']);
  function update(patch) {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) listener(snapshot);
  }
  function pending() {
    try { return controller?.pending() ?? null; }
    catch { update({ error: 'storage_unavailable' }); return null; }
  }
  function schedule() {
    clearTimer(timer);
    const p = pending();
    if (mounts && p) timer = setTimer(() => {
      const next = pending();
      if (next) { schedule(); return; }
      update({ waiting: false, error: 'expired' });
    }, Math.max(1, p.expiresAt - now()));
  }
  function sync() { update({ waiting: !!pending() }); schedule(); }
  function fail(error) { update({ error: safeCodes.has(error?.message) ? error.message : 'start_failed' }); }
  async function consume(url, alive) {
    if (!alive() || !parseMobileAuthCallback(url)) return;
    clearTimer(timer);
    update({ exchanging: true });
    try {
      const result = await controller?.consume(url);
      if (result?.status === 'signed_in') update({ error: null });
    } catch (error) { fail(error); }
    finally { update({ exchanging: false }); sync(); }
  }
  function receive(urls, alive) {
    if (!Array.isArray(urls)) return;
    for (const url of urls) queue = queue.then(() => consume(url, alive));
  }
  sync();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async start(provider) {
      update({ waiting: true, error: null });
      try {
        if (!controller) throw new Error('start_failed');
        await controller.start(provider);
        return true;
      } catch (error) { fail(error); return false; }
      finally { sync(); }
    },
    cancel() {
      try {
        if (controller?.cancel() === false) return false;
        update({ error: null }); sync(); return true;
      } catch (error) { fail(error); return false; }
    },
    mount() {
      if (!controller) return () => {};
      let alive = true;
      let unlisten;
      mounts += 1;
      sync();
      // Install the warm listener before fetching launch URLs, closing the startup handoff gap.
      Promise.resolve().then(() => onOpenUrl((urls) => receive(urls, () => alive))).then(async (stop) => {
        if (!alive) { stop(); return; }
        unlisten = stop;
        const urls = await getCurrent();
        if (alive) receive(urls, () => alive);
      }).catch(() => { if (alive) update({ error: 'deep_link_unavailable' }); });
      return () => {
        if (!alive) return;
        alive = false;
        mounts -= 1;
        unlisten?.();
        if (!mounts) clearTimer(timer);
      };
    },
  };
}
