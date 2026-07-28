// 회사 데이터 내보내기 API — 자격 제외 정책은 src/export.mjs가 정본.
// 오류는 코드로 반환하고 UI가 i18n 매핑한다(서버 한국어 하드코딩 금지 — K7 계열 예방).
import { exportCompany } from '../../../../../src/export.mjs';
import { guardCompany, csrfDenied } from '../../../../auth.mjs';

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    // CSRF 가드 — 임의 경로에 회사 데이터 전체를 쓰는 벌크 write라, 로컬 모드(AUTH off)에서
    // 악성 웹페이지의 simple POST로 발동되면 안 된다(검수 HIGH-1). Host 검사는 이를 못 막는다.
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { dest } = await req.json();
    const r = await exportCompany(ws, dest);
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: e.code || 'invalid', detail: String(e.message || e) }, { status: 400 });
  }
}
