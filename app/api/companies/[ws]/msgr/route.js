// 팀 메신저 — 이 회사 크루를 조직에 등록/해제/조회. 서버가 아니라 **이 기기의 기기 세션(크루 소유자 JWT)**으로
// Supabase msgr_crews에 쓴다(RLS: owner_user_id = auth.uid()). 새 공개 API를 뚫지 않는다 — 조직·채널·메시지는 메신저 앱이 직접 다룬다.
// 등록이 하나라도 있으면 company.json.msgr.enabled=true → 게이트웨이 매니저가 브리지(폴러)·드레인 워커를 켠다(src/gateway.mjs).
import { guardCompany, csrfDenied, authError, requestLang } from '../../../../auth.mjs';
import { sessionClient } from '../../../../../src/gateway/msgr.mjs';
import { listAgents } from '../../../../../src/hub.mjs';
import { loadCompany, updateCompany } from '../../../../../src/workspace.mjs';

const ALLOW = new Set(['all', 'list', 'owner']);

async function myRegistrations(c, ws) {
  const { data, error } = await c.client.from('msgr_crews')
    .select('id, org_id, slug, display_name, hosting, status, allow, allow_users, last_seen_at, msgr_orgs(name, slug)')
    .eq('owner_user_id', c.uid).eq('ws_id', ws);
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function myOrgs(c) {
  const { data, error } = await c.client.from('msgr_org_members').select('org_id, role, msgr_orgs(id, name, slug)').is('removed_at', null);
  if (error) throw new Error(error.message);
  return (data ?? []).filter((m) => m.msgr_orgs).map((m) => ({ id: m.org_id, name: m.msgr_orgs.name, slug: m.msgr_orgs.slug, role: m.role }));
}
async function syncEnabled(ws, c) {
  const regs = await myRegistrations(c, ws).catch(() => []);
  const enabled = regs.some((r) => r.status === 'active');
  const company = await loadCompany(ws);
  if (!!company.msgr?.enabled !== enabled) await updateCompany(ws, { msgr: { ...(company.msgr ?? {}), enabled } });
  return regs;
}

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const c = await sessionClient().catch(() => null);
  if (!c) return Response.json({ signedIn: false, orgs: [], crews: [] });
  try {
    const [orgs, crews] = await Promise.all([myOrgs(c), myRegistrations(c, ws)]);
    return Response.json({ signedIn: true, uid: c.uid, orgs, crews });
  } catch (e) { return Response.json({ error: e.message }, { status: 502 }); }
}

/** 등록 { orgId, slug, allow?, allowUsers? } — 크루 카드(agents/<slug>.md)가 있어야 한다. 이미 있으면 allow만 갱신. */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const { orgId, slug, allow = 'all', allowUsers = [] } = await req.json().catch(() => ({}));
  if (!orgId || !slug || !ALLOW.has(allow)) return Response.json({ error: 'orgId·slug·allow(all|list|owner)가 필요합니다' }, { status: 400 });
  const agent = (await listAgents(ws)).find((a) => a.slug === slug);
  if (!agent) return Response.json({ error: '크루가 없습니다' }, { status: 404 });
  const c = await sessionClient().catch(() => null);
  if (!c) return authError('auth_required', await requestLang());
  const row = {
    org_id: orgId, owner_user_id: c.uid, ws_id: ws, slug, display_name: agent.name || slug, role_text: agent.role || null,
    hosting: process.env.ARGO_TENANT_OWNER ? 'resident' : 'local', status: 'active', allow,
    allow_users: Array.isArray(allowUsers) ? allowUsers.filter((u) => typeof u === 'string').slice(0, 200) : [],
  };
  const { data, error } = await c.client.from('msgr_crews').upsert(row, { onConflict: 'org_id,owner_user_id,ws_id,slug' }).select('id').single();
  if (error) return Response.json({ error: error.message }, { status: 502 });
  const crews = await syncEnabled(ws, c);
  return Response.json({ ok: true, id: data.id, crews });
}

/** 해제 { orgId, slug } — 행 삭제(감사는 서버 트리거 몫). 마지막 등록이 사라지면 브리지도 꺼진다. */
export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const { orgId, slug } = await req.json().catch(() => ({}));
  if (!orgId || !slug) return Response.json({ error: 'orgId·slug가 필요합니다' }, { status: 400 });
  const c = await sessionClient().catch(() => null);
  if (!c) return authError('auth_required', await requestLang());
  const { error } = await c.client.from('msgr_crews').delete().eq('org_id', orgId).eq('owner_user_id', c.uid).eq('ws_id', ws).eq('slug', slug);
  if (error) return Response.json({ error: error.message }, { status: 502 });
  const crews = await syncEnabled(ws, c);
  return Response.json({ ok: true, crews });
}
