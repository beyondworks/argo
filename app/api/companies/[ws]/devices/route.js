// 기기 페어링 — 이 회사(오너)의 동기화 자격을 연결 코드로 발급.
// 코드는 서비스 키를 담는다 — 응답으로만 나가고 절대 로그에 남기지 않는다.
import { loadCompany } from '../../../../../src/workspace.mjs';
import { loadSyncCreds } from '../../../../../src/synccreds.mjs';
import { makePairCode } from '../../../../../src/pairing.mjs';
import { guardCompany } from '../../../../auth.mjs';

export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
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
