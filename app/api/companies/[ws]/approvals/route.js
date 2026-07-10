import { loadApprovals, resolveApproval } from '../../../../../src/approvals.mjs';
import { chat } from '../../../../../src/chat.mjs';
import { loadThread, appendTurn } from '../../../../../src/thread.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const approvals = await loadApprovals(ws);
  return Response.json({
    approvals,
    pending: approvals.filter((a) => a.status === 'pending').length,
  });
}

/** 결재 처리 후 해당 크루의 스레드에서 후속 턴을 잇는다 — 승인이면 실행, 거절이면 대안 정리. */
async function followUp(ws, item, approve) {
  const msg = approve
    ? `(사장 결재) 요청한 "${item.action}" 이(가) 승인되었다. 이제 실행하고 결과를 보고하라.`
    : `(사장 결재) 요청한 "${item.action}" 이(가) 거절되었다. 실행하지 말고, 대안이 있으면 한두 줄로 정리하라.`;
  const t = await loadThread(ws, item.slug);
  const r = await chat(ws, item.slug, msg, t.sessionId);
  await appendTurn(ws, item.slug, { userMsg: msg, reply: r.reply, handover: r.handover, sessionId: r.sessionId });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const { id, approve } = await req.json();
    if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
    const item = await resolveApproval(ws, id, !!approve);
    // 후속 턴은 백그라운드 — 결재 UI는 즉시 반영되고, 실행 결과는 크루 대화에 쌓인다
    followUp(ws, item, !!approve).catch((e) => console.error('[approvals] 후속 턴 실패:', e));
    return Response.json({ item });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
