// 로그인 서버(Supabase)에 세션 토큰을 확인시키는 getUser 호출의 실패 판정 — 기기 링크 라우트(app/api/device/link)와
// CLI 로그인(src/cli/login.mjs)이 같이 쓴다. 예전에는 어떤 오류든 "유효하지 않은 세션입니다"로 바꿔서, 이 컴퓨터의 Argo가
// 로그인 서버에 연결하지 못한 경우(회사 프록시·보안 프로그램·방화벽)도 "토큰이 틀렸다"로 보였다.
//   unreachable — 연결 자체가 안 됨(AuthRetryableFetchError status 0/없음, fetch failed). 사용자가 네트워크를 확인해야 한다.
//   rejected    — 서버가 토큰을 거부(AuthApiError 4xx, 429·408 제외). 다시 로그인하면 된다.
//   unknown     — 위 둘이 아님(5xx·429·모르는 오류). 토큰 탓으로 단정하지 않는다.
// 순수 판정 + 토큰 값을 어디에도 싣지 않는 것이 계약이다(로그·응답·반환값 모두).
import { createClient } from '@supabase/supabase-js';

const MSG = {
  unreachable: '이 컴퓨터의 Argo가 로그인 서버(Supabase)에 연결하지 못했습니다. 회사 네트워크·VPN·프록시·보안 프로그램이 Argo의 인터넷 연결을 막고 있는지 확인해 주세요.',
  rejected: '유효하지 않은 세션입니다. 다시 로그인해 주세요.',
  unknown: '로그인 서버에서 세션을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};

/** 네트워크 오류 객체에서 원인 코드(ECONNREFUSED·ENOTFOUND·UNABLE_TO_VERIFY_LEAF_SIGNATURE …)를 꺼낸다. 없으면 undefined. */
export function netErrorCode(e) {
  for (let cur = e, i = 0; cur && i < 4; cur = cur.cause, i++) {
    if (typeof cur.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(cur.code)) return cur.code; // auth-js의 'bad_jwt' 같은 소문자 코드는 제외
    const inner = cur.errors?.find?.((x) => typeof x?.code === 'string'); // localhost가 ::1·127.0.0.1 둘 다 실패하면 AggregateError
    if (inner) return inner.code;
  }
  return undefined;
}

/** getUser 오류 → { kind, name, status, code }. netCode는 fetch 감시기가 잡아 둔 원인 코드(supabase-js가 원인을 버리므로 따로 받는다). */
export function classifyAuthError(error, netCode) {
  const status = typeof error?.status === 'number' ? error.status : undefined;
  const name = String(error?.name ?? 'Error');
  const message = String(error?.message ?? '');
  const noResponse = status === undefined || status === 0;
  let kind = 'unknown';
  if ((name === 'AuthRetryableFetchError' && noResponse) || (noResponse && /fetch failed|failed to fetch|networkerror/i.test(message))) kind = 'unreachable';
  else if (status >= 400 && status < 500 && status !== 408 && status !== 429) kind = 'rejected';
  const code = kind === 'unreachable' ? (netCode ?? netErrorCode(error)) : (typeof error?.code === 'string' ? error.code : undefined);
  return { kind, name, status, code };
}

/** 판정 → 사용자에게 줄 응답 { status, body }. 연결 실패·알 수 없음 = 502, 거부 = 401. code는 있을 때만 싣는다. */
export function linkFailure(f) {
  const body = { error: MSG[f.kind], kind: f.kind }; // error = 예전 클라이언트용 ko 문구, kind = 화면이 표시 언어 문구를 고르는 열쇠
  if (f.code) body.code = f.code;
  return { status: f.kind === 'rejected' ? 401 : 502, body };
}

/** 서버 콘솔 기록 한 줄(오류 이름·status·code만 — 토큰은 싣지 않는다). */
export const describeFailure = (f) => `getUser 실패(${f.kind}) name=${f.name} status=${f.status ?? '-'} code=${f.code ?? '-'}`;

/** 세션 토큰을 로그인 서버에 확인시킨다 → { user } 또는 { failure }. fetch를 감싸 연결 실패의 원인 코드를 잡는다. */
export async function verifyAccessToken({ url, anonKey, accessToken }) {
  let netCode;
  const watched = async (...a) => { try { return await fetch(...a); } catch (e) { netCode = netErrorCode(e); throw e; } };
  const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: watched } });
  const { data, error } = await sb.auth.getUser(accessToken);
  if (error) return { failure: classifyAuthError(error, netCode) };
  if (!data?.user) return { failure: { kind: 'rejected', name: 'NoUser', status: undefined, code: undefined } }; // 오류 없이 사용자도 없음 = 거부와 같다
  return { user: data.user };
}
