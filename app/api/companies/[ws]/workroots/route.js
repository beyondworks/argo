// 외부 작업 폴더 API — 설정 UI 전용(크루는 파일이 도트파일이라 게이트가 직접 수정을 막는다).
// 검증 실패는 코드로 반환하고 UI가 i18n 매핑한다 — 서버 한국어 하드코딩 금지(러너 감사 K7 계열 예방).
import { loadWorkRoots, loadPins, setPin, updateWorkRoots, MAX_WORK_ROOTS } from '../../../../../src/workroots.mjs';
import { guardCompany, csrfDenied } from '../../../../auth.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const [roots, pins] = await Promise.all([loadWorkRoots(ws), loadPins(ws)]);
  return Response.json({ roots, pins, max: MAX_WORK_ROOTS }); // pins = 크루별 고정 폴더(화면의 고정 칩 원천)
}

/** 추가/삭제 — 한 번에 하나씩. 다음 턴부터 즉시 반영(chat이 매 턴 읽는다). */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    // CSRF 가드 — 크루 접근 범위를 넓히는 상태변경이라 악성 웹페이지의 simple POST를 막는다
    // (export 라우트 검수 HIGH-1과 같은 계열 — 로컬 모드에선 guardCompany가 인증 장벽이 아니다).
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const denied = await guardCompany(ws); if (denied) return denied;
    const body = await req.json();
    // 고정/해제 — 같은 라우트에 두는 이유: 고정은 등록 목록 위에서만 성립하고(setPin이 대조한다)
    // CSRF·인증 게이트도 같은 것이 필요하다. 빈 path = 해제.
    if (body.pin && typeof body.pin.slug === 'string') {
      const pinned = await setPin(ws, body.pin.slug, body.pin.path ?? '');
      return Response.json({ pinned });
    }
    const roots = await updateWorkRoots(ws, { add: body.add, remove: body.remove });
    return Response.json({ roots });
  } catch (e) {
    return Response.json({ error: e.code || 'invalid', detail: String(e.message || e) }, { status: 400 });
  }
}
