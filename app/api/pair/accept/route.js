// 페어링 수신 — 연결 코드를 자격 파일(0600)로 저장하고 동기화 루프를 재시작 없이 기동한다.
import { parsePairCode } from '../../../../src/pairing.mjs';
import { saveSyncCreds } from '../../../../src/synccreds.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { currentUser, tenantDenied } from '../../../auth.mjs';

export async function POST(req) {
  try {
    const user = await currentUser();
    if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
    const td = tenantDenied(user); if (td) return td;
    const { code } = await req.json();
    const creds = parsePairCode(code); // 형식 불일치는 throw → 400
    await saveSyncCreds(creds);
    ensureSync(); // 자격이 방금 생겼다 — 부팅 때 안 떴던 루프를 지금 기동
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
