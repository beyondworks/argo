// 브라우저: 로그인 완료 후 세션을 코드에 봉인. 세션 토큰은 메모리 저장소에만 담긴다.
import { bindPairing } from '../store.mjs';

export async function POST(req) {
  const { code, access_token, refresh_token } = await req.json().catch(() => ({}));
  if (!code || !access_token || !refresh_token) {
    return Response.json({ error: '코드와 세션이 필요합니다' }, { status: 400 });
  }
  const ok = bindPairing(code, { access_token, refresh_token });
  return Response.json({ ok });
}
