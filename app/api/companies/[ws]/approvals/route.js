import { loadApprovals } from '../../../../../src/approvals.mjs';
import { resolveWithFollowUp } from '../../../../../src/approval-actions.mjs';
import { approvalRisk } from '../../../../../src/approval-risk.mjs';
import { listAgents } from '../../../../../src/hub.mjs';
import { guardCompany, csrfDenied } from '../../../../auth.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const approvals = await loadApprovals(ws);
  // 표시용 이름 매핑 — 카드가 "누가 올린 결재인지(위임 출처 포함)"를 바로 보여준다(업무 흐름 가시화)
  const agents = await listAgents(ws).catch(() => []);
  const nameOf = (s) => agents.find((a) => a.slug === s)?.name ?? s;
  // 위험 등급 — 메신저 카드와 같은 판정(approvalRisk, 새 판정 만들지 않는다 — 분리 검수 M-1)을 본체 카드도
  // 그대로 써서, 고위험 결재는 본체 화면에서도 "명령 보기" 기본 펼침 + 고위험 표시를 낼 수 있게 한다.
  return Response.json({
    approvals: approvals.map((a) => ({ ...a, risk: approvalRisk(a), crewName: nameOf(a.slug), ...(a.from ? { fromName: nameOf(a.from) } : {}) })),
    pending: approvals.filter((a) => a.status === 'pending').length,
  });
}

/** 결재 처리 — 상태는 즉시 반영, 후속 턴(승인=실행/거절=대안)은 백그라운드로 크루 대화에 쌓인다. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    // CSRF — 승인은 이제 외부 서비스에 되돌릴 수 없는 쓰기를 실행시킨다(커넥터 결재, PR #222).
    // 로컬 모드에선 guardCompany가 인증 장벽이 아니라, 악성 페이지의 simple POST가 사장 클릭 없이
    // 결재를 승인시킬 수 있다(분리 검수 지적 2026-08-01 — 커넥터 라우트와 같은 패턴으로 막는다).
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id, approve } = await req.json();
    if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
    const item = await resolveWithFollowUp(ws, id, !!approve);
    return Response.json({ item });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
