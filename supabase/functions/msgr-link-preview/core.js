// 엣지 함수 msgr-link-preview의 순수 로직 — Deno(index.ts)와 node 테스트(test/msgr-link-preview-edge.test.mjs)가 같이 쓴다.
// 계약: 보낸 사람 기기가 글을 보낸 직후 { message_id } 로 한 번 부른다. 함수는 그 사람 권한(Authorization 그대로)으로
//   글을 읽고(RLS), 첫 링크를 가져와 카드를 만들고, msgr_set_link_preview RPC로 그 글 meta에 저장한다.
//   링크 주소는 요청 본문으로 받지 않는다 — 자기 글에 실제로 있는 링크만 가져온다(임의 주소를 대신 열어 주는 통로가 되지 않게).
// 판정 순서(돈 드는 네트워크 전에 거른다): 로그인 → 글 번호 → 글 읽기(못 읽으면 404) → 작성자 본인 → 이미 카드 있음(그대로 돌려줌)
//   → 지운 글·10분 지남 → 첫 링크 → 가져오기(실패하면 카드 없음, 다시 시도 없음) → 저장.
import { firstUrl, fetchLinkPreview, headScanner } from '../_shared/link-preview.js';

export const CORS = {
  'Access-Control-Allow-Origin': '*', // 쿠키가 아니라 Authorization 헤더로만 인증 — 앱 출처(tauri://localhost 등)가 여러 개다
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const FRESH_MS = 10 * 60 * 1000; // RPC(msgr_set_link_preview)의 10분과 같다
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Authorization: Bearer <JWT>의 sub — 서명 검증은 배포 설정(verify_jwt 기본값)이 함수 앞에서 한다. 여기서는 작성자 비교에만 쓴다. */
export function jwtSub(authHeader) {
  const token = /^Bearer\s+([\w-]+\.([\w-]+)\.[\w-]*)$/i.exec(String(authHeader ?? '').trim());
  if (!token) return null;
  try {
    const b64 = token[2].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))));
    return typeof json?.sub === 'string' && UUID.test(json.sub) ? json.sub : null;
  } catch { return null; }
}

/** 웹 스트림을 </head>를 만나거나 maxBytes(1MB)에 닿을 때까지만 읽고 끊는다 — 큰 응답·느린 본문을 끝까지 받지 않는다(게이트웨이와 같은 headScanner). */
export async function readHead(stream, maxBytes) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const scan = headScanner(maxBytes);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || scan.push(value) !== 'more') break;
    }
  } finally { reader.cancel().catch(() => {}); }
  return scan.bytes();
}

/** 요청 하나 처리 → { status, body }. deps: { getMessage(id), setPreview(id, preview) → boolean, net: { resolve, request }, now? } */
export async function handle({ sub, body }, { getMessage, setPreview, net, now = Date.now }) {
  if (!sub) return { status: 401, body: { error: 'unauthorized' } };
  const id = Number(body?.message_id);
  if (!Number.isSafeInteger(id) || id <= 0) return { status: 400, body: { error: 'bad_message_id' } };
  const m = await getMessage(id);
  if (!m) return { status: 404, body: { error: 'not_found' } };
  if (m.author_kind !== 'user' || m.author_user_id !== sub) return { status: 403, body: { error: 'forbidden' } };
  if (m.meta?.link_preview) return { status: 200, body: { preview: m.meta.link_preview } };
  if (m.deleted_at || !(now() - Date.parse(m.created_at) <= FRESH_MS)) return { status: 200, body: { preview: null } };
  const url = firstUrl(m.body);
  if (!url) return { status: 200, body: { preview: null } };
  const preview = await fetchLinkPreview(url, net);
  if (!preview) return { status: 200, body: { preview: null } };
  const saved = await setPreview(id, preview).catch(() => false);
  return { status: 200, body: { preview: saved ? preview : null } };
}
