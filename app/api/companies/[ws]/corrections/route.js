// 크루 길들이기 제안 API — "같은 지적 두 번이면 규칙"(리서치 접목 F). 판단은 AI(감지 대장),
// 결정은 사장(이 API의 adopt/dismiss). 채택은 skills/사장-지침.md 적립 = 전 크루 자동 반영.
import { listSuggestions, adoptCorrection, dismissCorrection } from '../../../../../src/corrections.mjs';
import { guardCompany, csrfDenied } from '../../../../auth.mjs';

export async function GET(_req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    return Response.json({ suggestions: await listSuggestions(ws) });
  } catch (e) {
    // 대장 오염이 칩 로드를 500으로 만들지 않는다(검수 M1) — 제안 없음으로 관용
    console.error('[argo] 교정 제안 조회 실패:', e?.message ?? e);
    return Response.json({ suggestions: [] });
  }
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const csrf = csrfDenied(req); if (csrf) return csrf; // 회사 규칙(전 크루 지침) 상태변경
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id, action } = await req.json();
    if (typeof id !== 'string' || !id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
    if (action === 'adopt') {
      const { loadCompany } = await import('../../../../../src/workspace.mjs');
      const lang = (await loadCompany(ws).catch(() => ({}))).lang === 'en' ? 'en' : 'ko';
      return Response.json({ ok: true, ...(await adoptCorrection(ws, id, { lang })) });
    }
    if (action === 'dismiss') { await dismissCorrection(ws, id); return Response.json({ ok: true }); }
    return Response.json({ error: 'action은 adopt 또는 dismiss' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
