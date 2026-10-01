// 브라우저·WebView가 연결이 없을 때 던지는 영어 원문(fetch가 TypeError로 거절). 사람에게는 원문 대신 쉬운 문구를 보이고 원문은 진단 기록에만 남긴다.
// 로그인 오류(auth-errors.mjs)와 전송 실패 카드(composer-delivery.mjs)가 같은 판정을 쓴다.
export const NETWORK_FAILURE = /failed to fetch|networkerror|network request failed|load failed/i;
export const isNetworkFailure = (msg) => NETWORK_FAILURE.test(String(msg ?? ''));
