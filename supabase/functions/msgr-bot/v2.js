// 메신저 v2 봇 API(2026-10-23 VPS 서버 연결 이식) — 순수 JS. index.ts(Deno)와 test/msgr-bot-v2.test.mjs가 같이 쓴다.
// 라우팅: 토큰이 argo_bot_v2로 시작하면 이 파일의 처리기(v2 표 — 20261023190000_msgr2_server_links.sql RPC), 그 밖의 봇 토큰은 일시 중단 응답(paused.js, DB 0).
//   옛 v1 연결 도구(argo_bot_ + 48 hex)가 다시 폴링을 시작하지 않게 하려는 것이다(paused.js 머리말의 실측). /connect·/link/*는 VPS 연결 스크립트 경로.
// Hermes가 대화에 쓰는 것만 받는다: getMe · getUpdates(롱폴) · sendMessage(최종 답·보충 글) · sendChatAction(받기만).
//   reportStatus·setRoutines는 200 {}(저장 안 함 — 성공할 때까지 매분 다시 부르는 미러 루프를 멈춘다, paused.js와 같은 이유).
//   결재 카드·첨부·예약 작업 편집(requestApproval·getFile·createUpload·attachFile·routineEditDone·ack/expireApproval)은 1단계 밖 — 400.
// 롱폴 박자는 v1과 같다(core.js POLL_STEPS: 대기 시작 1회 + 5초 간격, 최대 50초). 쉬는 봇 1개 = 엣지 호출 분당 1.2 · RPC 분당 12(읽기만).
import { pausedReply } from './paused.js';
import { displayText } from './core.js';

export const V2_TOKEN_RE = /^argo_bot_v2[0-9a-f]{48}$/;
export const isV2Token = (t) => V2_TOKEN_RE.test(String(t ?? ''));
export const V2_MAX_WAIT_MS = 50_000;
export const V2_POLL_MS = 5_000;
export const V2_IGNORED = ['reportStatus', 'setRoutines'];
export const V2_METHODS = ['getMe', 'getUpdates', 'sendMessage', 'sendChatAction', ...V2_IGNORED];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_RETRY_S = 300;
const AUTH_RETRY_S = 900;

/** 요청 갈래 — 'connect'(스크립트) | 'link'(스크립트 보고) | 'v2'(v2 토큰 봇) | 'paused'(그 밖 — DB 0). token은 core.js parseRequest와 같은 규칙. */
export function routeOf({ method = 'GET', path = '/', token = null } = {}) {
  if (method === 'GET' && /\/connect\/?$/.test(path)) return 'connect';
  if (/\/link\/[a-z]+\/?$/.test(path)) return 'link';
  if (isV2Token(token)) return 'v2';
  return 'paused';
}

/** /link/* 처리기(core.js handleLink)가 부르는 v1 RPC 이름을 v2 이름으로 바꿔 끼운다 — 판정은 msgr2_server_link_* RPC. */
export const linkRpcV2 = (rpc) => (fn, args) => rpc(String(fn).replace(/^msgr_server_link_/, 'msgr2_server_link_'), args);

const reply = (status, result) => ({ status, body: { ok: true, result } });
const fail = (status, description, retryAfterS = null) => ({ status, body: { ok: false, error_code: status, description, ...(retryAfterS ? { parameters: { retry_after: retryAfterS } } : {}) } });
const ERR = {
  msgr_bot_unauthorized: () => fail(401, 'Unauthorized: bad or revoked bot token', AUTH_RETRY_S),
  msgr_bot_plan_required: () => fail(403, 'Forbidden: external agent connections need Argo Pro for the agent owner — upgrade in Argo Messenger', PLAN_RETRY_S),
  msgr_execution_not_owner: () => fail(409, 'Conflict: response has no matching execution claim'),
  msgr_execution_forbidden: () => fail(403, 'Forbidden: request access is no longer available'), // 주인이 그 방에서 빠졌다(#1154 검수 I-1)
  msgr_bot_bad_body: () => fail(400, 'Bad Request: body must contain 1 to 20000 characters'),
  msgr_bot_not_member: () => fail(403, 'Forbidden: this bot has no recent request in this chat'),
  service_paused: () => fail(503, 'Service Unavailable: Argo Messenger is paused', 60),
};

/**
 * v2 봇 요청 하나. parsed = core.js parseRequest 결과({ token, method, params }), rpc(fn, args) → JSON(오류는 message에 RPC 예외 이름).
 * opts: sleep·now(시험), maxWaitMs, rejects(core.js createRejectMemory — 무효 토큰을 이 인스턴스에서 DB 없이 거절).
 */
export async function handleV2({ token, method, params = {} }, rpc, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxWaitMs = V2_MAX_WAIT_MS, rejects = null } = {}) {
  if (!isV2Token(token)) return ERR.msgr_bot_unauthorized();
  if (!V2_METHODS.includes(method)) return fail(400, `Bad Request: ${method || '(none)'} is not supported in this version — supported: ${V2_METHODS.join(', ')}`);
  if (V2_IGNORED.includes(method)) return reply(200, {});
  try {
    if (method === 'getMe') {
      const me = await rpc('msgr2_bot_me', { p_token: token });
      rejects?.clear(token);
      return reply(200, { id: me.bot_id, is_bot: true, first_name: me.name, kind: me.kind, crew_id: me.agent_id, status: me.status, org: { id: null, name: '', slug: '' } });
    }
    if (method === 'getUpdates') {
      const start = now();
      const deadline = start + Math.min(maxWaitMs, Math.max(0, Number(params.timeout) || 0) * 1000);
      const known = rejects?.blocked(token);
      if (known) { await sleep(Math.max(0, deadline - now())); return known === 'plan' ? ERR.msgr_bot_plan_required() : ERR.msgr_bot_unauthorized(); }
      const args = { p_token: token, p_after: Math.max(0, (Number(params.offset) || 0) - 1), p_lim: Math.min(10, Math.max(1, Number(params.limit) || 1)) };
      for (;;) {
        const ups = await rpc('msgr2_bot_updates', args);
        if ((Array.isArray(ups) && ups.length) || now() >= deadline) { rejects?.clear(token); return reply(200, Array.isArray(ups) ? ups : []); }
        await sleep(Math.min(V2_POLL_MS, Math.max(1, deadline - now())));
      }
    }
    if (method === 'sendChatAction') return reply(200, true); // v2에는 봇 '답변 중' 방송이 없다 — 일이 accepted라 화면은 일하는 중으로 본다. 쓰기 0
    // sendMessage
    const text = displayText(String(params.text ?? '')); // 넘김 표지(MSGR: done|handoff)는 사람에게 보이지 않게 뗀다(v1과 같은 규칙). 1단계는 넘김 없음
    const attempt = params.execution_attempt;
    if (attempt != null) {
      if (!UUID_RE.test(String(attempt))) return fail(400, 'Bad Request: execution_attempt must be a UUID');
      const id = await rpc('msgr2_bot_finish', { p_token: token, p_attempt: String(attempt), p_text: text });
      return reply(200, { message_id: Number(id), chat: { id: params.chat_id }, text });
    }
    const chat = String(params.chat_id ?? '');
    if (!UUID_RE.test(chat)) return fail(400, 'Bad Request: chat_id must be a chat id from getUpdates');
    const id = await rpc('msgr2_bot_send', { p_token: token, p_room: chat, p_text: text });
    return reply(200, { message_id: Number(id), chat: { id: chat }, text });
  } catch (e) {
    // DB 쪽이 되돌려져 함수가 없으면(PGRST202) 영구 거부로 — 500이면 Hermes가 일시 오류로 보고 끝없이 다시 온다
    const name = (e?.code === 'PGRST202' || /Could not find the function public\.msgr2_bot_/i.test(String(e?.message ?? ''))) ? 'msgr_bot_unauthorized'
      : String(e?.message ?? '').match(/\b(msgr_[a-z_]+|service_paused)\b/)?.[1];
    if (name === 'msgr_bot_unauthorized' && method === 'getUpdates') rejects?.reject(token, 'auth');
    if (name === 'msgr_bot_plan_required' && method === 'getUpdates') rejects?.reject(token, 'plan');
    if (name && ERR[name]) return ERR[name]();
    return fail(500, `Internal: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

export { pausedReply };
