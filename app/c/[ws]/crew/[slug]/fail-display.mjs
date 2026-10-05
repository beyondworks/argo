// 실패 줄 표시 보조 — JSX 없는 순수 함수(UX-A02, 2026-10-05).
// '러너 없음' 실패는 엔진(src/chat.mjs 1446-1452)이 실패 코드 없이 회사 언어 문장으로 던진다. 화면은 failedCode가 없으면 원문을
// 한 줄 말줄임으로 그려 "설정 → AI 연결에서 Claude·Codex·…"까지만 보였고, 영어 화면에도 한국어가 나왔다. 엔진 파일은 다른 담당이라
// 화면 쪽에서 그 문장을 알아보고 사전 문구(화면 언어)와 설정 링크로 바꾼다. 문장 머리는 test/crew-fail-display.test.mjs가 엔진 원문과 대조한다.
const NO_RUNNER = [
  /^AI 러너가 하나도 연결돼 있지 않습니다/, /^No AI runner is connected/,
  /^연결된 러너는 더 이상 제공되지 않습니다/, /^The connected runner is no longer offered/,
];
/** 러너가 하나도 연결되지 않은(또는 연결한 러너가 더 이상 제공되지 않는) 실패인가 */
export function isNoRunnerFailure(text) {
  const s = String(text ?? '');
  return NO_RUNNER.some((re) => re.test(s));
}
