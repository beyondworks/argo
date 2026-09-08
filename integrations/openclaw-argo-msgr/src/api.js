// 아르고 메신저 봇 API 클라이언트(순수 JS — 플러그인과 node 단위 테스트가 같이 쓴다). 텔레그램 규율: /bot<token>/<method>, {ok,result}, offset=ack.
export class ArgoMsgrError extends Error {
  constructor(status, description) { super(`${status}: ${description}`); this.status = status; this.description = description; }
}
export const MAX_LEN = 20000;                 // 서버 본문 상한(msgr_messages.body)
export const POLL_TIMEOUT_S = 20;             // 서버 상한 25초

export function makeApi({ url, token, fetchImpl = globalThis.fetch }) {
  const base = String(url ?? '').replace(/\/+$/, '');
  const call = async (method, params, { post = false, timeoutMs = 30_000 } = {}) => {
    let target = `${base}/bot${token}/${method}`;
    const init = { method: post ? 'POST' : 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) };
    if (post) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(params ?? {}); }
    else if (params) { const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])); target += `?${q}`; }
    const r = await fetchImpl(target, init);
    const body = await r.json().catch(() => ({ ok: false, error_code: r.status, description: `bad json (${r.status})` }));
    if (!body?.ok) throw new ArgoMsgrError(Number(body?.error_code ?? r.status ?? 500), String(body?.description ?? 'unknown'));
    return body.result;
  };
  return {
    getMe: () => call('getMe'),
    getUpdates: (offset, limit = 50) => call('getUpdates', { offset, limit, timeout: POLL_TIMEOUT_S }, { timeoutMs: (POLL_TIMEOUT_S + 15) * 1000 }),
    sendMessage: (chatId, text, replyTo) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, MAX_LEN), ...(replyTo != null ? { reply_to_message_id: replyTo } : {}) }, { post: true }),
  };
}

// 롱폴 루프. onMessage(message, update_id)를 순서대로 await하고 offset(=ack)을 전진한다. 401이면 멈춘다(토큰 회전·폐기).
export async function pollLoop(api, { onMessage, log = () => {}, signal, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let offset = 0, backoff = 1000;
  while (!signal?.aborted) {
    try {
      const ups = (await api.getUpdates(offset)) ?? [];
      backoff = 1000;
      for (const up of ups) {
        offset = Math.max(offset, Number(up.update_id ?? 0) + 1);
        try { await onMessage(up.message ?? {}, up.update_id); } catch (e) { log(`argo-msgr: dispatch failed for update ${up.update_id}: ${String(e)}`); }
      }
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof ArgoMsgrError && e.status === 401) { log(`argo-msgr: token rejected (${e.description}) — rotate the token in Argo Messenger settings`); return; }
      log(`argo-msgr: poll error ${String(e?.message ?? e)} — retry in ${backoff / 1000}s`);
      await sleep(backoff); backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
