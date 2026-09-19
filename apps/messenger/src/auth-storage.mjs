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
