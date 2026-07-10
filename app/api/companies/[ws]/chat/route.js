import { relative } from 'node:path';
import { chat } from '../../../../../src/chat.mjs';
import { paths } from '../../../../../src/workspace.mjs';
import { loadThread, appendTurn, resetThread } from '../../../../../src/thread.mjs';
import { getTurnStatus } from '../../../../../src/turn-status.mjs';

export const maxDuration = 300; // 에이전트 턴은 vault 탐색 포함 수 분까지 허용

/** 저장된 스레드 로드 — 새로고침해도 대화가 이어진다. */
export async function GET(req, { params }) {
  const { ws } = await params;
  const slug = new URL(req.url).searchParams.get('slug');
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  const [thread, status] = await Promise.all([loadThread(ws, slug), getTurnStatus(ws, slug)]);
  return Response.json({ ...thread, status });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const { slug, message, sessionId, attachments: rawAtt } = await req.json();
    if (!slug || !message?.trim()) {
      return Response.json({ error: 'slug와 message가 필요합니다' }, { status: 400 });
    }
    // 첨부는 업로드 API가 발급한 vault/files/ 상대경로만 신뢰한다(경로 탈출 차단)
    const attachments = (Array.isArray(rawAtt) ? rawAtt : [])
      .filter((a) => typeof a?.rel === 'string' && a.rel.startsWith('files/') && !a.rel.includes('..'))
      .map((a) => ({ rel: a.rel, name: String(a.name ?? ''), mime: String(a.mime ?? ''), isImage: !!a.isImage }))
      .slice(0, 8);
    const t = await chat(ws, slug, message.trim(), sessionId || null, { attachments });
    const handover = { rel: relative(paths(ws).vault, t.handover.file), linked: t.handover.linked };
    await appendTurn(ws, slug, { userMsg: message.trim(), reply: t.reply, handover, sessionId: t.sessionId, attachments });
    return Response.json({ reply: t.reply, sessionId: t.sessionId, handover });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}

/** 새 대화 — 스레드·세션 리셋. vault 기억은 유지된다. */
export async function DELETE(req, { params }) {
  const { ws } = await params;
  const slug = new URL(req.url).searchParams.get('slug');
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  await resetThread(ws, slug);
  return Response.json({ ok: true });
}
