// 아르고 메신저 봇 API — 정본(순수 JS). index.ts(Deno 엣지 펑션)와 test/msgr-bot-facade.test.mjs가 같이 쓴다.
// 텔레그램 Bot API 규율을 차용한다: 주소 /bot<token>/<method>, 봉투 {ok, result} | {ok:false, error_code, description},
// getUpdates 롱폴 + offset(= 마지막 update_id + 1 = ack). 정책·권한 판정은 전부 DB RPC(msgr_bot_*)에 있고 이 층은 번역만 한다.
// ponytail: 레이트 리밋 없음 — 토큰당 롱폴 RPC는 대기 시작에 1회, 그 뒤 5초 간격(POLL_STEPS)이 상한. 남용이 보이면 엣지에서 토큰별 카운터.
export const METHODS = ['getMe', 'getUpdates', 'sendMessage', 'sendChatAction', 'getFile',
  // 외부 에이전트 크루 계약 1-a(20260929130000) — 자동화(크루 루틴) 미러·편집, 위험 명령 결재 카드. 판정은 전부 msgr_bot_* RPC.
  'setRoutines', 'routineEditDone', 'requestApproval', 'ackApproval', 'expireApproval',
  // 1-b(20260929150000) — 어댑터 버전·승인 모드 보고(설정은 강제하지 않고 메신저에 보여 준다). 에이전트 결재는 requestApproval kind='agent',
  // 결정 뒤 후속 보고는 sendMessage + approval_id.
  'reportStatus',
  // 20260930160000 — 봇이 파일을 올린다. createUpload(서버가 경로 판정 → 서명 업로드 주소) → 봇이 저장소에 직접 PUT → attachFile(등록).
  'createUpload', 'attachFile'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_URL_TTL_S = 600; // getFile 서명 URL 수명 — 봇은 즉시 내려받는다
// 롱폴 대기 상한 — 텔레그램과 같은 50초(2026-10-14: 엣지 호출 월 약 200만 = 한도, 대부분이 연결 도구의 20초 빈 롱폴).
// 엣지 한도 안이다: 응답 대기 150초·유료 벽시계 400초·CPU 2초(대기는 CPU가 아님 — supabase.com/docs/guides/functions/limits, 2026-10-14 확인).
// 클라이언트가 요청한 timeout만큼만 기다린다 — 옛 연결 도구(timeout=20)는 종전과 같은 20초, 새 도구(Hermes 0.3.8·OpenClaw 0.3.5, timeout=50)는 50초.
// 종전 25초. 대기 중 조회 간격(아래 5초)과 쉬던 봇의 수신 지연(최대 5초)은 바뀌지 않는다.
const MAX_WAIT_MS = 50_000;
// 롱폴 간격 [대기 시작 뒤 경과 ms 미만, 간격 ms] — 대기 시작에 1회(쌓인 글은 바로), 그 뒤 5초 간격.
// 운영 실측(2026-10-09 10분): 1초 고정일 때 msgr_bot_updates_with_delivery가 분당 약 1,713회(대기 중인 봇 수 × 초당 1회) → 1·2·3초 사다리로 20초 빈 대기 11회.
// 2026-10-13 로그 수집 과금(한도 20GB의 28배) — 사다리에서도 이 RPC 하나가 하루 32만 건(롱폴 2시간 2,818회 × 10.5회)이라 5초 간격으로 늘린다:
// 연결 도구(Hermes·OpenClaw)의 timeout 20초 빈 대기 한 번에 RPC 11회 → 5회(0·5·10·15·20초). 쉬던 봇이 글을 받는 지연은 최대 5초(총괄 결정 — 봇 답은 LLM 턴이라 수 초).
const POLL_STEPS = [[Infinity, 5_000]];
const pollDelay = (elapsedMs) => POLL_STEPS.find(([until]) => elapsedMs < until)[1];

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
  // 2026-10-10 에이전트 주인이 Pro가 아니면 외부 봇 수신 중지(판정 msgr_bot_gate). 401 금지 — 연결 도구(Hermes·OpenClaw)가 401만 '영구 중지·토큰 회전'으로 읽는다.
  msgr_bot_plan_required: [403, 'Forbidden: external agent connections need Argo Pro for the agent owner — upgrade in Argo Messenger'],
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
  msgr_approval_invalid: [400, 'Bad Request: approval_id (1-80 of A-Z a-z 0-9 . _ : -) and command (or title) are required'],
  msgr_routine_invalid_channel: [403, 'Forbidden: choose a DM between the owner and this agent, or a channel the agent is in'],
  msgr_bot_bad_attach_target: [403, 'Forbidden: files attach only to this bot\'s own message'],
  msgr_bot_attach_expired: [409, 'Conflict: attach files within 1 hour of posting the message'],
  msgr_bot_bad_file_name: [400, 'Bad Request: file_name must contain 1 to 200 characters'],
  msgr_bot_bad_file_size: [400, 'Bad Request: file_size must be a positive byte count'],
  msgr_bot_file_too_large: [413, 'Payload Too Large: file exceeds the per-file limit for the owner plan (25 MB free, 500 MB Pro)'],
  msgr_file_too_large: [413, 'Payload Too Large: file exceeds the per-file limit for the owner plan (25 MB free, 500 MB Pro)'], // 게이트(_msgr_upload_gate) 이름 — 봇 경로는 prepare가 msgr_bot_file_too_large로 먼저 내므로 여기서는 방어용
  msgr_bot_too_many_files: [409, 'Conflict: at most 10 files per message'],
  msgr_bot_bad_attach_path: [400, 'Bad Request: storage_path must come from createUpload for this message'],
  msgr_bot_upload_missing: [409, 'Conflict: upload the file to upload_url before attachFile'],
  // 20261011150000 — 무료 계정 첨부 저장 한도(에이전트 주인 몫). 413이면 설치된 연결 도구가 '25MB 초과'로 바꿔 안내해서 403 + 원문 사유(#946 M4). 결제 유도 문구 없음(방에 실린다)
  msgr_storage_limit: [403, 'Forbidden: the agent owner\'s attachment storage on the free plan is full; existing files are kept'],
  msgr_approval_conflict: [409, 'Conflict: this approval_id already exists with a different command or source'],
};

// 넘김 표지(MSGR: done|handoff)는 사람에게 보이면 안 된다 — 옛 연결 도구·모델이 남긴 표지를 서버에서 한 번 더 뗀다(판정은 연결 도구가 이미 보냈다).
// src/gateway/msgr-handoff.mjs와 같은 규칙(엣지 함수는 따로 배포돼 가져올 수 없다 — test/msgr-bot-facade가 같은 결과를 확인한다).
// 코드 펜스(``` ~~~)가 열린 채로 끝나는가 — 그 안의 표지는 답변 내용이다.
function openFence(prefix) {
  let fence = null;
  for (const line of prefix.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!mark) continue;
    if (fence) {
      if (mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
    } else if (mark[1][0] !== '`' || !mark[2].includes('`')) fence = mark[1];
  }
  return fence;
}

// 모델이 표지를 마지막 문장 끝에 붙인 경우(…전달하겠습니다. MSGR: done, …확인했습니다. `MSGR: done`) — 운영 실측 2026-09-30: 페퍼·효원·월터·보스웰 답에
// 그대로 보였다(유건 "말 끝마다 MSGR Done 왜 붙이는거야?"). 판정으로는 읽지 않고(인라인은 인용일 수 있다) 사람에게 보이지 않게만 뗀다.
// 인용(>)·들여쓴 코드·열린 코드 펜스 안은 그대로 둔다.
function hideInlineMarker(value) {
  const text = String(value ?? '');
  const body = text.replace(/\s+$/, '');
  const start = body.lastIndexOf('\n') + 1;
  const line = body.slice(start);
  if (/^( {0,3}>|    |\t)/.test(line) || openFence(body.slice(0, start))) return text;
  const m = /^(.*\S)[ \t]+(`?)MSGR: (?:handoff|done)\2[ \t]*$/.exec(line);
  return m ? body.slice(0, start) + m[1] : text;
}

/** 현재 답변의 마지막 독립 줄만 판정한다. 숫자·완료 문구·인용에서 종료를 추론하지 않는다. 문장 끝에 붙은 표지는 판정 없이 본문에서만 뗀다(hideInlineMarker). */
function parseMessengerDisposition(value) {
  const text = String(value ?? '');
  const match = /(?:^|\r?\n)MSGR: (handoff|done)[ \t]*(?:\r?\n[ \t]*)*$/.exec(text);
  if (!match || openFence(text.slice(0, match.index))) return { text: hideInlineMarker(text), disposition: null };
  return { text: text.slice(0, match.index).trimEnd(), disposition: match[1] };
}
export const displayText = (value) => parseMessengerDisposition(value).text;

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
// 거부(무효 토큰 401·무료 주인 403·429)에는 "언제 다시 오라"를 싣는다 — 텔레그램 규약 parameters.retry_after(초) + HTTP Retry-After(index.ts가 이 값으로).
// 새 연결 도구(Hermes 0.3.7·OpenClaw 0.3.4)는 이 값만큼 쉰다. 옛 도구는 모르는 필드라 무시한다(동작 그대로).
const failRetry = (status, description, retryAfterS) => ({ status, body: { ok: false, error_code: status, description, parameters: { retry_after: retryAfterS } } });

/* ── 거부 기억(2026-10-13, 엣지 호출 30일 추정 133%) ─────────────────────────────────────────────────
   거부를 받고도 계속 오는 봇(무료 주인 403 약 40초마다 하루 3.3만 건·무효 토큰 401 하루 4,500건)은 옛 연결 도구라 고칠 수 없다.
   같은 토큰이 REJECT_AFTER번 연달아 거부되면 REJECT_TTL 동안 DB를 부르지 않고 바로 거부한다(값싼 거절). 기억은 이 엣지 인스턴스의
   메모리뿐이다 — DB에 쓰지 않으므로 보존 기간·쓰기 비용이 없고, 인스턴스가 바뀌면 처음부터 다시 센다(인스턴스당 토큰마다 처음 REJECT_AFTER번, 그 뒤 TTL마다 1번 DB).
   정상 봇(Pro·유효 토큰)은 거부를 받지 않으므로 기억에 들어가지 않는다 — 판정·지연 그대로. 성공 응답 한 번이면 지운다.
   무료 → Pro로 바꾼 주인의 봇은 이 인스턴스에서 최대 TTL(5분) 늦게 풀린다. 토큰은 메모리 키로만 쓰고 기록하지 않는다. */
export const REJECT_AFTER = 3;
export const REJECT_TTL_S = { plan: 300, auth: 900 };   // = 응답의 retry_after
const REJECT_MAX = 5_000;                                // 메모리 상한 — 넘으면 가장 오래된 것부터 버린다(Map 삽입 순서)
export function createRejectMemory({ now = Date.now } = {}) {
  const m = new Map(); // token → { kind, n, until }
  return {
    // TTL이 지나면 DB에 한 번 다시 묻는다 — 횟수는 남겨 두어 그 한 번이 또 거부면 곧바로 다시 기억한다(TTL당 DB 1회). 성공이면 clear가 지운다.
    blocked(token) { const r = m.get(token); if (!r || !r.until) return null; if (now() < r.until) return r.kind; r.until = 0; return null; },
    reject(token, kind) {
      const r = m.get(token);
      const n = r && r.kind === kind ? r.n + 1 : 1;
      m.delete(token); // 최근 것이 뒤로(상한 정리 순서)
      m.set(token, { kind, n, until: n >= REJECT_AFTER ? now() + REJECT_TTL_S[kind] * 1000 : 0 });
      while (m.size > REJECT_MAX) m.delete(m.keys().next().value);
    },
    clear(token) { m.delete(token); },
    get size() { return m.size; },
  };
}
// 네 인자 함수가 아직 없는 DB(PostgREST PGRST202 — 함수·인자 조합을 못 찾음). 다른 오류(시간 초과·권한)는 물러나지 않는다
const missingRpcFn = (e) => e?.code === 'PGRST202' || /Could not find the function/i.test(String(e?.message ?? ''));
const REJECT_REPLY = {
  plan: () => failRetry(403, ERR.msgr_bot_plan_required[1], REJECT_TTL_S.plan),
  auth: () => failRetry(401, ERR.msgr_bot_unauthorized[1], REJECT_TTL_S.auth),
};

// rpc(fn, args) → JSON. PostgREST 오류는 {message, code, details}를 throw.
export async function handle({ token, method, params = {} }, rpc, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, maxWaitMs = MAX_WAIT_MS, sign = null, signUpload = null, purgeUploads = null, planGate = null, rejects = null, gateInUpdates = false } = {}) {
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
      const start = now();
      const deadline = start + waitMs;
      // 값싼 거절 — 기억된 거부 토큰은 DB 없이 롱폴 시간만큼 붙잡았다가 거부한다(옛 도구의 재시도 간격 = 대기 + 사다리, 종전 403과 같은 박자)
      const known = rejects?.blocked(token);
      if (known) { await sleep(Math.max(0, deadline - now())); return REJECT_REPLY[known](); }
      // 무료 계정 봇(2026-10-10): 막히면 롱폴 시간만큼 DB 조회 없이 붙잡았다가 403(+ Retry-After). 연결 도구는 403을 사다리로 다시 오므로 간격 = 대기 + 사다리.
      // 판정 자리(2026-10-13 로그 과금 축소 ①): gateInUpdates면 롱폴 첫 조회(msgr_bot_updates_with_delivery, gate => true)가 판정까지 한다 — 별도 msgr_bot_gate 호출 없음.
      //   DB가 아직 네 인자 함수가 없으면(마이그레이션 20261013180000 전·되돌림 — PGRST202) 종전 경로로 물러난다: msgr_bot_gate 1회 + 세 인자 조회.
      //   옛 연결 경로(delivery_protocol 없음 — msgr_bot_updates)도 종전 경로. 판정 실패(옛 DB에 함수 없음·시간 초과)는 막지 않는다(5xx면 Hermes가 3초 간격으로 다시 온다). 토큰 오류는 401.
      const delivery = Number(params.delivery_protocol) === 1;
      const fn = delivery ? 'msgr_bot_updates_with_delivery' : 'msgr_bot_updates';
      const args = { token, after_id: Math.max(0, offset - 1), lim };
      const blockPlan = async () => { rejects?.reject(token, 'plan'); await sleep(Math.max(0, deadline - now())); return REJECT_REPLY.plan(); };
      let ups = null; let gateSkipped = false;
      if (delivery && gateInUpdates) {
        try { ups = await rpc(fn, { ...args, gate: true }); }
        catch (e) {
          const m = String(e?.message ?? '');
          if (/msgr_bot_unauthorized/.test(m)) throw e; // 토큰 오류는 아래 공통 처리(401)
          if (/msgr_bot_plan_required/.test(m)) return blockPlan();
          // 네 인자 함수가 없는 옛 DB면 종전 경로(msgr_bot_gate). 그 밖의 오류(판정 함수 drop → 42883, is_pro_for·중지 기록·설정 오류, 시간 초과)는
          // 배포본처럼 막지 않는다(fail-open — 검수 2 #999): 판정 없이 아래 루프의 gate 없는 조회로 다시 받는다(오류가 날 때만 1회 더).
          if (!missingRpcFn(e)) { console.warn('[msgr-bot] plan gate in updates skipped:', m.slice(0, 200)); gateSkipped = true; }
        }
      }
      if (ups === null && planGate && !gateSkipped) {
        const verdict = await planGate(token).catch((e) => {
          if (/msgr_bot_unauthorized/.test(String(e?.message ?? ''))) throw e;
          console.warn('[msgr-bot] plan gate skipped:', String(e?.message ?? '').slice(0, 200));
          return 'ok';
        });
        if (verdict === 'plan_required') return blockPlan();
      }
      // 이벤트(루틴 편집·결재 결정)는 옵트인(events=1)한 어댑터에게만, 요청당 한 번 조회한다. update_id·offset과 무관하고
      // 서버가 60초 임대로 중복을 막는다. 이벤트 조회는 선택 기능 — 어떤 오류든(옛 서버의 RPC 없음, 시간 초과, 교착) 메시지 수신을
      // 막지 않게 빈 목록으로 넘긴다(검수 M-5). 서버가 닫힐 때까지 다시 보내므로 유실은 없다. 토큰 오류는 아래 메시지 조회가 401로 알린다.
      const evs = Number(params.events) === 1 ? await rpc('msgr_bot_events', { token }).catch((e) => {
        console.warn('[msgr-bot] events skipped:', String(e?.code ?? ''), String(e?.message ?? '').slice(0, 200));
        return [];
      }) : [];
      for (;;) {
        if (ups === null) ups = await rpc(fn, args);
        if (ups.length || evs?.length || now() >= deadline) { rejects?.clear(token); return reply(200, [...(evs ?? []), ...ups]); }
        const t = now();
        await sleep(Math.min(pollDelay(t - start), Math.max(1, deadline - t)));
        ups = null;
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
    if (method === 'createUpload' || method === 'attachFile') { // 봇 파일 보내기 — 붙일 글(봇 자기 글, 1시간 안)·크기(25MB)·개수(10)는 RPC가 판정한다
      const mid = Number(params.message_id);
      if (!Number.isSafeInteger(mid) || mid < 1) return fail(400, 'Bad Request: message_id must be this bot\'s message id');
      if (method === 'createUpload') {
        const up = await rpc('msgr_bot_attach_prepare', { token, p_message: mid, p_name: String(params.file_name ?? ''), p_bytes: Number(params.file_size) || 0 });
        // 이 봇이 2시간 넘게 등록하지 않은 업로드(서버가 고른 경로만) — 실패해도 업로드는 막지 않는다(다음 준비 때 다시 온다)
        if (purgeUploads && Array.isArray(up.purge) && up.purge.length) await purgeUploads(up.purge).catch((e) => console.warn('[msgr-bot] purge skipped:', String(e?.message ?? e).slice(0, 200)));
        const url = signUpload ? await signUpload(up.storage_path) : null;
        if (!url) return fail(500, 'Internal: upload signing unavailable');
        return reply(200, { storage_path: up.storage_path, upload_url: url, method: 'PUT', max_bytes: 524288000 }); // 전역 천장 — 플랜별 상한은 prepare RPC가 거절한다(20261012120000)
      }
      const id = await rpc('msgr_bot_attach_commit', { token, p_message: mid, p_path: String(params.storage_path ?? ''), p_name: String(params.file_name ?? ''),
        p_mime: params.mime_type == null ? null : String(params.mime_type) });
      return reply(200, { file_id: id, message_id: mid });
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
    if (method === 'reportStatus') { // 값이 바뀔 때만 서버가 쓴다. 응답 mirror_all = 소유자가 켠 "모든 예약 작업 보기"
      const applied = params.mirror_all_applied == null ? null : params.mirror_all_applied === true || params.mirror_all_applied === 'true';
      return reply(200, await rpc('msgr_bot_report_status', { token, p_version: params.version == null ? null : String(params.version),
        p_approval_mode: params.approval_mode == null ? null : String(params.approval_mode), p_mirror_all_applied: applied }));
    }
    if (method === 'requestApproval' && params.parent_approval_id != null) { // 재개 턴(실행 행 없음)의 카드 — 승인된 부모 결재의 원문에 붙인다(검수 M-3)
      return reply(200, await rpc('msgr_bot_request_followup_approval', { token, p_parent: String(params.parent_approval_id), p_approval_id: String(params.approval_id ?? ''),
        p_kind: params.kind === 'agent' ? 'agent' : 'shell', p_text: String(params.kind === 'agent' ? (params.title ?? '') : (params.command ?? '')),
        p_reason: params.reason == null ? null : String(params.reason) }));
    }
    if (method === 'requestApproval') { // 결재 카드. 원문은 실행 시도(execution_attempt)로 서버가 정하고, 등급은 서버가 고위험으로 정한다
      if (!UUID_RE.test(String(params.execution_attempt ?? ''))) return fail(400, 'Bad Request: execution_attempt (uuid) is required');
      if (params.kind === 'agent') { // 에이전트가 스스로 올리는 결재(도구) — 명령 대신 제목·사유. 기한 없음, 결정되면 approval_decided(agent=true)
        return reply(200, await rpc('msgr_bot_request_agent_approval', { token, p_attempt: params.execution_attempt, p_approval_id: String(params.approval_id ?? ''),
          p_title: String(params.title ?? ''), p_reason: params.reason == null ? null : String(params.reason) }));
      }
      return reply(200, await rpc('msgr_bot_request_approval', { token, p_attempt: params.execution_attempt, p_approval_id: String(params.approval_id ?? ''),
        p_command: String(params.command ?? ''), p_reason: params.reason == null ? null : String(params.reason) }));
    }
    if (method === 'ackApproval' || method === 'expireApproval') { // ack = 선점(claimed=true인 한 번만 재개), expire = 에이전트 쪽 대기 종료
      const id = String(params.approval_id ?? '');
      if (!id) return fail(400, 'Bad Request: approval_id is required');
      return reply(200, await rpc(method === 'ackApproval' ? 'msgr_bot_ack_approval' : 'msgr_bot_expire_approval', { token, p_approval_id: id }));
    }
    if (method === 'sendMessage' && params.approval_id != null) { // 후속 보고: 결정된 결재 한 건에 한 번만 원문 답글로(서버가 방·원문을 정한다)
      const body = displayText(params.text);
      if (!body.trim()) return fail(400, 'Bad Request: text is empty');
      const id = await rpc('msgr_bot_followup', { token, p_approval_id: String(params.approval_id), p_body: body });
      return reply(200, { message_id: Number(id), approval_id: String(params.approval_id), text: body });
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
    const text = displayText(params.text);
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
    if (name === 'msgr_bot_unauthorized') { // 무효·폐기 토큰 — 받기(getUpdates)만 기억한다(폴링이 폭주의 자리, 다른 메서드는 사람이 부를 때만)
      if (method === 'getUpdates') rejects?.reject(token, 'auth');
      return REJECT_REPLY.auth();
    }
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
