import { listArchivedSessions, readArchivedSession } from '../../../../../../src/thread.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 세션 적재 레일 — 목록(slug) 또는 보관 세션 1건(slug+id, 읽기 전용). */
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  const id = url.searchParams.get('id');
  try {
    if (id) return Response.json(await readArchivedSession(ws, slug, id));
    return Response.json({ sessions: await listArchivedSessions(ws, slug) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
