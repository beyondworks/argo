import { createCompany } from '../../../src/workspace.mjs';
import { listCompanies } from '../../../src/hub.mjs';
import { applyPreset, PRESETS } from '../../../src/presets.mjs';

export async function GET() {
  return Response.json({
    companies: await listCompanies(),
    presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, desc: p.desc })),
  });
}

export async function POST(req) {
  try {
    const { name, owner, preset } = await req.json();
    if (!name?.trim()) return Response.json({ error: '회사 이름이 필요합니다' }, { status: 400 });
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const wsId = `${base || 'co'}-${Date.now().toString(36).slice(-4)}`;
    const company = await createCompany(wsId, name.trim(), owner?.trim() || 'captain');
    if (preset) await applyPreset(wsId, preset); // 즉시 — 정적 카드라 기다림 없음
    return Response.json({ company });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
