// 능동 비서 설정(설계 13절) — GET 설정·지금 비서·상태, PUT 설정. 화면은 에이전트 카드 "비서" 탭(app/c/[ws]/crew/[slug]/assistant-section.jsx).
// 읽기·쓰기 모두 로컬 파일이다(Supabase 호출 0). 저장은 assistant.json과 company.json 봉인을 같이 쓴다 — 쓰기 규칙은 src/assistant/settings.mjs.
import { assistantSettingsView, saveAssistantSettings } from '../../../../../src/assistant/settings.mjs';
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
    return apiErrorFrom(e, await requestLang(), 400); // 코드 달린 검증 오류는 화면 언어 문구(apimsg.mjs API_MSG)
  }
}
