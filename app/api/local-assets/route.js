import { readLocalAssetJson } from '../../../src/local-asset-access.mjs';
import { localAssetAccess, localAssetError, localAssetResponse, localAssetFailure } from '../../local-assets-auth.mjs';
import { discoverLocalAssets, deferLocalAssets } from '../../../src/local-asset-import.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { response, context } = await localAssetAccess(req);
    if (response) return response;
    return localAssetResponse(await discoverLocalAssets(context));
  } catch (error) { return localAssetFailure(error); }
}

export async function POST(req) {
  try {
    const { response, context } = await localAssetAccess(req);
    if (response) return response;
    const body = await readLocalAssetJson(req);
    if (body?.action !== 'defer' || Object.keys(body).length !== 1) return localAssetError('invalid', 400);
    return localAssetResponse(await deferLocalAssets(context));
  } catch (error) { return localAssetFailure(error, 'invalid'); }
}
