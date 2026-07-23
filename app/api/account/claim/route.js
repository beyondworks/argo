// 로컬 회사 계정 귀속(클레임) — 게스트/로컬 시절 만든 주인 없는(ownerId 부재) 회사를
// 지금 로그인한 계정에 연결한다. 연결 즉시 동기화 대상이 된다(로그인 = 연동).
// 루프백 한정 — 호스티드 웹에서 허용하면 아무 계정이나 서버의 주인 없는 회사를 훔칠 수 있다.
import { AUTH_ON, currentUser, isLoopbackHost } from '../../../auth.mjs';
import { listCompanies } from '../../../../src/hub.mjs';
import { updateCompany } from '../../../../src/workspace.mjs';
import { clearGuestMode } from '../../../../src/gueststate.mjs';
import { nudgeSync } from '../../../../src/sync.mjs';

async function gate(req) {
  if (!AUTH_ON) return { deny: Response.json({ error: '로컬 모드에서는 계정 귀속이 필요 없습니다' }, { status: 400 }) };
  if (!isLoopbackHost(req.headers.get('host'))) {
    return { deny: Response.json({ error: '이 컴퓨터에서만 가능합니다' }, { status: 403 }) };
  }
  const user = await currentUser();
  // 게스트(id 'local')는 귀속 주체가 될 수 없다 — 실로그인 계정만
  if (!user || user.id === 'local') return { deny: Response.json({ error: '로그인이 필요합니다' }, { status: 401 }) };
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
  const { deny, user } = await gate(req);
  if (deny) return deny;
  const orphans = (await listCompanies()).filter((c) => !c.ownerId);
  for (const c of orphans) {
    await updateCompany(c.id, { ownerId: user.id });
  }
  await clearGuestMode();
  nudgeSync(); // 다음 사이클을 기다리지 않고 즉시 업로드 시작
  return Response.json(
    { ok: true, claimed: orphans.length },
    // 게스트 마커 쿠키 제거 — 이후 미들웨어는 실세션 경로로만 판단
    { headers: { 'Set-Cookie': 'argo-guest=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' } },
  );
}
