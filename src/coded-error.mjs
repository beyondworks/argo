// 코드 달린 오류 — 엔진(src/*.mjs)이 던지는 사용자향 오류에 화면 문구 코드(errorCode)를 붙인다(F11, 2026-10-05).
// message는 종전 한국어 문장 그대로(로그·기존 소비자·테스트 회귀 0), 라우트는 errorCode로 표시 언어 문구를 고른다
// (app/apimsg.mjs apiErrorFrom). 코드 사전은 app/apimsg.mjs API_MSG가 정본 — 새 코드는 거기에 ko/en 함께 등록한다.
// e.code는 쓰지 않는다 — 이미 NOT_FOUND·BAD_SLUG·SQLSTATE 등 다른 계약이 쓰고 있다.
export function codedError(errorCode, message) {
  return Object.assign(new Error(message), { errorCode });
}
