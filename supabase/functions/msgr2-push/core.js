// msgr2-push 순수 부분 — 플랫폼 판정·알림 문구·재시도 판정. Deno와 Node 양쪽에서 돈다 → test/msgr2-push.test.mjs
// APNs·FCM 페이로드·JWT·무효 토큰 판정은 옛 msgr-push/core.js를 그대로 쓴다(같은 앱·같은 키).
export { apnsJwt, apnsPayload, fcmMessage, googleAssertion, shouldDropToken, personName } from '../msgr-push/core.js';

export const PREVIEW_MAX = 140; // 본문 미리보기 상한(옛 메신저 알림과 같다)
export const TITLE_MAX = 100;
export const MAX_ATTEMPTS = 3; // 한 기기에 같은 알림을 보내는 최대 시도(일시 오류만 다시)
export const RETRY_BASE_MS = 1000; // 1초 → 3초(상한 5초)
export const DEADLINE_MS = 60_000; // 엣지 실행 시간 안 — 이 뒤로는 새 시도를 시작하지 않는다
export const VIEW_WAIT_MS = 3_000; // "보는 중" 판정 전에 기다리는 상한 — 방을 보는 앱이 새 글을 그리고 읽음을 올릴 시간(20261018061100_msgr2_push_viewing.sql)

/** 글이 생긴 시각(created_at) → 받는 사람을 계산하기 전에 더 기다릴 ms. 글 뒤 VIEW_WAIT_MS가 지났으면 0, 시각을 모르면 VIEW_WAIT_MS 전부.
 *  엣지 호출이 늦게 왔으면(pg_net 대기) 그만큼 덜 기다린다. 시계가 어긋나 글이 미래로 보여도 VIEW_WAIT_MS를 넘기지 않는다. */
export function viewWait(createdAt, now = Date.now()) {
  const at = Date.parse(String(createdAt ?? ''));
  if (!Number.isFinite(at)) return VIEW_WAIT_MS;
  return Math.max(0, Math.min(VIEW_WAIT_MS, at + VIEW_WAIT_MS - now));
}

/** 기기 토큰 → 플랫폼. v2 기기 행(msgr2_devices.push_token)에는 플랫폼 열이 없다.
 *  'ios:'·'android:' 접두가 있으면 그것을 따르고, 없으면 모양으로 가른다: APNs 기기 토큰은 32바이트 16진수(64자), 그 밖은 FCM.
 *  모양이 둘 다 아니면(빈 값·공백) null — 보내지 않는다. */
export function platformOf(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(ios|android):(.+)$/i.exec(s);
  if (m) return m[2] ? { platform: m[1].toLowerCase(), token: m[2] } : null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return { platform: 'ios', token: s.toLowerCase() };
  if (/^[A-Za-z0-9_:.-]{20,4096}$/.test(s)) return { platform: 'android', token: s };
  return null;
}

/** 알림 문구 — 제목 "이름 · #방"(1:1이면 이름만), 본문은 공백을 접은 미리보기 PREVIEW_MAX자. 승인 요청 카드는 "승인 요청" 머리. */
export function pushText({ body, authorName, roomName, roomKind, card = false }) {
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const where = roomKind === 'direct' ? '' : (clean(roomName) ? ` · #${clean(roomName)}` : '');
  const title = `${clean(authorName) || '?'}${where}`.slice(0, TITLE_MAX);
  const text = clean(body);
  const preview = (card ? `승인 요청${text ? ` · ${text}` : ''}` : text).slice(0, PREVIEW_MAX);
  return { title, body: preview || (card ? '승인 요청' : '…') };
}

/** 한 번 보낸 결과 → 다시 보낼까. 일시 오류(429·5xx·네트워크)만, 시도 상한 안에서. 무효 토큰(410·404·400)은 다시 보내지 않는다. */
export function retryable(result, attempt) {
  if (attempt >= MAX_ATTEMPTS) return false;
  return /^(?:apns|fcm) (?:429|5\d\d)\b/.test(String(result)) || /^err /.test(String(result));
}
export const retryDelay = (attempt) => Math.min(5_000, RETRY_BASE_MS * 3 ** (attempt - 1));
