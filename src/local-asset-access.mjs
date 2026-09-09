// Startup proof is a launcher contract, not authentication against the OS owner.
export function localBindProof(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(host) ? host : '';
}

export function localAssetRequestDenied(req, env = process.env) {
  if (env.ARGO_TENANT_OWNER?.trim() || !localBindProof(env.ARGO_LOCAL_BIND_PROOF)) return 'unavailable';
  const host = req.headers.get('host') || '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return 'unavailable';
  let url;
  try { url = new URL(req.url); } catch { return 'origin'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'origin';
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return 'origin';
  const origin = req.headers.get('origin');
  // NextRequest normalizes all loopback URL hosts to localhost; Origin keeps the actual Host.
  if (origin && origin !== `${url.protocol}//${host}`) return 'origin';
  // Origin absence is accepted only after the local principal/device gate below.
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return 'invalid';
  return null;
}

export function localAssetPrincipalDenied({ user, deviceOwner, authOn, guest }) {
  if (!user?.id) return 'auth';
  if (user.id === 'local') return deviceOwner || (authOn && !guest) ? 'forbidden' : null;
  return deviceOwner === user.id ? null : 'forbidden';
}

export function localAssetOwnerDenied(principal, meta) {
  if (!meta || typeof meta !== 'object') return 'forbidden';
  return principal === 'local' ? (meta.ownerId ? 'forbidden' : null) : (meta.ownerId === principal ? null : 'forbidden');
}

export async function readLocalAssetJson(req) {
  const limit = 256 * 1024;
  const reader = req.body?.getReader();
  if (!reader) throw new Error('invalid-json');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('body-too-large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
}
