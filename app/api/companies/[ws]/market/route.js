import {
  SKILL_CATALOG, MCP_CATALOG,
  listInstalledSkills, installSkill, removeSkill,
  loadMcp, installMcp, addCustomMcp, removeMcp,
} from '../../../../../src/market.mjs';
import {
  searchRemoteSkills, installRemoteSkill,
  searchRemoteMcp, installRemoteMcp,
  topRemoteSkills, topRemoteMcp, explainItem, warmExplains,
} from '../../../../../src/remote-market.mjs';
import { guardCompany } from '../../../../auth.mjs';

export const maxDuration = 120; // explain = 모델 1턴

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const u = new URL(req.url);
  const remote = u.searchParams.get('remote');
  const top = u.searchParams.get('top');

  // 추천 TOP 20 — 스킬(skillsmp ★순) / MCP(npm 주간 다운로드순)
  if (top) {
    try {
      const results = top === 'skills' ? await topRemoteSkills() : await topRemoteMcp();
      warmExplains(results, top === 'skills' ? 'skill' : 'mcp'); // 백그라운드 — 응답을 막지 않는다
      return Response.json({ results });
    } catch (e) {
      return Response.json({ results: [], error: `추천 목록 로드 실패: ${String(e.message || e)}` });
    }
  }

  // 원격 마켓 검색 — skillsmp / 공식 MCP 레지스트리
  if (remote) {
    const q = u.searchParams.get('q') ?? '';
    try {
      const results = remote === 'skills' ? await searchRemoteSkills(q) : await searchRemoteMcp(q);
      return Response.json({ results });
    } catch (e) {
      return Response.json({ results: [], error: `원격 마켓 연결 실패: ${String(e.message || e)}` });
    }
  }

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
    const denied = await guardCompany(ws); if (denied) return denied;
    const body = await req.json();
    if (body.kind === 'skill') await installSkill(ws, body.id);
    else if (body.kind === 'mcp') await installMcp(ws, body.id);
    else if (body.kind === 'mcp-custom') await addCustomMcp(ws, body.def ?? {});
    else if (body.kind === 'remote-skill') await installRemoteSkill(ws, body.item ?? {});
    else if (body.kind === 'remote-mcp') await installRemoteMcp(ws, body.item ?? {});
    else if (body.kind === 'explain') return Response.json(await explainItem(body.item ?? {}));
    else return Response.json({ error: '알 수 없는 kind' }, { status: 400 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const u = new URL(req.url);
  const kind = u.searchParams.get('kind');
  const id = u.searchParams.get('id');
  if (!kind || !id) return Response.json({ error: 'kind·id가 필요합니다' }, { status: 400 });
  if (kind === 'skill') await removeSkill(ws, id);
  else await removeMcp(ws, id);
  return Response.json({ ok: true });
}
