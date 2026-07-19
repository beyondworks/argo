import { listArchivedMeetings, readArchivedMeeting, renameMeeting, setMeetingPinned } from '../../../../../../src/room.mjs';
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

/** 회의명 편집 또는 고정 토글 — 채팅 세션 PATCH와 동일 계약. body: { id, title } | { id, pinned } */
export async function PATCH(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { id, title, pinned } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
  try {
    if (pinned !== undefined) return Response.json(await setMeetingPinned(ws, id, pinned === true));
    return Response.json(await renameMeeting(ws, id, title));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
