/** Desktop assets have a private origin; shared links and mail requests use the web service. */
export function webOrigin(value, { allowLocal = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('office_web_origin'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:'))) {
    throw new Error('office_web_origin');
  }
  return url.origin;
}

export function webAddress(origin, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('office_web_path');
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error('office_web_path');
  return url.href;
}

export function externalAddress(value) {
  const url = new URL(value);
  if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) throw new Error('office_external_url');
  return url.href;
}
