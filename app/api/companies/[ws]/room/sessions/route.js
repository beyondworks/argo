import { listArchivedMeetings, readArchivedMeeting, renameMeeting, setMeetingPinned, reopenMeeting } from '../../../../../../src/room.mjs';
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

/** 회의명 편집·고정 토글·다시 열기 — 채팅 세션 PATCH와 동일 계약.
    body: { id, title } | { id, pinned } | { id, reopen: true } */
export async function PATCH(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { id, title, pinned, reopen } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
  try {
    // 다시 열기는 진행 중 회의가 있으면 거절한다(덮어쓰기 금지) — 409로 구분해 화면이 안내를 띄운다
    if (reopen === true) return Response.json(await reopenMeeting(ws, id));
    if (pinned !== undefined) return Response.json(await setMeetingPinned(ws, id, pinned === true));
    return Response.json(await renameMeeting(ws, id, title));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: e?.code === 'ROOM_BUSY' ? 409 : 400 });
  }
}
