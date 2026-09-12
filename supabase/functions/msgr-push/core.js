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

/** 알림 문구 — 데스크톱(notify.reply)과 같은 모양: 제목 "이름 · #채널", 본문 140자 발췌. */
export function pushText({ body, authorName, channelName, channelKind }) {
  const where = channelKind === 'dm' ? '' : (channelName ? ` · #${channelName}` : '');
  return { title: `${authorName || '?'}${where}`, body: String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) };
}

export function apnsPayload({ title, body, channelId, messageId, sound = 'seatbelt-single', badge = null }) {
  // sound = 기기가 고른 소리(msgr_push_tokens.sound) → 앱 번들의 <이름>.caf. 번들에 없으면 iOS가 기본음으로 대체한다. badge = 수신자의 안읽음 총계(아이콘 숫자)
  const file = `${String(sound || 'seatbelt-single').replace(/[^a-z0-9-]/g, '') || 'seatbelt-single'}.caf`;
  const aps = { alert: { title, body }, sound: file, 'thread-id': String(channelId), 'mutable-content': 0 };
  if (Number.isInteger(badge) && badge >= 0) aps.badge = badge;
  return { aps, channel_id: String(channelId), message_id: String(messageId) };
}
export function fcmMessage({ token, title, body, channelId, messageId }) {
  return { message: { token, notification: { title, body }, data: { channel_id: String(channelId), message_id: String(messageId) },
    android: { priority: 'high', notification: { channel_id: 'msgr', tag: String(channelId) } } } };
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
