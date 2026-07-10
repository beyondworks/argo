import { createCompany } from '../../../src/workspace.mjs';
import { listCompanies } from '../../../src/hub.mjs';

export async function GET() {
  return Response.json({ companies: await listCompanies() });
}

export async function POST(req) {
  try {
    const { name, owner } = await req.json();
    if (!name?.trim()) return Response.json({ error: '회사 이름이 필요합니다' }, { status: 400 });
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const wsId = `${base || 'co'}-${Date.now().toString(36).slice(-4)}`;
    const company = await createCompany(wsId, name.trim(), owner?.trim() || 'captain');
    return Response.json({ company });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
