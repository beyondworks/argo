// 알림 받을 메신저 — GET { signedIn, channels: { msgr|telegram|slack: { connected, on } } }, POST { kind, on }.
// 아르고 메신저 = company.json.msgr.notify { mode:'dm' }(src/msgr-notify.mjs), 텔레그램·슬랙 = connections.<kind>.mutedEvents 비움(켬)/전부(끔).
import { guardCompany, csrfDenied, authError, requestLang } from '../../../../../auth.mjs';
import { apiError } from '../../../../../apimsg.mjs';
import { sessionClient } from '../../../../../../src/gateway/msgr.mjs';
import { loadCompany, updateCompany } from '../../../../../../src/workspace.mjs';
import { loadConnections, updateConnection } from '../../../../../../src/connections.mjs';
import { CHANNEL_EVENTS } from '../../../../../../src/channel-events.mjs';
import { notifyChannelState } from '../../../../../../src/msgr-notify.mjs';

async function state(ws) {
  const [company, connections, c] = await Promise.all([loadCompany(ws).catch(() => ({})), loadConnections(ws), sessionClient().catch(() => null)]);
  return { signedIn: !!c, channels: notifyChannelState({ connections, company, signedIn: !!c }) };
}

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  return Response.json(await state(ws));
}

/** { kind:'msgr'|'telegram'|'slack', on:boolean }. 아르고 메신저 켜기는 메신저 로그인이 있어야 한다(게시할 세션이 없으면 켜 두어도 조용히 안 간다); 끄기는 언제나 된다. */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const lang = await requestLang();
  const body = await req.json().catch(() => ({}));
  const kind = body?.kind ?? 'msgr';
  if (typeof body?.on !== 'boolean' || !['msgr', 'telegram', 'slack'].includes(kind)) return apiError('msgr_notify_bad_request', lang);
  if (kind === 'msgr') {
    if (body.on && !(await sessionClient().catch(() => null))) return authError('auth_required', lang);
    const company = await loadCompany(ws);
    const msgr = { ...(company.msgr ?? {}) };
    if (body.on) msgr.notify = { mode: 'dm' }; else delete msgr.notify;
    await updateCompany(ws, { msgr });
  } else {
    await updateConnection(ws, kind, { mutedEvents: body.on ? [] : [...CHANNEL_EVENTS[kind]] });
  }
  return Response.json({ ok: true, ...(await state(ws)) });
}
