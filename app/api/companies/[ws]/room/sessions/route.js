import { listArchivedMeetings, readArchivedMeeting, renameMeeting, setMeetingPinned, reopenMeeting, parkMeeting } from '../../../../../../src/room.mjs';
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

/** 새 회의 — 지금 회의를 마치지 않고 '진행 중'으로 보관한 뒤 방을 비운다(회의록은 마칠 때만). body 없음.
    크루가 발언 중이면 409 ROOM_BUSY(DELETE /room과 같은 오류 바디 계약). */
export async function POST(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    return Response.json(await parkMeeting(ws));
  } catch (e) {
    return Response.json({ error: String(e.message || e), errorCode: e?.code }, { status: e?.code === 'ROOM_BUSY' ? 409 : 400 });
  }
}

/** 회의명 편집·고정 토글·열기(전환) — 채팅 세션 PATCH와 동일 계약.
    body: { id, title } | { id, pinned } | { id, reopen: true } */
export async function PATCH(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { id, title, pinned, reopen } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
  try {
    // 열기(전환) — 현재 회의가 있으면 진행 중으로 자동 보관하고 연다. 크루 발언 중이면 409 ROOM_BUSY로 구분해
    // 화면이 표시 언어 안내를 띄운다(종전의 '방이 비어 있지 않으면 409'는 새 회의 분기로 폐지).
    if (reopen === true) return Response.json(await reopenMeeting(ws, id));
    if (pinned !== undefined) return Response.json(await setMeetingPinned(ws, id, pinned === true));
    return Response.json(await renameMeeting(ws, id, title));
  } catch (e) {
    return Response.json({ error: String(e.message || e), errorCode: e?.code }, { status: e?.code === 'ROOM_BUSY' ? 409 : 400 });
  }
}
