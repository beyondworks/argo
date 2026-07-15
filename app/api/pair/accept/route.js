// 페어링 수신 — 연결 코드를 자격 파일(0600)로 저장하고 동기화 루프를 재시작 없이 기동한다.
import { parsePairCode } from '../../../../src/pairing.mjs';
import { saveSyncCreds } from '../../../../src/synccreds.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { currentUser, tenantDenied, AUTH_ON } from '../../../auth.mjs';

export async function POST(req) {
  try {
    const user = await currentUser();
    if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
    const td = tenantDenied(user); if (td) return td;
    const { code } = await req.json();
    const creds = parsePairCode(code); // 형식 불일치는 throw → 400
    // 방어심층(P0-1) — 호스팅(로그인) 모드에선 코드의 owner가 현재 사용자와 일치해야 한다.
    // 실수/CSRF로 실행 중 인스턴스를 공격자 url+key로 재조준하는 것 차단. 로컬(비인증)은 owner 개념이 달라 스킵.
    if (AUTH_ON && creds.owner !== user.id) {
      return Response.json({ error: '연결 코드의 소유자가 현재 로그인 사용자와 다릅니다' }, { status: 403 });
    }
    await saveSyncCreds(creds);
    ensureSync(); // 자격이 방금 생겼다 — 부팅 때 안 떴던 루프를 지금 기동
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
