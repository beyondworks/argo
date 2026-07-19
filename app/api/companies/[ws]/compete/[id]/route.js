import { getCompetition, adoptWinner, renameCompetition, setCompetitionPinned } from '../../../../../../src/compete.mjs';
import { guardCompany } from '../../../../../auth.mjs';

export async function GET(_req, { params }) {
  try {
    const { ws, id } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    return Response.json(await getCompetition(ws, id));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 404 });
  }
}

/** 채택 — { action: 'adopt', slug } */
export async function POST(req, { params }) {
  try {
    const { ws, id } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { action, slug } = await req.json();
    if (action !== 'adopt') return Response.json({ error: '지원하지 않는 action' }, { status: 400 });
    return Response.json(await adoptWinner(ws, id, String(slug ?? '')));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 경쟁명 편집 또는 고정 토글 — 세션 레일 PATCH와 동일 계약. body: { title } | { pinned } */
export async function PATCH(req, { params }) {
  try {
    const { ws, id } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { title, pinned } = await req.json().catch(() => ({}));
    if (pinned !== undefined) return Response.json(await setCompetitionPinned(ws, id, pinned === true));
    return Response.json(await renameCompetition(ws, id, title));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
