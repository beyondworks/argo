import { relative } from 'node:path';
import { chat } from '../../../../../src/chat.mjs';
import { paths } from '../../../../../src/workspace.mjs';
import { loadThread, appendTurn, resetThread } from '../../../../../src/thread.mjs';
import { getTurnStatus } from '../../../../../src/turn-status.mjs';
import { nudgeSync } from '../../../../../src/sync.mjs';
import { guardCompany } from '../../../../auth.mjs';

export const maxDuration = 300; // 에이전트 턴은 vault 탐색 포함 수 분까지 허용

/** 저장된 스레드 로드 — 새로고침해도 대화가 이어진다. */
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const search = new URL(req.url).searchParams;
  const slug = search.get('slug');
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  const [thread, status] = await Promise.all([loadThread(ws, slug), getTurnStatus(ws, slug)]);
  // 긴 대화는 최근 구간부터 보내고, 사용자가 위로 요청할 때만 이전 구간을 내려준다.
  // limit/before/after가 없는 기존 호출자는 전체 스레드를 받는 하위호환 계약을 유지한다.
  const windowed = search.has('limit') || search.has('before') || search.has('after');
  if (!windowed) return Response.json({ ...thread, status });
  const all = Array.isArray(thread.messages) ? thread.messages : [];
  const totalMessages = all.length;
  const limit = Math.max(1, Math.min(100, Number(search.get('limit')) || 50));
  const afterRaw = search.get('after');
  let start;
  let end;
  if (afterRaw !== null) {
    start = Math.max(0, Math.min(totalMessages, Number(afterRaw) || 0));
    end = totalMessages;
  } else {
    end = Math.max(0, Math.min(totalMessages, Number(search.get('before')) || totalMessages));
    start = Math.max(0, end - limit);
  }
  return Response.json({
    ...thread,
    messages: all.slice(start, end),
    totalMessages,
    start,
    hasMore: start > 0,
    status,
  });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
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
    // handover 없는 턴(예: 예산 초과 안내)도 안전하게 — null 접근 크래시 방지
    const handover = t.handover ? { rel: relative(paths(ws).vault, t.handover.file), linked: t.handover.linked } : null;
    const saved = await appendTurn(ws, slug, { userMsg: message.trim(), reply: t.reply, handover, sessionId: t.sessionId, attachments, artifacts: t.artifacts });
    nudgeSync(); // 로컬 변경 즉시 다른 기기로 전파(준실시간 — 다음 대기 건너뜀)
    return Response.json({ reply: t.reply, sessionId: t.sessionId, handover, artifacts: t.artifacts, totalMessages: saved.messages?.length ?? 0 });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}

/** 새 대화 — 스레드·세션 리셋. vault 기억은 유지된다. */
export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const slug = new URL(req.url).searchParams.get('slug');
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  await resetThread(ws, slug);
  return Response.json({ ok: true });
}
