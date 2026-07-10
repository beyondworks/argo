import { relative } from 'node:path';
import { chat } from '../../../../../src/chat.mjs';
import { paths } from '../../../../../src/workspace.mjs';

export const maxDuration = 300; // 에이전트 턴은 vault 탐색 포함 수 분까지 허용

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const { slug, message, sessionId } = await req.json();
    if (!slug || !message?.trim()) {
      return Response.json({ error: 'slug와 message가 필요합니다' }, { status: 400 });
    }
    const t = await chat(ws, slug, message.trim(), sessionId || null);
    return Response.json({
      reply: t.reply,
      sessionId: t.sessionId,
      handover: { rel: relative(paths(ws).vault, t.handover.file), linked: t.handover.linked },
    });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
