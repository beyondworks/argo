import { readFile } from 'node:fs/promises';
import { AUTH_ON, currentUser, guardCompany } from './auth.mjs';
import { paths, getDeviceId } from '../src/workspace.mjs';
import { loadDeviceSession } from '../src/devicesession.mjs';
import { guestModeOn } from '../src/gueststate.mjs';
import { localAssetRequestDenied, localAssetPrincipalDenied, localAssetOwnerDenied } from '../src/local-asset-access.mjs';

const CORE_REASONS = new Set(['forbidden', 'target-changed', 'target-deleted', 'state-invalid', 'busy', 'invalid-roots', 'scan-expired', 'invalid-selection', 'selection-changed', 'invalid-name', 'source-changed', 'conflict', 'write-failed']);
export function localAssetFailure(error, fallback = 'internal') {
  const reason = CORE_REASONS.has(error?.reason) ? error.reason : fallback;
  return localAssetError(reason, reason === 'internal' ? 500 : reason === 'forbidden' ? 403 : 400);
}

export function localAssetError(reason = 'internal', status = 403) {
  return Response.json({ uiKey: `localImport.error.${reason}` }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function localAssetAccess(req, wsId) {
  let denied = localAssetRequestDenied(req);
  if (denied) return { response: localAssetError(denied) };
  const user = await currentUser();
  denied = localAssetPrincipalDenied({ user, deviceOwner: loadDeviceSession()?.user?.id, authOn: AUTH_ON, guest: guestModeOn() });
  if (denied) return { response: localAssetError(denied, denied === 'auth' ? 401 : 403) };
  if (wsId !== undefined) {
    let meta;
    try { meta = JSON.parse(await readFile(paths(wsId).company, 'utf8')); }
    catch { return { response: localAssetError('forbidden') }; }
    denied = localAssetOwnerDenied(user.id, meta);
    if (denied || await guardCompany(wsId)) return { response: localAssetError('forbidden') };
  }
  return { context: { principal: user.id, device: await getDeviceId() } };
}

export const localAssetResponse = (value) => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
