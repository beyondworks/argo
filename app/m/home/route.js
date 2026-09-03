// 폰 진입 목적지 — 페어링 직후·앱 재실행 시 "첫 회사"로 바로 보낸다. 회사 선택 랜딩(/)은 폰 셸 밖 화면이라
// 폰에서는 거치지 않는다. 토큰이 없거나 무효면 /m/pair(다시 연결)로. 회사 목록 필터는 /api/companies GET과 같은 계약.
import { listCompanies } from '../../../src/hub.mjs';
import { AUTH_ON, currentUser } from '../../auth.mjs';
import { publicUrl } from '../../http-origin.mjs';

export async function GET(req) {
  // 워커(TENANT)는 폰 경로 자체가 없다 — 다른 모바일 라우트와 같이 env를 직접 본다(tenantDenied는 무인증 모드에서 null)
  if (process.env.ARGO_TENANT_OWNER?.trim()) return Response.redirect(publicUrl(req, '/m/pair'), 302);
  const user = await currentUser();
  if (!user) return Response.redirect(publicUrl(req, '/m/pair'), 302);
  const all = await listCompanies();
  const mine = AUTH_ON ? all.filter((c) => (user.id === 'local' ? !c.ownerId : c.ownerId === user.id)) : all;
  return Response.redirect(publicUrl(req, mine[0]?.id ? `/c/${mine[0].id}` : '/'), 302);
}
