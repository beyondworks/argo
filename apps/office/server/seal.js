// 봉인 — 메일 토큰과 로그인 state를 서버 키(OFFICE_MAIL_KEY, 32바이트 base64)로 암호화한다. AES-256-GCM, 형식 'v1.<iv>.<암호문+태그>'(base64url).
// aad로 주인을 묶는다: 토큰은 '사용자:제공자:주소' — 남의 봉인 문자열을 제 계정에 넣어도 풀리지 않는다.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function mailKey(env = process.env) {
  const k = Buffer.from(env.OFFICE_MAIL_KEY ?? '', 'base64');
  if (k.length !== 32) throw Object.assign(new Error('OFFICE_MAIL_KEY must be 32 bytes (base64)'), { status: 503, code: 'not_configured' });
  return k;
}

export function seal(key, text, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}`;
}

/** 못 풀면(키·aad가 다르거나 변조) null */
export function unseal(key, sealed, aad) {
  const [v, iv, body] = String(sealed ?? '').split('.');
  if (v !== 'v1' || !iv || !body) return null;
  try {
    const buf = Buffer.from(body, 'base64url');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
  } catch { return null; }
}

/** 로그인 state — 시작한 사용자·PKCE 검증값·만료(10분). 암호화해서 주소창에 사용자 id가 드러나지 않게 */
export const sealState = (key, obj, now = Date.now()) => seal(key, JSON.stringify({ ...obj, exp: now + 10 * 60_000 }), 'office-mail-state');
export function openState(key, s, now = Date.now()) {
  const raw = unseal(key, s, 'office-mail-state');
  const o = raw && JSON.parse(raw);
  return o && o.exp > now ? o : null;
}
