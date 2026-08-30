// 클라우드 자료 내보내기 API — 계정 단위(전 회사). 자격 제외·목적지 자동 규칙은 src/cloudexport.mjs가 정본.
// free(체험 만료) 사용자도 허용되는 것이 이 기능의 존재 이유다 — 플랜 게이트를 두지 않는다
// (스토리지 read는 RLS가 소유자 경계만 본다). 오류는 코드로 반환하고 UI가 i18n 매핑한다(K7 계열 예방).
import { exportCloudToLocal } from '../../../../src/cloudexport.mjs';
import { currentUser, csrfDenied, tenantDenied, requestLang } from '../../../auth.mjs';

export async function POST(req) {
  try {
    // CSRF 가드 — 로컬 디스크에 벌크 write하는 라우트라, 로컬 모드(AUTH off)에서 악성 웹페이지의
    // simple POST로 발동되면 안 된다(회사 내보내기 라우트와 동일 계급, 검수 HIGH-1 계열).
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const user = await currentUser();
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const td = tenantDenied(user, await requestLang()); if (td) return td;
    // 오너는 서버가 자격(기기 세션·서비스 자격)에서 해석한다 — 요청 본문을 신뢰하지 않는다.
    // requesterId 대조: 서비스 모드(RLS 우회)에서 ARGO_SYNC_OWNER 오설정이 남의 계정 자료를
    // 덤프하지 않게 하는 심층 방어(분리 검수 MED). 2026-08-06부터 currentUser는 쿠키 세션 우선 —
    // 비루프백 노출 구성에서 쿠키 사용자 ≠ 기기 주인이면 owner-mismatch로 거부된다(fail-closed,
    // 의도된 방향: 남의 기기 자료를 자기 계정으로 내보낼 수 없다).
    const r = await exportCloudToLocal({ requesterId: user.id });
    return Response.json(r);
  } catch (e) {
    const code = e.code || 'invalid';
    return Response.json({ error: code, detail: String(e.message || e) }, { status: code === 'busy' ? 409 : 400 });
  }
}
