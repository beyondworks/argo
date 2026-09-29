export const MAIL_TIMEOUT = 10 * 60_000;
export const authError = (code) => Object.assign(new Error(code), { code });

export function mailAuthorization(url, { reviewOrigin, reviewEnabled = false } = {}) {
  const u = new URL(url);
  const google = u.origin === 'https://accounts.google.com' && u.pathname === '/o/oauth2/v2/auth';
  const localReview = reviewEnabled && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(reviewOrigin ?? '') && u.origin === reviewOrigin && u.pathname === '/auth';
  if ((!google && !localReview) || u.username || u.password || u.hash) throw authError('state');
  const state = u.searchParams.get('state');
  if (!state || u.searchParams.getAll('state').length !== 1) throw authError('state');
  return state;
}

/** Only the locally initiated request may consume a callback. Remove pending before exchanging. */
export function acceptMailCallback(url, pending, uid, now = Date.now()) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'argo-office:' || u.hostname !== 'mail' || u.pathname !== '/callback' || u.port || u.username || u.password || u.hash) return null;
  const q = u.searchParams;
  if (!pending || q.get('state') !== pending.state || q.getAll('state').length !== 1) return null;
  if (pending.expires <= now) throw authError('expired');
  if (!uid || uid !== pending.uid) throw authError('signed_out');
  if (q.getAll('code').length > 1 || q.getAll('error').length > 1 || (q.has('code') === q.has('error'))) throw authError('state');
  if (q.has('error')) throw authError(q.get('error') === 'access_denied' ? 'access_denied' : 'state');
  if (!q.get('code')) throw authError('state');
  return { code: q.get('code'), state: pending.state };
}

export function localPasswordAllowed({ configured, dev, review, url }) {
  return !!(configured && (dev || review === '1') && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url));
}
