import { loadConnections, updateConnection, maskConnections } from '../../../../../src/connections.mjs';
import { ensureGateway } from '../../../../../src/gateway.mjs';

ensureGateway();

/** 연결 상태 — 토큰은 항상 마스킹해서 내보낸다. */
export async function GET(_req, { params }) {
  const { ws } = await params;
  return Response.json({ connections: maskConnections(await loadConnections(ws)) });
}

/** 연결 설정 — { kind: 'telegram'|'slack', token?, enabled?, defaultCrew?, channel? }. 빈 token은 기존 유지. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const { kind, ...patch } = await req.json();
    const allowed = {};
    for (const k of ['token', 'enabled', 'defaultCrew', 'channel']) {
      if (patch[k] !== undefined) allowed[k] = patch[k];
    }
    const all = await updateConnection(ws, kind, allowed);
    return Response.json({ connections: maskConnections(all) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
