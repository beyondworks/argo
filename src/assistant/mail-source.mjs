// 능동 비서 — 메일 출처(오피스 Gmail) 읽기. 구글 토큰은 오피스 서버에만 있고(office_mail_secrets 봉인), 본체는 기기 세션 JWT로 오피스 메일 서버 함수
// (apps/office/api/mail/[op].js)를 부른다 — 에이전트 메일 도구(src/gateway/office-mail.mjs)와 같은 방법·같은 주소(ARGO_OFFICE_ORIGIN, https 또는 루프백만).
// 비서가 부를 수 있는 서버 동작은 MAIL_WATCH_CALLS 셋뿐이다(읽기만 — 테스트가 서버 라우터와 같이 잠근다). 보내기·초안 쓰기·라벨 바꾸기·본문 읽기(read)는 없다:
// 메일이 무엇을 시키든 비서 경로에는 메일을 내보내거나 바꾸는 호출이 없다(설계 9.1·9.2).
// 계정 목록은 office_mail_accounts(본인 행만 — RLS) 읽기 1번. 오류는 코드로 돌려준다(호출부가 상태에 남기고 다음 차례에 다시 — 커서는 처리한 것으로만 옮긴다).
import { officeOrigin, DEFAULT_ORIGIN } from '../gateway/office-files.mjs';

/** 비서가 부르는 오피스 메일 서버 동작과 메서드 — 서버는 목록·검색·thread를 POST 본문으로만 받는다(GET이면 405). */
export const MAIL_WATCH_CALLS = Object.freeze({ sync: 'POST', list: 'POST', thread: 'POST' });

export const sourceDeps = {
  jwt: async () => (await (await import('../devicesession.mjs')).getFreshDeviceSession())?.access_token ?? null,
  fetch: (...a) => fetch(...a),
  origin: () => process.env.ARGO_OFFICE_ORIGIN || DEFAULT_ORIGIN,
};

const coded = (code, message, extra = {}) => Object.assign(new Error(message ?? code), { code, ...extra });

/** 오피스 메일 서버 함수 한 번 — { data } 또는 코드 있는 오류를 던진다.
    코드: no_origin(주소가 https가 아님) · login_required(기기 로그인 없음·만료) · office_outdated(그 동작이 없는 옛 오피스 — 404 op) · rate_limited(retryAfter 초) ·
    expired · no_account · not_configured · network(연결 실패·시간 초과) · server(그 밖). */
export async function officeMail(op, body, { deps = sourceDeps, timeoutMs = 30_000 } = {}) {
  const method = MAIL_WATCH_CALLS[op];
  if (!method) throw coded('not_allowed', `assistant mail op not allowed: ${op}`);
  const origin = officeOrigin(deps.origin());
  if (!origin) throw coded('no_origin');
  const jwt = await deps.jwt().catch(() => null);
  if (!jwt) throw coded('login_required');
  let r;
  try {
    r = await deps.fetch(`${origin}/api/mail/${op}`, { method, headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw coded('network', String(e?.message ?? e).slice(0, 160)); }
  const d = await r.json().catch(() => ({}));
  if (r.ok) return { data: d };
  const code = d?.error;
  if (r.status === 404 && code === 'op') throw coded('office_outdated');
  if (code === 'signed_out' || r.status === 401 && !code) throw coded('login_required');
  if (code === 'rate_limited') throw coded('rate_limited', null, { retryAfter: Math.max(1, Number(d.retryAfter) || Number(r.headers?.get?.('retry-after')) || 60) });
  if (['expired', 'no_account', 'not_configured'].includes(code)) throw coded(code);
  throw coded('server', `HTTP ${r.status}${code ? ` ${code}` : ''}`);
}

/** 연결된 메일 계정 — [{ id, address, status }](본인 행만, RLS). 읽지 못하면 던진다(code 'db'). */
export async function mailAccounts(c) {
  const { data, error } = await c.client.from('office_mail_accounts').select('id, address, status').order('created_at');
  if (error) throw coded('db', String(error.message ?? error));
  return (data ?? []).filter((a) => a && typeof a.id === 'string' && typeof a.address === 'string');
}

/** 바뀐 것만 받기 — entries = [{ account, since, access }](최대 10). 반환 = 서버의 results 그대로(계정마다 결과 또는 error). */
export async function syncMail(entries, opts) {
  const { data } = await officeMail('sync', { accounts: entries.slice(0, 10) }, opts);
  return Array.isArray(data?.results) ? data.results : [];
}

const sec = (ms) => Math.floor(ms / 1000);
/** 메울 구간 읽기 — 받은편지함의 [from, to) (Gmail after:/before:는 초 단위). page = 다음 쪽 토큰. 반환 { items, next } */
export async function listWindow(account, fromMs, toMs, page = null, opts) {
  const q = `in:inbox after:${sec(fromMs)} before:${Math.max(sec(fromMs) + 1, sec(toMs) + 1)}`;
  const { data } = await officeMail('list', { account, q, ...(page ? { page } : {}) }, opts);
  return { items: Array.isArray(data?.items) ? data.items : [], next: typeof data?.next === 'string' ? data.next : null };
}

/** 스레드 하나 — [{ gid, from, addr, at, sent, subject, messageId, references, text }](오래된 순). 옛 오피스면 code 'office_outdated'. */
export async function readThread(account, threadId, opts) {
  const { data } = await officeMail('thread', { account, id: threadId }, opts);
  return Array.isArray(data?.messages) ? data.messages : [];
}
