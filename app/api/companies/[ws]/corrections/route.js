// 크루 길들이기 제안 API — "같은 지적 두 번이면 규칙"(리서치 접목 F). 판단은 AI(감지 대장),
// 결정은 사장(이 API의 adopt/dismiss). 채택은 skills/사장-지침.md 적립 = 전 크루 자동 반영.
import { listSuggestions, adoptCorrection, dismissCorrection } from '../../../../../src/corrections.mjs';
import { guardCompany, csrfDenied } from '../../../../auth.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  return Response.json({ suggestions: await listSuggestions(ws) });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const csrf = csrfDenied(req); if (csrf) return csrf; // 회사 규칙(전 크루 지침) 상태변경
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id, action } = await req.json();
    if (typeof id !== 'string' || !id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
    if (action === 'adopt') return Response.json({ ok: true, ...(await adoptCorrection(ws, id)) });
    if (action === 'dismiss') { await dismissCorrection(ws, id); return Response.json({ ok: true }); }
    return Response.json({ error: 'action은 adopt 또는 dismiss' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
