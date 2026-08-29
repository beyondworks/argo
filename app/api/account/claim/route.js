// 로컬 회사 계정 귀속(클레임) — 게스트/로컬 시절 만든 주인 없는(ownerId 부재) 회사를
// 지금 로그인한 계정에 연결한다. 연결 즉시 동기화 대상이 된다(로그인 = 연동).
// 루프백 한정 — 호스티드 웹에서 허용하면 아무 계정이나 서버의 주인 없는 회사를 훔칠 수 있다.
import { AUTH_ON, currentUser, isLoopbackHost, tenantDenied, csrfDenied, authError, requestLang } from '../../../auth.mjs';
import { listCompanies } from '../../../../src/hub.mjs';
import { claimLocalToAccount } from '../../../../src/accountclaim.mjs';

async function gate(req) {
  if (!AUTH_ON) return { deny: Response.json({ error: '로컬 모드에서는 계정 귀속이 필요 없습니다' }, { status: 400 }) };
  if (!isLoopbackHost(req.headers.get('host'))) {
    return { deny: Response.json({ error: '이 컴퓨터에서만 가능합니다' }, { status: 403 }) };
  }
  const user = await currentUser();
  const lang = await requestLang();
  // 게스트(id 'local')는 귀속 주체가 될 수 없다 — 실로그인 계정만
  if (!user || user.id === 'local') return { deny: authError('auth_required', lang) };
  // 워커(ARGO_TENANT_OWNER) 인스턴스 — 다른 계정 세션이 루프백으로 붙어 주인 없는 회사를 훔치는 것 차단
  // (검수 HIGH 2026-07-23: 형제 라우트 guardCompany/companies와 대칭). 로컬 모드는 tenantDenied가 null 반환.
  const td = tenantDenied(user, lang);
  if (td) return { deny: td };
  return { user };
}

/** 귀속 대상(주인 없는 로컬 회사) 수 — 홈의 클레임 배너 노출 판단용. */
export async function GET(req) {
  const { deny, user } = await gate(req);
  if (deny) return deny;
  const orphans = (await listCompanies()).filter((c) => !c.ownerId);
  return Response.json({ count: orphans.length, names: orphans.map((c) => c.name), userEmail: user.email });
}

/** 전부 귀속 — 이 컴퓨터의 주인 없는 회사를 현재 계정으로. 게스트 마커도 함께 해제. */
export async function POST(req) {
  try {
    const csrf = csrfDenied(req); if (csrf) return csrf; // 악성 웹페이지의 강제 클레임 차단
    const { deny, user } = await gate(req);
    if (deny) return deny;
    // 귀속 + 로컬 계정 자격 이관 — 로그인 직후 자동 귀속(device/login·auth/callback)과 같은 하나(accountclaim.mjs)
    const { claimed, creds } = await claimLocalToAccount(user.id);
    return Response.json(
      { ok: true, claimed, creds },
      // 게스트 마커 쿠키 제거 — 이후 미들웨어는 실세션 경로로만 판단
      { headers: { 'Set-Cookie': 'argo-guest=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' } },
    );
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
