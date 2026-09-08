// 아르고 메신저 봇 API — 정본(순수 JS). index.ts(Deno 엣지 펑션)와 test/msgr-bot-facade.test.mjs가 같이 쓴다.
// 텔레그램 Bot API 규율을 차용한다: 주소 /bot<token>/<method>, 봉투 {ok, result} | {ok:false, error_code, description},
// getUpdates 롱폴 + offset(= 마지막 update_id + 1 = ack). 정책·권한 판정은 전부 DB RPC(msgr_bot_*)에 있고 이 층은 번역만 한다.
// ponytail: 레이트 리밋 없음 — 토큰당 RPC 1초 폴이 상한. 남용이 보이면 엣지에서 토큰별 카운터.
export const METHODS = ['getMe', 'getUpdates', 'sendMessage'];
const MAX_WAIT_MS = 25_000; // 텔레그램은 ~50초, 엣지 펑션 벽시계 안에서 여유 있게
const POLL_MS = 1_000;

// PostgREST 오류 메시지(P0001 raise 이름) → HTTP 상태
const ERR = {
  msgr_bot_unauthorized: [401, 'Unauthorized: bad or revoked bot token'],
  msgr_not_allowed: [403, 'Forbidden: crew allow policy or channel policy rejects this author'],
  msgr_bot_not_member: [403, 'Forbidden: add the bot to this channel first'],
  msgr_bot_no_channel: [400, 'Bad Request: chat not found in this org'],
  msgr_bot_bad_reply: [400, 'Bad Request: reply target not in chat'],
  msgr_reply_cross_channel: [400, 'Bad Request: reply target not in chat'],
};

export function parseRequest(url, headers = {}, body = null) {
  const u = new URL(url);
  const m = u.pathname.match(/\/bot([A-Za-z0-9_]+)\/([A-Za-z]+)\/?$/);
  const auth = String(headers.authorization ?? headers.Authorization ?? '').match(/^Bearer\s+(\S+)$/i);
  const token = m?.[1] ?? auth?.[1] ?? null;
  const method = m?.[2] ?? u.pathname.split('/').filter(Boolean).pop() ?? '';
  const params = { ...Object.fromEntries(u.searchParams), ...(body && typeof body === 'object' ? body : {}) };
  return { token, method, params };
}

const reply = (status, result) => ({ status, body: { ok: true, result } });
const fail = (status, description) => ({ status, body: { ok: false, error_code: status, description } });

// rpc(fn, args) → JSON. PostgREST 오류는 {message, code, details}를 throw.
export async function handle({ token, method, params = {} }, rpc, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxWaitMs = MAX_WAIT_MS, pollMs = POLL_MS } = {}) {
  if (!token) return fail(401, 'Unauthorized: token missing (use /bot<token>/<method> or Authorization: Bearer)');
  if (!METHODS.includes(method)) return fail(404, `Not Found: method ${method || '(none)'} — supported: ${METHODS.join(', ')}`);
  try {
    if (method === 'getMe') {
      const me = await rpc('msgr_bot_me', { token });
      return reply(200, { id: me.bot_id, is_bot: true, first_name: me.name, kind: me.kind, crew_id: me.crew_id, org: { id: me.org_id, name: me.org_name, slug: me.org_slug }, status: me.status });
    }
    if (method === 'getUpdates') {
      const offset = Math.max(0, Number(params.offset) || 0);
      const lim = Math.min(100, Math.max(1, Number(params.limit) || 50));
      const waitMs = Math.min(maxWaitMs, Math.max(0, Number(params.timeout) || 0) * 1000);
      const deadline = now() + waitMs;
      for (;;) {
        const ups = await rpc('msgr_bot_updates', { token, after_id: Math.max(0, offset - 1), lim });
        if (ups.length || now() >= deadline) return reply(200, ups);
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
      }
    }
    // sendMessage
    const chat = String(params.chat_id ?? '');
    const text = String(params.text ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(chat)) return fail(400, 'Bad Request: chat_id must be a channel id');
    if (!text.trim()) return fail(400, 'Bad Request: text is empty');
    const src = params.reply_to_message_id != null ? Number(params.reply_to_message_id) : null;
    if (src != null && !Number.isInteger(src)) return fail(400, 'Bad Request: reply_to_message_id must be an integer');
    const id = await rpc('msgr_bot_send', { token, channel: chat, body: text, src_id: src });
    return reply(200, { message_id: Number(id), chat: { id: chat }, text, reply_to_message_id: src ?? undefined });
  } catch (e) {
    const name = String(e?.message ?? '').match(/msgr_[a-z_]+/)?.[0];
    if (name && ERR[name]) return fail(ERR[name][0], ERR[name][1]);
    return fail(500, `Internal: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}
