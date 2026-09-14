// 회사 단위 메신저 알림 목적지 — GET 후보 방·현재 값, POST 저장(검증 뒤) 또는 { off: true } 로 끔. 저장 정본은 company.json.msgr.notify(src/msgr-notify.mjs).
import { guardCompany, csrfDenied, authError, requestLang } from '../../../../../auth.mjs';
import { apiError } from '../../../../../apimsg.mjs';
import { sessionClient } from '../../../../../../src/gateway/msgr.mjs';
import { loadCompany, updateCompany } from '../../../../../../src/workspace.mjs';
import { MSGR_NOTIFY_EVENTS, normalizeMsgrNotify, msgrNotifyOptions } from '../../../../../../src/msgr-notify.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const company = await loadCompany(ws).catch(() => ({}));
  let notify = null; try { notify = normalizeMsgrNotify(company.msgr?.notify); } catch { notify = null; }
  const c = await sessionClient().catch(() => null);
  if (!c) return Response.json({ signedIn: false, rooms: [], events: MSGR_NOTIFY_EVENTS, notify });
  try {
    const rooms = await msgrNotifyOptions(ws, { session: async () => c });
    return Response.json({ signedIn: true, rooms, events: MSGR_NOTIFY_EVENTS, notify });
  } catch {
    return Response.json({ signedIn: true, rooms: [], events: MSGR_NOTIFY_EVENTS, notify, error: 'rooms_unavailable' }, { status: 503 });
  }
}

/** { orgId, channelId, events } — 후보 방 안에 있어야 저장한다(다른 조직·닫힌 방으로 조용히 가지 않게). { off: true } 면 끈다(클라 api()는 POST 한 가지라 DELETE 대신). */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const lang = await requestLang();
  const body = await req.json().catch(() => ({}));
  if (body?.off === true) {
    const company = await loadCompany(ws); const msgr = { ...(company.msgr ?? {}) }; delete msgr.notify;
    await updateCompany(ws, { msgr });
    return Response.json({ ok: true, notify: null });
  }
  let notify;
  try { notify = normalizeMsgrNotify(body); } catch { return apiError('msgr_notify_bad_request', lang); }
  if (!notify) return apiError('msgr_notify_bad_request', lang);
  const c = await sessionClient().catch(() => null);
  if (!c) return authError('auth_required', lang);
  const rooms = await msgrNotifyOptions(ws, { session: async () => c }).catch(() => []);
  if (!rooms.some((r) => r.orgId === notify.orgId && r.channelId === notify.channelId)) return apiError('msgr_notify_bad_request', lang);
  const company = await loadCompany(ws);
  await updateCompany(ws, { msgr: { ...(company.msgr ?? {}), notify } });
  return Response.json({ ok: true, notify });
}
