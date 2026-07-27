// 회사 데이터 내보내기 API — 자격 제외 정책은 src/export.mjs가 정본.
// 오류는 코드로 반환하고 UI가 i18n 매핑한다(서버 한국어 하드코딩 금지 — K7 계열 예방).
import { exportCompany } from '../../../../../src/export.mjs';
import { guardCompany } from '../../../../auth.mjs';

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { dest } = await req.json();
    const r = await exportCompany(ws, dest);
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: e.code || 'invalid', detail: String(e.message || e) }, { status: 400 });
  }
}
