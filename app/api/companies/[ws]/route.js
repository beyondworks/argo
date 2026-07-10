import { loadCompany } from '../../../../src/workspace.mjs';
import { listAgents, listDocs } from '../../../../src/hub.mjs';

export async function GET(_req, { params }) {
  try {
    const { ws } = await params;
    const [company, agents, docs] = await Promise.all([
      loadCompany(ws), listAgents(ws), listDocs(ws),
    ]);
    return Response.json({ company, agents, memories: docs.slice(0, 6), memoryCount: docs.length });
  } catch {
    return Response.json({ error: '회사를 찾을 수 없습니다' }, { status: 404 });
  }
}
