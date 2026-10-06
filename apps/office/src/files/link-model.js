// 공유 링크 규칙(순수 함수 — 화면·예시 저장소·시험이 같이 쓴다). 데이터는 links.js, 규칙 시험은 test/mail-model.test.mjs.
export const LINK_DAYS = 30; // 기본 만료(유건 결정 5 명세 — 30일)
export const linkTokenOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(t); // api/files LINK_TOKEN과 같은 모양
/** 32바이트 무작위 → base64url 43자 */
export function newLinkToken(rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  let s = '';
  for (const x of rand(32)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sha256Hex(s) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** 링크 주소의 경로 — 토큰은 '#' 뒤(조각)에 둔다. 조각은 브라우저가 서버로 보내지 않아 서버·CDN 접근 기록과 Referer에 토큰이 남지 않는다(분리 검수 LOW-11) */
export const linkPath = (token) => `/f#${token}`;
/** 공개 화면이 주소 조각(location.hash)에서 토큰을 꺼낸다 — '#' 뒤 전부, 없으면 '' */
export const tokenFromHash = (hash) => String(hash ?? '').replace(/^#/, '');
/** 남은 날(만료 시각까지, 올림) */
export const linkDaysLeft = (expiresAt, now = Date.now()) => Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 864e5));
