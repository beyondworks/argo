import { listArchivedMeetings, readArchivedMeeting } from '../../../../../../src/room.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 회의 적재 레일 — 목록 또는 보관 회의 1건(읽기 전용). */
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id');
  try {
    if (id) return Response.json(await readArchivedMeeting(ws, id));
    return Response.json({ sessions: await listArchivedMeetings(ws) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
