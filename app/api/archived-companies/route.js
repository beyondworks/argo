// 보관한 회사 — 목록과 되돌리기(F14, 2026-10-05). '회사 보관'은 데이터 보관이라 안내하면서 앱 안에서 되돌릴 길이 없었다.
// 소유 판정은 회사 목록(app/api/companies GET)과 같다: 인증 on = 내 회사만(게스트는 주인 없는 회사만), off = 로컬 전부.
// 경로가 /api/companies/archived가 아닌 이유: 그 자리는 동적 [ws]와 겹쳐 'archived'라는 회사 id를 가린다.
import { listArchivedCompanies, restoreArchivedCompany } from '../../../src/workspace.mjs';
import { AUTH_ON, currentUser, tenantDenied, authError, requestLang, csrfDenied } from '../../auth.mjs';
import { apiError } from '../../apimsg.mjs';

const mine = (user) => (c) => (!AUTH_ON ? true : user.id === 'local' ? !c.ownerId : c.ownerId === user.id);

async function gate() {
  const lang = await requestLang();
  const user = await currentUser();
  if (!user) return { denied: authError('auth_required', lang), lang };
  const td = tenantDenied(user, lang); if (td) return { denied: td, lang };
  return { user, lang };
}

export async function GET() {
  const { denied, user } = await gate(); if (denied) return denied;
  const items = (await listArchivedCompanies()).filter(mine(user)).map(({ archiveId, wsId, name, archivedAt }) => ({ archiveId, wsId, name, archivedAt }));
  return Response.json({ items });
}

export async function POST(req) {
  const csrf = csrfDenied(req); if (csrf) return csrf;
  const { denied, user, lang } = await gate(); if (denied) return denied;
  const { archiveId } = await req.json().catch(() => ({}));
  const it = (await listArchivedCompanies()).find((c) => c.archiveId === archiveId);
  if (!it || !mine(user)(it)) return apiError('archive_not_found', lang); // 남의 보관본은 없는 것과 같다
  try {
    const r = await restoreArchivedCompany(archiveId);
    return Response.json({ ok: true, wsId: r.wsId });
  } catch (e) {
    if (e?.code === 'EXISTS') return apiError('archive_restore_exists', lang);
    if (e?.code === 'BAD_ID' || e?.code === 'NOT_FOUND') return apiError('archive_not_found', lang);
    console.error('[argo] 회사 되돌리기 실패:', e?.message ?? e);
    return apiError('archive_restore_failed', lang);
  }
}
