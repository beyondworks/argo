import { readLocalAssetJson } from '../../../../../src/local-asset-access.mjs';
import { localAssetAccess, localAssetError, localAssetResponse, localAssetFailure } from '../../../../local-assets-auth.mjs';
import { localAssetStatus, previewLocalAssets, executeLocalAssets } from '../../../../../src/local-asset-import.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req, { params }) {
  try {
    const { ws } = await params;
    const { response, context } = await localAssetAccess(req, ws);
    if (response) return response;
    return localAssetResponse(await localAssetStatus(ws, context));
  } catch (error) { return localAssetFailure(error); }
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const { response, context } = await localAssetAccess(req, ws);
    if (response) return response;
    const body = await readLocalAssetJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return localAssetError('invalid', 400);
    const allowed = body.action === 'preview' ? ['action', 'approvedRootIds'] : ['action', 'scanId', 'selectedIds', 'consents', 'renames'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) return localAssetError('invalid', 400);
    if (body.action === 'preview') return localAssetResponse(await previewLocalAssets(ws, context, { approvedRootIds: body.approvedRootIds }));
    if (body.action === 'import') return localAssetResponse(await executeLocalAssets(ws, context, { scanId: body.scanId, selectedIds: body.selectedIds, consents: body.consents, renames: body.renames }));
    return localAssetError('invalid', 400);
  } catch (error) { return localAssetFailure(error, 'invalid'); }
}
