import {
  SKILL_CATALOG, MCP_CATALOG,
  listInstalledSkills, installSkill, removeSkill,
  loadMcp, installMcp, addCustomMcp, removeMcp,
} from '../../../../../src/market.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const [skills, mcp] = await Promise.all([listInstalledSkills(ws), loadMcp(ws)]);
  return Response.json({
    skillCatalog: SKILL_CATALOG.map(({ md, ...rest }) => ({ ...rest, preview: md.slice(0, 200) })),
    mcpCatalog: MCP_CATALOG,
    installedSkills: skills,
    installedMcp: mcp.servers ?? {},
  });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const body = await req.json();
    if (body.kind === 'skill') await installSkill(ws, body.id);
    else if (body.kind === 'mcp') await installMcp(ws, body.id);
    else if (body.kind === 'mcp-custom') await addCustomMcp(ws, body.def ?? {});
    else return Response.json({ error: '알 수 없는 kind' }, { status: 400 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export async function DELETE(req, { params }) {
  const { ws } = await params;
  const u = new URL(req.url);
  const kind = u.searchParams.get('kind');
  const id = u.searchParams.get('id');
  if (!kind || !id) return Response.json({ error: 'kind·id가 필요합니다' }, { status: 400 });
  if (kind === 'skill') await removeSkill(ws, id);
  else await removeMcp(ws, id);
  return Response.json({ ok: true });
}
