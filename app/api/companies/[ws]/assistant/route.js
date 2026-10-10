// 하트비트(코드 이름 assistant, 설계 13절) — GET 설정·지금 하트비트·상태, PUT 설정, DELETE 끄기(설정 지움).
// 관리 화면은 루틴 화면의 하트비트 칸(app/c/[ws]/routines/heartbeat-card.jsx), 에이전트 카드 하트비트 탭(crew/[slug]/assistant-section.jsx)은 GET만 쓴다.
// 읽기·쓰기 모두 로컬 파일이다(Supabase 호출 0). 저장은 assistant.json과 company.json 봉인을 같이 쓴다 — 쓰기 규칙은 src/assistant/settings.mjs.
import { assistantSettingsView, saveAssistantSettings, removeAssistantSettings } from '../../../../../src/assistant/settings.mjs';
import { guardCompany, requestLang, csrfDenied } from '../../../../auth.mjs';
import { apiError, apiErrorFrom } from '../../../../apimsg.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    return Response.json(await assistantSettingsView(ws));
  } catch (e) {
    return apiErrorFrom(e, await requestLang(), 500);
  }
}

export async function PUT(req, { params }) {
  try {
    // CSRF — 비서를 켜면 일정을 읽고 알림을 보낸다(회사 설정 PUT·fullAuto와 같은 이유로 악성 페이지의 요청을 막는다)
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return apiError('assistant_bad_request', await requestLang());
    await saveAssistantSettings(ws, body);
    return Response.json(await assistantSettingsView(ws));
  } catch (e) {
    return apiErrorFrom(e, await requestLang(), 500); // 코드 달린 검증 오류는 화면 언어 문구·400(apimsg.mjs API_MSG), 코드 없는 오류(파일 읽기·쓰기 실패 등)는 서버 오류 500
  }
}

export async function DELETE(req, { params }) {
  try {
    const csrf = csrfDenied(req); if (csrf) return csrf; // PUT과 같은 이유 — 악성 페이지가 하트비트를 끄지 못하게
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    await removeAssistantSettings(ws);
    return Response.json(await assistantSettingsView(ws));
  } catch (e) {
    return apiErrorFrom(e, await requestLang(), 500);
  }
}
