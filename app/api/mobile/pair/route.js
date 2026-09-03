// 폰 페어링 진입점 — 6자리 코드(비밀·5분·1회)를 소비해 토큰 쿠키를 발급한다. 미들웨어가 비루프백에서도
// 공개하는 경로(코드가 곧 인가). CSRF 게이트 없음 — 교차 출처가 이 POST를 성공시키려면 코드를 알아야 하고,
// 알면 어차피 정상 페어링과 같다. 표시 언어는 폰이 본문으로 준다(쿠키 이전 시점이라 argo-lang이 없다).
import { consumePairCode, MOBILE_COOKIE } from '../../../../src/mobile-pairs.mjs';
import { apiError } from '../../../apimsg.mjs';

const cookie = (token) => `${MOBILE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

export async function POST(req) {
  const { code, name, lang } = await req.json().catch(() => ({}));
  const l = lang === 'en' ? 'en' : 'ko';
  if (process.env.ARGO_TENANT_OWNER?.trim()) return apiError('mobile_loopback_only', l);
  const r = await consumePairCode(String(code || ''), { name: String(name || ''), ua: req.headers.get('user-agent') || '' });
  if (r.error) return apiError(r.error, l);
  return Response.json({ ok: true, pair: r.pair }, { headers: { 'Set-Cookie': cookie(r.token) } });
}
