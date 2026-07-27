// 외부 작업 폴더 API — 설정 UI 전용(크루는 파일이 도트파일이라 게이트가 직접 수정을 막는다).
// 검증 실패는 코드로 반환하고 UI가 i18n 매핑한다 — 서버 한국어 하드코딩 금지(러너 감사 K7 계열 예방).
import { loadWorkRoots, updateWorkRoots, MAX_WORK_ROOTS } from '../../../../../src/workroots.mjs';
import { guardCompany } from '../../../../auth.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  return Response.json({ roots: await loadWorkRoots(ws), max: MAX_WORK_ROOTS });
}

/** 추가/삭제 — 한 번에 하나씩. 다음 턴부터 즉시 반영(chat이 매 턴 읽는다). */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const body = await req.json();
    const roots = await updateWorkRoots(ws, { add: body.add, remove: body.remove });
    return Response.json({ roots });
  } catch (e) {
    return Response.json({ error: e.code || 'invalid', detail: String(e.message || e) }, { status: 400 });
  }
}
