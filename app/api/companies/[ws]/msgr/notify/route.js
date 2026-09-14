// 알림 받을 메신저 › 아르고 메신저 — GET 현재 값(켜짐 여부·메신저 로그인·브리지), POST { on: true|false }. 저장 정본은 company.json.msgr.notify(src/msgr-notify.mjs).
import { guardCompany, csrfDenied, authError, requestLang } from '../../../../../auth.mjs';
import { apiError } from '../../../../../apimsg.mjs';
import { sessionClient } from '../../../../../../src/gateway/msgr.mjs';
import { loadCompany, updateCompany } from '../../../../../../src/workspace.mjs';
import { normalizeMsgrNotify } from '../../../../../../src/msgr-notify.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const company = await loadCompany(ws).catch(() => ({}));
  const c = await sessionClient().catch(() => null);
  return Response.json({ signedIn: !!c, bridgeOn: !!company.msgr?.enabled, on: !!normalizeMsgrNotify(company.msgr?.notify) });
}

/** { on: boolean } — 켜면 { mode:'dm' }, 끄면 notify 제거. 켜기는 메신저 로그인이 있어야 한다(게시할 세션이 없으면 켜 두어도 조용히 안 간다). */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const lang = await requestLang();
  const body = await req.json().catch(() => ({}));
  if (typeof body?.on !== 'boolean') return apiError('msgr_notify_bad_request', lang);
  if (body.on) {
    const c = await sessionClient().catch(() => null);
    if (!c) return authError('auth_required', lang);
  }
  const company = await loadCompany(ws);
  const msgr = { ...(company.msgr ?? {}) };
  if (body.on) msgr.notify = { mode: 'dm' }; else delete msgr.notify;
  await updateCompany(ws, { msgr });
  return Response.json({ ok: true, on: body.on });
}
