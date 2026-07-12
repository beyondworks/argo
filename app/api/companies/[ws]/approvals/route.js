import { loadApprovals } from '../../../../../src/approvals.mjs';
import { resolveWithFollowUp } from '../../../../../src/approval-actions.mjs';
import { guardCompany } from '../../../../auth.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const approvals = await loadApprovals(ws);
  return Response.json({
    approvals,
    pending: approvals.filter((a) => a.status === 'pending').length,
  });
}

/** 결재 처리 — 상태는 즉시 반영, 후속 턴(승인=실행/거절=대안)은 백그라운드로 크루 대화에 쌓인다. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id, approve } = await req.json();
    if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
    const item = await resolveWithFollowUp(ws, id, !!approve);
    return Response.json({ item });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
