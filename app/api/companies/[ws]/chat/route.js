import { relative } from 'node:path';
import { chat } from '../../../../../src/chat.mjs';
import { paths } from '../../../../../src/workspace.mjs';
import { loadThread, appendTurn, appendUserMsg, completePendingTurn, failPendingTurn, resetThread } from '../../../../../src/thread.mjs';
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
    // 1단계: 사용자 메시지 사전 저장
    // 지시를 **먼저** 저장한다 — 답변을 기다리는 동안 새로고침하거나 페이지를 벗어나도 내가 쓴 글이 그대로 남아 있어야 한다(신고 2026-08-02).
    const mid = `t${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await appendUserMsg(ws, slug, { userMsg: message.trim(), attachments, mid })
      .catch((err) => { console.error(`[argo] 지시 선저장 실패(${ws}/${slug}):`, err?.message ?? err); });
    nudgeSync(); // 다른 기기에도 곧바로 보이게

    let t;
    try {
      // 2단계: 답변 생성
      t = await chat(ws, slug, message.trim(), sessionId || null, { attachments });
    } catch (e) {
      // 실패·중단 턴도 스레드에 남긴다 — 성공 뒤에만 저장하면 지시문이 새로고침에 증발하고 비용만
      // 남는다(전수리뷰 2026-07-30 #1). UI는 m.failed로 사유+재전송을 그린다(기존 낙관 사본 패턴).
      const failed = String(e?.message || e);
      const aborted = !!e?.aborted;
      // 저장 성공 여부(saved)를 응답에 싣는다
      const saved = await failPendingTurn(ws, slug, { mid, error: failed, aborted })
        .then(() => true)
        .catch((err) => { console.error(`[argo] 실패 턴 기록 실패(${ws}/${slug}):`, err?.message ?? err); return false; });
      if (saved) nudgeSync();
      return Response.json({ error: failed, aborted, saved }, { status: 500 });
    }

    // 3단계: 답변 저장
    // handover 없는 턴(예: 예산 초과 안내)도 안전하게 — null 접근 크래시 방지
    const handover = t.handover ? { rel: relative(paths(ws).vault, t.handover.file), linked: t.handover.linked } : null;
    const saved = await completePendingTurn(ws, slug, { mid, reply: t.reply, handover, sessionId: t.sessionId, artifacts: t.artifacts });
    nudgeSync(); // 로컬 변경 즉시 다른 기기로 전파(준실시간 — 다음 대기 건너뜀)
    return Response.json({ reply: t.reply, sessionId: t.sessionId, handover, artifacts: t.artifacts, totalMessages: saved?.messages?.length ?? 0 });
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
