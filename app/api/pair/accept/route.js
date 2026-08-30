// 페어링 수신 — 연결 코드를 자격 파일(0600)로 저장하고 동기화 루프를 재시작 없이 기동한다.
import { parsePairCode } from '../../../../src/pairing.mjs';
import { saveSyncCreds } from '../../../../src/synccreds.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { currentUser, tenantDenied, AUTH_ON, authError, langFromCookieHeader } from '../../../auth.mjs';
import { apiError } from '../../../apimsg.mjs';

export async function POST(req) {
  // 표시 언어 — 오류 문구를 사용자 화면 언어(argo-lang 쿠키)로 그린다(#333 계약의 기능 라우트 합류)
  const lang = langFromCookieHeader(req.headers.get('cookie'));
  try {
    const user = await currentUser();
    if (!user) return authError('auth_required', lang);
    const td = tenantDenied(user, lang); if (td) return td;
    const { code } = await req.json();
    const creds = parsePairCode(code); // 형식 불일치는 throw → 400
    // 방어심층(P0-1) — 호스팅(로그인) 모드에선 코드의 owner가 현재 사용자와 일치해야 한다.
    // 실수/CSRF로 실행 중 인스턴스를 공격자 url+key로 재조준하는 것 차단. 로컬(비인증)은 owner 개념이 달라 스킵.
    if (AUTH_ON && creds.owner !== user.id) {
      return apiError('pair_owner_mismatch', lang);
    }
    await saveSyncCreds(creds);
    ensureSync(); // 자격이 방금 생겼다 — 부팅 때 안 떴던 루프를 지금 기동
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
