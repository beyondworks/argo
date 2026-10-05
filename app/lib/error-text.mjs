// 실패 이유 문구 — 화면이 "…하지 못했습니다 — {이유}"를 그릴 때 쓰는 공용 함수(UL5, 2026-10-05).
// 문제: 응답 본문이 없으면 이유가 비어 "— "로 끝나고, 네트워크 실패(fetch가 던지는 TypeError)는 브라우저 원문("Load failed")이 한국어 화면에 그대로 나왔다.
import { errorTextFor } from '../apimsg.mjs';
import { AUTH_MSG } from '../authmsg.mjs';

const NETWORK_RE = /^(load failed|failed to fetch|fetch failed|networkerror|network request failed)/i;

/** 실패한 fetch 응답 → 오류. api()(app/ui.jsx)와 같은 규칙 — 본문 errorCode는 화면 언어 문구, 없으면 error 원문, 그것도 없으면 상태 문구. DELETE 같은 api()가 못 보내는 메서드용. */
export function responseError(res, data, lang) {
  const err = new Error(errorTextFor(data, res?.status, lang, AUTH_MSG));
  err.data = data ?? {}; err.status = res?.status;
  return err;
}

/** 화면에 보일 실패 이유 — 브라우저 네트워크 실패 원문은 사전 문구(common.reason.network)로, 빈 이유는 다음 행동(common.reason.unknown)으로.
    api()·responseError가 만든 오류(이미 화면 언어 문구)와 코드가 쓴 문장은 그대로 둔다. t = useLang()의 t. */
export function failureReason(err, t) {
  const msg = String(err?.message ?? '').trim();
  if (!msg) return t('common.reason.unknown');
  if (err instanceof TypeError && NETWORK_RE.test(msg)) return t('common.reason.network');
  return msg;
}
