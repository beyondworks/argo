// 실패 이유 문구 — 화면이 "…하지 못했습니다 — {이유}"를 그릴 때 쓰는 공용 함수(UL5, 2026-10-05).
// 문제: 응답 본문이 없으면 이유가 비어 "— "로 끝나고, 네트워크 실패(fetch가 던지는 TypeError)는 브라우저 원문("Load failed")이 한국어 화면에 그대로 나왔다.
import { errorTextFor, API_MSG } from '../apimsg.mjs';
import { AUTH_MSG } from '../authmsg.mjs';

const NETWORK_RE = /^(load failed|failed to fetch|fetch failed|networkerror|network request failed)/i;

/** 실패한 fetch 응답 → 오류. api()(app/ui.jsx)와 같은 규칙 — 본문 errorCode는 화면 언어 문구, 없으면 error 원문, 그것도 없으면 상태 문구. DELETE 같은 api()가 못 보내는 메서드용. */
export function responseError(res, data, lang) {
  const err = new Error(errorTextFor(data, res?.status, lang, AUTH_MSG));
  err.data = data ?? {}; err.status = res?.status;
  return err;
}

/** 사전 문구로 바뀐 오류인가 — errorCode가 화면 사전(API_MSG·가드 AUTH_MSG)에 있으면 message는 이미 화면 언어 사전 문구다(api()·responseError가 errorTextFor로 만든다). */
export function isDictionaryError(err) {
  const code = err?.data?.errorCode ?? err?.errorCode;
  return typeof code === 'string' && (code in API_MSG || code in AUTH_MSG);
}
/** 오류 코드 — api()·responseError가 실은 data.errorCode(없으면 null). */
export const errorCodeOf = (err) => err?.data?.errorCode ?? err?.errorCode ?? null;

/** 화면에 보일 실패 이유(2차 검수 M3, 2026-10-05) — 서버·시스템 원문은 화면에 내지 않는다:
    ① 사전 문구로 바뀐 오류(errorCode가 사전에 있음)만 그 문구 그대로 ② 브라우저 네트워크 실패 원문(Load failed 등)은 common.reason.network
    ③ 나머지는 상태별 일반 문구 — 401·403 권한/로그인, 404 못 찾음, 413 너무 큼, 5xx 서버, 그 밖·상태 없음은 다음 행동(common.reason.unknown).
    종전에는 ②가 아니면 서버 error 원문을 그대로 보여 절대 경로(ENOENT …)·"Failed to parse body as FormData."가 화면에 나왔다. t = useLang()의 t. */
export function failureReason(err, t) {
  const msg = String(err?.message ?? '').trim();
  if (err instanceof TypeError && NETWORK_RE.test(msg)) return t('common.reason.network');
  if (msg && isDictionaryError(err)) return msg;
  const status = Number(err?.status ?? err?.data?.status) || 0;
  if (status === 401 || status === 403) return t('common.reason.forbidden');
  if (status === 404) return t('common.reason.notFound');
  if (status === 413) return t('common.reason.tooLarge');
  if (status >= 500) return t('common.reason.server');
  return t('common.reason.unknown');
}
