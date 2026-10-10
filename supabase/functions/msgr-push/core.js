// msgr-push 순수 부분 — 알림 문구·APNs/FCM 페이로드·JWT 조립. Deno와 Node 양쪽에서 돈다(Web Crypto만 사용) → test/msgr-push.test.mjs
const enc = new TextEncoder();
export const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o) => b64url(enc.encode(JSON.stringify(o)));
export function pemToDer(pem) {
  const body = String(pem).replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, '');
  const bin = atob(body); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** 사람 작성자 이름 — 앱 화면(msgr_my_friends)과 같은 순서: 조직 안 이름 → 계정 프로필 이름 → 이메일 앞부분.
 *  프로필 행이 없는 사용자가 많아(운영 2026-10-01: 프로필 5개, 글 쓴 사용자 9명은 행 없음) 프로필만 보면 알림 제목이 '?'가 됐다. */
export function personName({ memberName, profileName, email } = {}) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return pick(memberName) || pick(profileName) || pick(String(email ?? '').split('@')[0]) || null;
}

/** 알림 문구 — 데스크톱(notify.reply)과 같은 모양: 제목 "이름 · #채널", 본문 140자 발췌. */
export function pushText({ body, authorName, channelName, channelKind }) {
  const where = channelKind === 'dm' ? '' : (channelName ? ` · #${channelName}` : '');
  return { title: `${authorName || '?'}${where}`, body: String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) };
}

/** 신고 접수 알림(운영자용) — 제목에 개인 대화 여부, 본문은 사유 — 신고된 글 발췌(140자). */
export function reportPushText({ body, reason, personal }) {
  const excerpt = [reason, body].map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' — ');
  return { title: personal ? '신고 접수 · 개인 대화' : '신고 접수', body: excerpt.slice(0, 140) || '(내용 없음)' };
}

/** 결제 미연결 알림(운영자용) — 대상 판정. SQL billing_unmatched_alertable과 같은 규칙(test/billing-alert-pg.test.mjs가 대조).
 *  연결 실패·대사 불일치 사유이고, 구독 번호가 LS 실번호(숫자)이며, 시험 결제·probe가 아니고, 아직 처리되지 않은 행. */
export const BILLING_ALERT_REASONS = {
  'no-user': '결제 이메일과 같은 계정 없음',
  'duplicate-attribution': '이미 다른 계정에 연결된 구독',
  'email-account-has-subscription': '그 계정에 다른 유효 구독 있음',
  'reconcile-ls-pro-not-linked': 'LS는 결제 중인데 Pro가 아님',
  'reconcile-pro-not-in-ls': 'Pro인데 LS에 유효 구독 없음',
};
export function billingAlertable(r) {
  if (!r || r.resolved_at) return false;
  if (!Object.hasOwn(BILLING_ALERT_REASONS, String(r.reason ?? ''))) return false;
  if (!/^[0-9]+$/.test(String(r.ls_subscription_id ?? ''))) return false;
  if (/(probe|test)/i.test(String(r.event_name ?? ''))) return false;
  return r.test_mode !== true;
}

/** 결제 이메일 가리기 — 첫 글자와 도메인만(pay@example.com → p***@example.com). ls-webhook maskEmail과 같은 모양. */
export function maskEmail(email) {
  const e = String(email ?? '').trim();
  const at = e.lastIndexOf('@');
  if (at < 1) return e ? '***' : '?';
  return `${e[0]}***${e.slice(at)}`;
}

/** 결제 미연결 알림 문구 — 구독 번호·가린 이메일·사유만. 이메일 전체·고객 id·포털 주소는 싣지 않는다. */
export function billingPushText({ reason, ls_subscription_id, user_email }) {
  const reconcile = String(reason ?? '').startsWith('reconcile-');
  const label = BILLING_ALERT_REASONS[reason] ?? String(reason ?? '');
  return {
    title: reconcile ? '결제 대사 불일치' : '결제 미연결',
    body: `구독 ${ls_subscription_id} · ${maskEmail(user_email)} · ${label}`.slice(0, 140),
  };
}

export function apnsPayload({ title, body, channelId, messageId, sound = 'wood-knock', badge = null }) {
  // sound = 기기가 고른 소리(msgr_push_tokens.sound) → 앱 번들의 <이름>.caf. 번들에 없으면 iOS가 기본음으로 대체한다. badge = 수신자의 안읽음 총계(아이콘 숫자)
  const file = `${String(sound || 'wood-knock').replace(/[^a-z0-9-]/g, '') || 'wood-knock'}.caf`;
  const aps = { alert: { title, body }, sound: file, 'thread-id': String(channelId), 'mutable-content': 0 };
  if (Number.isInteger(badge) && badge >= 0) aps.badge = badge;
  return { aps, channel_id: String(channelId), message_id: String(messageId) };
}
export function fcmMessage({ token, title, body, channelId, messageId, sound = 'wood-knock', tag = String(channelId) }) {
  const choices = ['seatbelt-single', 'seatbelt-hilo', 'wood-knock', 'wood-knock-double', 'wood-marimba'];
  const resource = (choices.includes(sound) ? sound : 'wood-knock').replaceAll('-', '_');
  return { message: { token, notification: { title, body }, data: { channel_id: String(channelId), message_id: String(messageId) },
    android: { priority: 'high', notification: { channel_id: `msgr_sound_${resource}`, sound: resource, tag } } } };
}

/** APNs 토큰 인증 JWT(ES256, .p8) — 유효 1시간 이내로 갱신해서 쓴다. */
export async function apnsJwt({ p8, keyId, teamId, now = Math.floor(Date.now() / 1000) }) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(p8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const input = `${b64urlJson({ alg: 'ES256', kid: keyId })}.${b64urlJson({ iss: teamId, iat: now })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input)); // WebCrypto ECDSA = r||s 원형(JWS 규격)
  return `${input}.${b64url(sig)}`;
}

/** Google OAuth2 서비스 계정 JWT(RS256) → access token 교환은 호출부(fetch). */
export async function googleAssertion({ clientEmail, privateKey, scope, tokenUri = 'https://oauth2.googleapis.com/token', now = Math.floor(Date.now() / 1000) }) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const input = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({ iss: clientEmail, scope, aud: tokenUri, iat: now, exp: now + 3600 })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

/** 발송 결과 → 토큰 폐기 여부. APNs 410/BadDeviceToken·Unregistered, FCM UNREGISTERED/INVALID_ARGUMENT(잘못된 토큰). */
export function shouldDropToken(platform, status, bodyText = '') {
  if (platform === 'ios') return status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(bodyText);
  return status === 404 || /UNREGISTERED|Requested entity was not found|INVALID_ARGUMENT/.test(bodyText);
}
