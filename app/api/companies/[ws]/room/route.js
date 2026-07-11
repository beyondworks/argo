import { loadRoom, runRoomTurn } from '../../../../../src/room.mjs';

export const maxDuration = 300; // 여러 크루가 순차 발언 — 오래 걸릴 수 있다

export async function GET(_req, { params }) {
  const { ws } = await params;
  return Response.json(await loadRoom(ws));
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
