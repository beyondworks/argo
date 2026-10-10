// 팀 메신저 — 이 회사 크루를 조직에 등록/해제/조회. 서버가 아니라 **이 기기의 기기 세션(크루 소유자 JWT)**으로
// Supabase msgr_crews에 쓴다(RLS: owner_user_id = auth.uid()). 새 공개 API를 뚫지 않는다 — 조직·채널·메시지는 메신저 앱이 직접 다룬다.
// 등록이 하나라도 있으면 company.json.msgr.enabled=true → 게이트웨이 매니저가 브리지(폴러)·드레인 워커를 켠다(src/gateway.mjs).
import { guardCompany, csrfDenied, authError, requestLang } from '../../../../auth.mjs';
import { apiError } from '../../../../apimsg.mjs';
import { sessionClient } from '../../../../../src/gateway/msgr.mjs';
import { listAgents } from '../../../../../src/hub.mjs';
import { loadCompany, updateCompany } from '../../../../../src/workspace.mjs';
import { msgrGatewayStatus, msgrRuntimeState } from '../../../../../src/connections.mjs';
import { nudgeGateway } from '../../../../../src/gateway.mjs';
import { splitCardRows } from './card-rows.mjs'; // 행 나누기 — 카드 판정과 같은 모양을 테스트가 잠근다(UL10)

const ALLOW = new Set(['all', 'list', 'owner']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const upstream = (where, e, lang) => {
  if (/msgr_pro_required/.test(String(e?.message ?? ''))) return apiError('msgr_pro_required', lang); // 무료 계정이 파견 해제한 에이전트를 다시 파견(서버 관문 msgr_crews_pro_gate)
  console.error(`[argo] msgr ${where}:`, e?.message ?? e); return apiError('msgr_upstream', lang); // PG 원문은 화면이 아니라 로그로
};

const runtimeState = msgrRuntimeState; // 정본은 src/connections.mjs — 에이전트 상태 도구(argo_status messenger)가 같은 판정을 쓴다

const REG_COLS = 'id, org_id, slug, display_name, hosting, status, allow, allow_users, last_seen_at, msgr_orgs(name, slug)';
async function myRegistrations(c, ws) {
  const { data, error } = await c.client.from('msgr_crews')
    .select(REG_COLS)
    .eq('owner_user_id', c.uid).eq('ws_id', ws).not('org_id', 'is', null); // 조직 등록만 — 개인 공간 행(org NULL)은 이 카드의 연결·해제 판정 대상이 아니다(분리 검수 M2)
  if (error) throw new Error(error.message);
  return data ?? [];
}
/** 카드 조회용 — 같은 한 번의 조회로 조직 등록과 개인 공간 행 수를 함께 얻는다(호출 수 그대로). 개인 공간 행(org NULL)은
    연결·해제 판정에는 쓰지 않고 "개인 공간에 연결됨" 표시에만 쓴다(CX-12, 2026-10-05). */
async function myCardRows(c, ws) {
  const { data, error } = await c.client.from('msgr_crews')
    .select(REG_COLS)
    .eq('owner_user_id', c.uid).eq('ws_id', ws);
  if (error) throw new Error(error.message);
  return splitCardRows(data);
}
async function myOrgs(c) {
  const { data, error } = await c.client.from('msgr_org_members').select('org_id, role, msgr_orgs(id, name, slug)').eq('user_id', c.uid).is('removed_at', null); // 본인 행만(멤버 select 정책은 조직 전원 행을 준다 — 검수 MEDIUM-2)
  if (error) throw new Error(error.message);
  const orgs = (data ?? []).filter((m) => m.msgr_orgs).map((m) => ({ id: m.org_id, name: m.msgr_orgs.name, slug: m.msgr_orgs.slug, role: m.role }));
  if (!orgs.length) return orgs;
  // 조직별 멤버(허용 범위 '지정 멤버' 선택지) — 본인 제외, 표시명·역할만
  const { data: mems, error: e2 } = await c.client.from('msgr_org_members').select('org_id, user_id, role, display_name').in('org_id', orgs.map((o) => o.id)).is('removed_at', null);
  if (e2) throw new Error(e2.message);
  for (const o of orgs) o.members = (mems ?? []).filter((m) => m.org_id === o.id && m.user_id !== c.uid).map((m) => ({ id: m.user_id, name: m.display_name || m.user_id.slice(0, 8), role: m.role }));
  // 조직 정책(H-0): 허용 범위가 잠겼으면 카드가 선택지를 잠그고 정책값을 보여준다(서버 트리거 msgr_crew_policy_gate가 최종)
  const { data: pols } = await c.client.from('msgr_org_policies').select('org_id, allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by').in('org_id', orgs.map((o) => o.id));
  for (const o of orgs) o.policy = (pols ?? []).find((p) => p.org_id === o.id) ?? null;
  return orgs;
}
async function syncEnabled(ws, c) {
  let regs;
  try { regs = await myRegistrations(c, ws); } catch (e) { console.error('[argo] msgr 등록 조회 실패 — enabled 유지:', e.message); return []; } // 일시 오류로 브리지를 끄지 않는다
  // paused(무료 계정 일시 중지)만 남으면 꺼진다 — 켜 두면 Pro 재개 뒤 다음 틱에 바로 붙지만, 무료인 동안에도 브리지가 15초마다
  // myCrews·인벤토리 미러·커맨더 미러·기억 회수 조회를 계속 보낸다(drain의 하우스키핑은 활성 행 0이어도 돈다). 호출을 줄이려는 일시 중지라 끄는 쪽을 둔다.
  // 재개 뒤에는 설정의 연결을 한 번 더 누르면 켜진다(2026-10-10 #941 검수 LOW-3 판단).
  const enabled = regs.some((r) => r.status === 'active');
  const company = await loadCompany(ws);
  if (!!company.msgr?.enabled !== enabled) await updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), enabled } }));
  return regs;
}

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const c = await sessionClient().catch(() => null);
  if (!c) return Response.json({ signedIn: false, orgs: [], crews: [] });
  try {
    const [orgs, { crews, personalCount }, gateway] = await Promise.all([myOrgs(c), myCardRows(c, ws), msgrGatewayStatus(ws)]);
    return Response.json({ signedIn: true, uid: c.uid, orgs, crews, personalCount, runtime: runtimeState(gateway) });
  } catch (e) { return upstream('GET', e, await requestLang()); }
}

/** 등록 { orgId, slug, allow?, allowUsers? } — 크루 카드(agents/<slug>.md)가 있어야 한다. 이미 있으면 allow만 갱신. */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const lang = await requestLang();
  // 기본 'owner' — 조직 정책 테이블(부록 H-0) 전까지는 가장 좁게 시작하고 크루 시트/카드에서 연다(유건 결정 2026-09-03)
  const { orgId, slug, allow = 'owner', allowUsers = [], activate = false, reconnect = false, slugs = [] } = await req.json().catch(() => ({}));
  const users = Array.isArray(allowUsers) ? allowUsers : [];
  const wanted = Array.isArray(slugs) ? [...new Set(slugs.filter((v) => typeof v === 'string' && v))] : [];
  if (reconnect) {
    const c = await sessionClient().catch(() => null);
    if (!c) return Response.json({ ok: false, runtime: { state: 'login' } });
    const company = await loadCompany(ws);
    if (company.ownerId !== c.uid) return Response.json({ ok: false, runtime: { state: 'owner' } });
    const crews = await myRegistrations(c, ws);
    if (!crews.some((crew) => crew.status === 'active')) return Response.json({ ok: false, runtime: { state: 'noCrews' } });
    nudgeGateway(ws);
    return Response.json({ ok: true, runtime: { state: 'reconnecting' } });
  }
  if (activate) {
    if (!UUID.test(String(orgId ?? '')) || !wanted.length) return apiError('msgr_bad_request', lang);
    const agents = await listAgents(ws);
    const bySlug = new Map(agents.map((agent) => [agent.slug, agent]));
    if (wanted.some((wantedSlug) => !bySlug.has(wantedSlug))) return apiError('msgr_crew_not_found', lang);
    const c = await sessionClient().catch(() => null);
    if (!c) return authError('auth_required', lang);
    const existing = new Map((await myRegistrations(c, ws)).filter((r) => r.org_id === orgId).map((r) => [r.slug, r]));
    for (const wantedSlug of wanted) {
      const prior = existing.get(wantedSlug);
      if (prior?.status === 'active') continue;
      const agent = bySlug.get(wantedSlug);
      const base = { display_name: agent.name || wantedSlug, role_text: agent.role || null, hosting: process.env.ARGO_TENANT_OWNER ? 'resident' : 'local' };
      if (prior) {
        const { error } = await c.client.from('msgr_crews').update({ ...base, status: 'active' }).eq('id', prior.id);
        if (error) return upstream('POST activate update', error, lang);
      } else {
        const row = { org_id: orgId, owner_user_id: c.uid, ws_id: ws, slug: wantedSlug, ...base, status: 'active', allow: 'owner', allow_users: [] };
        const { error } = await c.client.from('msgr_crews').insert(row);
        if (error && error.code !== '23505') return upstream('POST activate insert', error, lang);
      }
    }
    const crews = await syncEnabled(ws, c);
    // 무료 계정은 서버 관문이 행을 조용히 paused로 둔다(옛 미러가 같은 쓰기를 되풀이하지 않게) — 사람이 누른 연결이면 이유를 보인다
    if (crews.some((r) => r.org_id === orgId && wanted.includes(r.slug) && r.status === 'paused')) return apiError('msgr_pro_required', lang);
    return Response.json({ ok: true, crews });
  }
  if (!UUID.test(String(orgId ?? '')) || !slug || !ALLOW.has(allow) || !users.every((u) => UUID.test(String(u)))) return apiError('msgr_bad_request', lang);
  const agent = (await listAgents(ws)).find((a) => a.slug === slug);
  if (!agent) return apiError('msgr_crew_not_found', lang);
  const c = await sessionClient().catch(() => null);
  if (!c) return authError('auth_required', lang);
  const row = {
    org_id: orgId, owner_user_id: c.uid, ws_id: ws, slug, display_name: agent.name || slug, role_text: agent.role || null,
    hosting: process.env.ARGO_TENANT_OWNER ? 'resident' : 'local', status: 'active', allow,
    allow_users: users.slice(0, 200),
  };
  const { data, error } = await c.client.from('msgr_crews').upsert(row, { onConflict: 'org_id,owner_user_id,ws_id,slug' }).select('id, status').single();
  if (error) return upstream('POST', error, lang);
  const crews = await syncEnabled(ws, c);
  // 무료 계정 — 서버 관문이 상태를 paused(새 행·멈춘 행)로 두거나 원래 상태(available·detached)로 유지한다. 행·허용 범위는 저장되고 연결만 Pro 뒤.
  // 'active'로 올렸는데 active가 아니면 관문 말고는 그렇게 되는 길이 없지만, 요금제 판정을 한 번 더 확인해 다른 사유를 요금제로 안내하지 않는다.
  if (data.status !== 'active') {
    const { data: pro, error: proErr } = await c.client.rpc('is_pro');
    if (!proErr && pro === false) return apiError('msgr_pro_required', lang);
  }
  return Response.json({ ok: true, id: data.id, crews });
}

/** 해제 { orgId, slug } — 행 삭제(감사는 서버 트리거 몫). 마지막 등록이 사라지면 브리지도 꺼진다. */
export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const lang = await requestLang();
  const { orgId, slug } = await req.json().catch(() => ({}));
  if (!UUID.test(String(orgId ?? '')) || !slug) return apiError('msgr_bad_request', lang);
  const c = await sessionClient().catch(() => null);
  if (!c) return authError('auth_required', lang);
  const { error } = await c.client.from('msgr_crews').delete().eq('org_id', orgId).eq('owner_user_id', c.uid).eq('ws_id', ws).eq('slug', slug);
  if (error) return upstream('DELETE', error, lang);
  const crews = await syncEnabled(ws, c);
  return Response.json({ ok: true, crews });
}
