import { loadRoom, runRoomTurn, endMeeting } from '../../../../../src/room.mjs';

export const maxDuration = 300; // 여러 크루가 순차 발언 — 오래 걸릴 수 있다

export async function GET(_req, { params }) {
  const { ws } = await params;
  return Response.json(await loadRoom(ws));
}

/** 회의 마치기 — 회의록을 vault 일지로 적재하고 방을 비운다(대화는 chats/.archive/에 보관). */
export async function DELETE(_req, { params }) {
  try {
    const { ws } = await params;
    return Response.json(await endMeeting(ws));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const { message } = await req.json();
    if (!message?.trim()) return Response.json({ error: 'message가 필요합니다' }, { status: 400 });
    return Response.json(await runRoomTurn(ws, message.trim()));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
