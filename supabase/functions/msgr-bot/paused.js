// msgr-bot 일시 중단 응답(2026-10-16 메신저 일시 중단 — 엣지 함수를 지우자 옛 연결 도구가 404를 일시 오류로 보고 더 자주 불렀다).
// DB·외부 호출이 전혀 없다. 연결 도구가 가장 오래 쉬거나 멈추는 응답만 돌려준다(근거: integrations/* 의 응답 처리, test/msgr-bot-paused.test.mjs).
//   · Hermes(Python-urllib) — 모든 버전이 401(본문 error_code 401)에서 받기를 영구히 멈춘다(getMe 401은 재시도하지 않는 오류).
//   · OpenClaw(node) — 401이면 받기 루프가 끝나고 startAccount가 던져 게이트웨이가 계정을 다시 시작한다(반복). 그래서 getMe는 200(멈춤 표지 봇)으로
//     받기 루프에 들여보내고, 나머지는 429 + retry_after 3600 — 0.3.4 이상은 1시간을 쉰다(옛 0.3.3 이하는 30초 사다리).
//     단 미러 루프(0.3.0 이상, channel.ts 60초마다)의 reportStatus·setRoutines는 성공해야 '보냈음'을 기억한다(contract.js statusSent·sentDigest) —
//     429면 매분 다시 불러 계정당 시간당 약 120번이 남는다. 그래서 이 둘은 DB 없이 200 {}(바뀔 때·1시간마다만 다시 부른다. res.total이 없으면 행 수로 비교).
//   · 그 밖(python-httpx 등 텔레그램 규약 클라이언트) — 401 + retry_after 3600(텔레그램 규약: retry_after가 있으면 그만큼 쉰다).
// 본문 사유에 "Argo Messenger is paused"를 싣는다. 응답은 텔레그램 형식 {ok:false, error_code, description, parameters:{retry_after}} + Retry-After 헤더.
export const PAUSED_RETRY_S = 3600;
export const PAUSED_REASON = 'Argo Messenger is paused for maintenance — the bot API is off until the messenger reopens';

const MIRROR_ACK = new Set(['reportStatus', 'setRoutines']); // OpenClaw 미러 루프가 성공할 때까지 매분 다시 부르는 보고(routineEditDone·events 등은 429 그대로)
const json = (status, body, extra = {}) => ({ status, headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
const refuse = (status, label) => json(status, { ok: false, error_code: status, description: `${label}: ${PAUSED_REASON}`, parameters: { retry_after: PAUSED_RETRY_S } },
  { 'Retry-After': String(PAUSED_RETRY_S) });

/** @param {{ method?: string, path?: string, userAgent?: string }} req — method = HTTP 메서드, path = URL 경로 */
export function pausedReply({ method = 'GET', path = '/', userAgent = '' } = {}) {
  if (/\/connect\/?$/.test(path) || /\/link\//.test(path)) return { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: `${PAUSED_REASON}\n` }; // VPS 서버 연결 스크립트·보고
  const botMethod = (path.split('/').filter(Boolean).pop() ?? '').replace(/[^A-Za-z]/g, '');
  if (/^node\b/i.test(userAgent)) { // OpenClaw 연결 도구(Node fetch 기본 UA)
    if (botMethod === 'getMe') return json(200, { ok: true, result: { id: 0, is_bot: true, first_name: 'Argo Messenger (paused)', kind: 'paused', status: 'paused', org: { id: null, name: 'Argo Messenger (paused)', slug: 'paused' } } });
    if (MIRROR_ACK.has(botMethod)) return json(200, { ok: true, result: {} }); // 받았다고만 답한다(저장하지 않는다) — 미러 루프가 매분 다시 부르지 않게
    return refuse(429, 'Too Many Requests');
  }
  return refuse(401, 'Unauthorized');
}
