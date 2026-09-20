export function authStorageKey(url) {
  try { return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`; }
  catch { return ''; }
}

export function hasStoredAuthSession(key, store = globalThis.localStorage) {
  try {
    if (!key) return false;
    const raw = store?.getItem(key);
    if (!raw) return false;
    const value = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      && typeof value.access_token === 'string' && value.access_token.length > 0
      && typeof value.refresh_token === 'string' && value.refresh_token.length > 0
      && typeof value.expires_at === 'number' && Number.isFinite(value.expires_at);
  }
  catch { return false; }
}

export function authCleanupState(key, store = globalThis.localStorage) {
  const markerKey = `${key}-argo-cleanup-pending`;
  const fingerprint = (value) => {
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= BigInt(value.charCodeAt(index));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
  };
  const storedAuthFingerprint = () => fingerprint(store.getItem(key) ?? '');
  const record = () => {
    const value = store.getItem(markerKey);
    if (value === '1' || value === 'pending') return { phase: 'pending', auth: null };
    if (value === 'complete') return { phase: 'complete', auth: null };
    try {
      const parsed = JSON.parse(value);
      return ['pending', 'complete'].includes(parsed?.phase) ? parsed : null;
    } catch { return null; }
  };
  return {
    begin() { store.setItem(markerKey, JSON.stringify({ phase: 'pending', auth: storedAuthFingerprint() })); },
    complete() {
      const current = record();
      store.setItem(markerKey, JSON.stringify({ phase: 'complete', auth: current?.auth ?? storedAuthFingerprint() }));
    },
    clear() { store.removeItem(markerKey); },
    read() { return record()?.phase ?? null; },
    hasNewSession() {
      const current = record();
      return !!store.getItem(key) && current?.auth !== null && current?.auth !== storedAuthFingerprint();
    },
    matches(event) { return event?.key === markerKey; },
  };
}
