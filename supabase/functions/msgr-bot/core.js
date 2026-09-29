// 아르고 메신저 봇 API — 정본(순수 JS). index.ts(Deno 엣지 펑션)와 test/msgr-bot-facade.test.mjs가 같이 쓴다.
// 텔레그램 Bot API 규율을 차용한다: 주소 /bot<token>/<method>, 봉투 {ok, result} | {ok:false, error_code, description},
// getUpdates 롱폴 + offset(= 마지막 update_id + 1 = ack). 정책·권한 판정은 전부 DB RPC(msgr_bot_*)에 있고 이 층은 번역만 한다.
// ponytail: 레이트 리밋 없음 — 토큰당 RPC 1초 폴이 상한. 남용이 보이면 엣지에서 토큰별 카운터.
export const METHODS = ['getMe', 'getUpdates', 'sendMessage', 'sendChatAction', 'getFile',
  // 외부 에이전트 크루 계약 1-a(20260929130000) — 자동화(크루 루틴) 미러·편집, 위험 명령 결재 카드. 판정은 전부 msgr_bot_* RPC.
  'setRoutines', 'routineEditDone', 'requestApproval', 'ackApproval', 'expireApproval'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_URL_TTL_S = 600; // getFile 서명 URL 수명 — 봇은 즉시 내려받는다
const MAX_WAIT_MS = 25_000; // 텔레그램은 ~50초, 엣지 펑션 벽시계 안에서 여유 있게
const POLL_MS = 1_000;

// PostgREST 오류 메시지(P0001 raise 이름) → HTTP 상태
const ERR = {
  msgr_bad_delivery_role: [400, 'Bad Request: recipient role must be to or cc'],
  msgr_runtime_update_required: [409, 'Conflict: update the recipient agent to use DM delegation'],
  msgr_execution_forbidden: [403, 'Forbidden: request access is no longer available'],
  msgr_execution_source_forbidden: [403, 'Forbidden: request access is no longer available'],
  msgr_forbidden: [403, 'Forbidden: request access is not available'],
  msgr_crew_not_in_channel: [403, 'Forbidden: channel or request access is required'],
  msgr_execution_not_owner: [409, 'Conflict: response has no matching execution claim'],
  msgr_bot_bad_disposition: [400, 'Bad Request: disposition must be handoff or done'],
  msgr_bot_bad_body: [400, 'Bad Request: body must contain 1 to 20000 characters'],
  msgr_bot_handoff_limit: [409, 'Conflict: conversation handoff limit reached'],
  msgr_bot_unauthorized: [401, 'Unauthorized: bad or revoked bot token'],
  msgr_org_unentitled: [403, 'Forbidden: this organization free period has ended, crew work is paused'], // 2026-09-27 M3 — DB 트리거(msgr_message_entitlement_gate)가 막을 때 500이 아니라 의미 있는 응답
  msgr_not_allowed: [403, 'Forbidden: crew allow policy or channel policy rejects this author'],
  msgr_bot_not_member: [403, 'Forbidden: add the bot to this channel first'],
  msgr_bot_no_channel: [400, 'Bad Request: chat not found in this org'],
  msgr_bot_no_file: [400, 'Bad Request: file not found in this org'],
  msgr_bot_bad_reply: [400, 'Bad Request: reply target not in chat'],
  msgr_reply_cross_channel: [400, 'Bad Request: reply target not in chat'],
  msgr_routine_forbidden: [403, 'Forbidden: this crew cannot sync or close these routines'],
  msgr_routine_invalid_rows: [400, 'Bad Request: rows must be an array of routines'],
  msgr_routine_too_many: [400, 'Bad Request: at most 200 routines per snapshot'],
  msgr_approval_invalid: [400, 'Bad Request: approval_id (1-80 of A-Z a-z 0-9 . _ : -) and command are required'],
  msgr_approval_conflict: [409, 'Conflict: this approval_id already exists with a different command or source'],
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
export async function handle({ token, method, params = {} }, rpc, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxWaitMs = MAX_WAIT_MS, pollMs = POLL_MS, sign = null } = {}) {
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
      // 이벤트(루틴 편집·결재 결정)는 옵트인(events=1)한 어댑터에게만, 요청당 한 번 조회한다. update_id·offset과 무관하고
      // 서버가 60초 임대로 중복을 막는다. 이벤트 조회는 선택 기능 — 어떤 오류든(옛 서버의 RPC 없음, 시간 초과, 교착) 메시지 수신을
      // 막지 않게 빈 목록으로 넘긴다(검수 M-5). 서버가 닫힐 때까지 다시 보내므로 유실은 없다. 토큰 오류는 아래 메시지 조회가 401로 알린다.
      const evs = Number(params.events) === 1 ? await rpc('msgr_bot_events', { token }).catch((e) => {
        console.warn('[msgr-bot] events skipped:', String(e?.code ?? ''), String(e?.message ?? '').slice(0, 200));
        return [];
      }) : [];
      for (;;) {
        const ups = await rpc(Number(params.delivery_protocol) === 1 ? 'msgr_bot_updates_with_delivery' : 'msgr_bot_updates', { token, after_id: Math.max(0, offset - 1), lim });
        if (ups.length || evs?.length || now() >= deadline) return reply(200, [...(evs ?? []), ...ups]);
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
      }
    }
    if (method === 'getFile') { // 텔레그램 모양: file_id → file_path(단수명 서명 URL). 봇이 그 채널에 있을 때만(RPC msgr_bot_file이 판정) — 첨부가 봇에 안 가던 결함(2026-09-11 밤)
      const fid = String(params.file_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(fid)) return fail(400, 'Bad Request: file_id must be an attachment id');
      const f = await rpc('msgr_bot_file', { token, attachment: fid });
      const url = sign ? await sign(f.storage_path, FILE_URL_TTL_S) : null;
      if (!url) return fail(500, 'Internal: file signing unavailable');
      return reply(200, { file_id: f.file_id, file_name: f.file_name, mime_type: f.mime_type, file_size: f.file_size, file_path: url });
    }
    if (method === 'setRoutines') { // 예약 작업 스냅샷 전체. unsupported면 행은 두고 사유만(읽기 실패로 미러를 지우지 않게)
      const unsupported = params.unsupported == null ? null : String(params.unsupported);
      if (!Array.isArray(params.rows) && !unsupported) return fail(400, 'Bad Request: rows must be an array');
      return reply(200, await rpc('msgr_bot_routines_sync', { token, p_rows: Array.isArray(params.rows) ? params.rows : [], p_unsupported: unsupported }));
    }
    if (method === 'routineEditDone') {
      const status = String(params.status ?? '');
      if (!UUID_RE.test(String(params.edit_id ?? '')) || !['applied', 'failed', 'superseded'].includes(status)) return fail(400, 'Bad Request: edit_id (uuid) and status (applied|failed|superseded) are required');
      return reply(200, await rpc('msgr_bot_routine_edit_done', { token, p_id: params.edit_id, p_status: status, p_error: params.error == null ? null : String(params.error) }));
    }
    if (method === 'requestApproval') { // 위험 명령 결재 카드. 원문은 실행 시도(execution_attempt)로 서버가 정하고, 등급은 서버가 고위험으로 정한다
      if (!UUID_RE.test(String(params.execution_attempt ?? ''))) return fail(400, 'Bad Request: execution_attempt (uuid) is required');
      return reply(200, await rpc('msgr_bot_request_approval', { token, p_attempt: params.execution_attempt, p_approval_id: String(params.approval_id ?? ''),
        p_command: String(params.command ?? ''), p_reason: params.reason == null ? null : String(params.reason) }));
    }
    if (method === 'ackApproval' || method === 'expireApproval') { // ack = 선점(claimed=true인 한 번만 재개), expire = 에이전트 쪽 대기 종료
      const id = String(params.approval_id ?? '');
      if (!id) return fail(400, 'Bad Request: approval_id is required');
      return reply(200, await rpc(method === 'ackApproval' ? 'msgr_bot_ack_approval' : 'msgr_bot_expire_approval', { token, p_approval_id: id }));
    }
    const chat = String(params.chat_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(chat)) return fail(400, 'Bad Request: chat_id must be a channel id');
    if (method === 'sendChatAction') { // 텔레그램 모양(action=typing) — 봇이 답을 만드는 동안 2초마다 부른다 → 서버가 org 토픽으로 typing 방송(2026-09-11 유건 제보: VPS 크루 '답변 중' 표시 없음)
      if (params.action != null && params.action !== 'typing') return fail(400, 'Bad Request: action must be typing');
      const scoped = params.reply_to_message_id != null || params.execution_attempt != null;
      const src = Number(params.reply_to_message_id);
      if (scoped && (!Number.isSafeInteger(src) || src < 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(params.execution_attempt ?? '')))) return fail(400, 'Bad Request: typing requires a valid reply and execution claim');
      await rpc('msgr_bot_typing', { token, channel: chat, ...(scoped ? { src_id: src, attempt: params.execution_attempt } : {}) });
      return reply(200, true);
    }
    // sendMessage
    const text = String(params.text ?? '');
    if (!text.trim()) return fail(400, 'Bad Request: text is empty');
    const src = params.reply_to_message_id != null ? Number(params.reply_to_message_id) : null;
    if (src != null && !Number.isInteger(src)) return fail(400, 'Bad Request: reply_to_message_id must be an integer');
    const attempt = params.execution_attempt;
    if (attempt != null && (!src || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(attempt)))) return fail(400, 'Bad Request: execution_attempt requires a valid reply and UUID');
    const id = attempt == null
      ? await rpc('msgr_bot_send', { token, channel: chat, body: text, src_id: src })
      : await rpc('msgr_bot_finish', { token, channel: chat, body: text, src_id: src, attempt,
        disposition: params.disposition ?? 'done', mentions: params.mentions ?? [] });
    // 2026-09-27 LOW(2차 검수) — 미자격 조직은 msgr_bot_finish가 실행 행을 닫고 null을 돌린다(RPC 자체는 성공).
    // 여기서 그대로 200 {message_id:0}을 주면 거짓 성공이 된다 — null이면 자격 종료로 번역한다.
    if (id == null) return fail(...ERR.msgr_org_unentitled);
    return reply(200, { message_id: Number(id), chat: { id: chat }, text, reply_to_message_id: src ?? undefined });
  } catch (e) {
    const name = String(e?.message ?? '').match(/msgr_[a-z_]+/)?.[0];
    if (name && ERR[name]) return fail(ERR[name][0], ERR[name][1]);
    return fail(500, `Internal: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// VPS 서버 연결(2026-09-23) — 서버 스크립트(connect.py)가 연결 코드로 부르는 경로. 봇 토큰 경로와 따로 둔다(/link/<method>).
// 코드가 자격이고 판정은 msgr_server_link_* RPC가 한다. 토큰 원문은 오지 않는다(해시만).
export const LINK_METHODS = ['report', 'status', 'done'];
const LINK_ERR = {
  msgr_link_invalid: [404, 'Not Found: connection code is invalid or expired — create a new command in the app'],
  msgr_link_used: [409, 'Conflict: this connection code was already used — create a new command in the app'],
  msgr_link_bad_agents: [400, 'Bad Request: agent list is malformed'],
};
export function parseLinkPath(url) {
  const m = new URL(url).pathname.match(/\/link\/([a-z]+)\/?$/);
  return m ? m[1] : null;
}
export async function handleLink(method, params = {}, rpc) {
  if (!LINK_METHODS.includes(method)) return fail(404, `Not Found: link/${method}`);
  const code = String(params.code ?? '');
  if (!/^argo_link_[0-9a-f]{48}$/.test(code)) return fail(400, 'Bad Request: code is missing or malformed');
  try {
    if (method === 'report') { await rpc('msgr_server_link_report', { code, host: String(params.host ?? ''), agents: Array.isArray(params.agents) ? params.agents : null }); return reply(200, true); }
    if (method === 'status') return reply(200, await rpc('msgr_server_link_status', { code }));
    await rpc('msgr_server_link_done', { code, results: Array.isArray(params.results) ? params.results : null });
    return reply(200, true);
  } catch (e) {
    const name = String(e?.message ?? '').match(/msgr_[a-z_]+/)?.[0];
    if (name && LINK_ERR[name]) return fail(LINK_ERR[name][0], LINK_ERR[name][1]);
    return fail(500, `Internal: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}
// /connect 원문 — 스크립트의 BASE 기본값에 이 함수의 공개 주소를 넣는다. 정본은 앱이 명령 두 번째 인자로 넣는 주소이고,
// 이 값은 인자가 빠졌을 때의 대체다(런타임 SUPABASE_URL이 https 공개 주소가 아니면 넣지 않는다 — 로컬 개발의 내부 주소 등).
export function connectScript(py, base) {
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/functions\/v1\/msgr-bot$/.test(base) ? py.replace('"__ARGO_MSGR_URL__"', JSON.stringify(base)) : py;
}
