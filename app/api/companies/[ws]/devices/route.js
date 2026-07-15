// 기기 페어링 — 이 회사(오너)의 동기화 자격을 연결 코드로 발급.
// 코드는 서비스 키를 담는다 — 응답으로만 나가고 절대 로그에 남기지 않는다.
import { loadCompany } from '../../../../../src/workspace.mjs';
import { loadSyncCreds } from '../../../../../src/synccreds.mjs';
import { makePairCode } from '../../../../../src/pairing.mjs';
import { guardCompany, AUTH_ON } from '../../../../auth.mjs';

export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  // 호스팅(로그인) 모드에선 서비스 키를 담은 페어링 코드를 발급하지 않는다(P0-1) — 기기 연결은 로그인(JWT+RLS)으로.
  // UI는 이미 authOn일 때 발급 버튼을 숨기지만, 라우트가 직접 호출 가능하므로 서버에서도 막는다.
  if (AUTH_ON) return Response.json({ error: '로그인 모드에서는 페어링 코드를 발급하지 않습니다 — 각 기기에서 로그인하세요' }, { status: 403 });
  try {
    const creds = loadSyncCreds();
    if (!creds) return Response.json({ error: '이 기기에 동기화 자격이 없습니다 — 환경변수 설정 또는 페어링이 먼저 필요합니다' }, { status: 400 });
    const company = await loadCompany(ws);
    const owner = company?.ownerId || creds.owner || null;
    if (!owner) return Response.json({ error: '회사에 소유자(ownerId)가 없어 페어링할 수 없습니다' }, { status: 400 });
    return Response.json({ code: makePairCode({ url: creds.url, key: creds.key, owner }) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
