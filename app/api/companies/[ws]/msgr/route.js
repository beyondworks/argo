// 팀 메신저 — 이 회사 크루를 조직에 등록/해제/조회. 서버가 아니라 **이 기기의 기기 세션(크루 소유자 JWT)**으로
// Supabase msgr_crews에 쓴다(RLS: owner_user_id = auth.uid()). 새 공개 API를 뚫지 않는다 — 조직·채널·메시지는 메신저 앱이 직접 다룬다.
// 연결된 행(조직 등록 또는 개인 공간)이 하나라도 있으면 company.json.msgr.enabled=true → 게이트웨이 매니저가 브리지(폴러)·드레인 워커를 켠다(src/gateway.mjs).
import { guardCompany, csrfDenied, authError, requestLang } from '../../../../auth.mjs';
import { apiError } from '../../../../apimsg.mjs';
import { sessionClient, appMeetsMin } from '../../../../../src/gateway/msgr.mjs';
import { listAgents } from '../../../../../src/hub.mjs';
import { loadCompany, updateCompany, getDeviceId } from '../../../../../src/workspace.mjs';
import { msgrGatewayStatus, msgrRuntimeState } from '../../../../../src/connections.mjs';
import { nudgeGateway } from '../../../../../src/gateway.mjs';
import { splitCardRows } from './card-rows.mjs'; // 행 나누기 — 카드 판정과 같은 모양을 테스트가 잠근다(UL10)
import { freeAgentReason, readAgentPause, swapNotes } from './free-reason.mjs'; // 무료 계정 연결이 멈춘 이유·교체 안내(2026-10-11)
import { keepPlan } from './keep-plan.mjs';
import { setupFacts, zeroRowsReconnect } from './setup-facts.mjs'; // 행 0개일 때 이유(계정·소유자·연결 준비) — 소유자·계정 조건만 자동 켜기와 같다 // 유지할 에이전트 적용 판정(새로 넣을 행·함께 연결할 행·거절) — 행동 시험이 잠근다

const ALLOW = new Set(['all', 'list', 'owner']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const upstream = (where, e, lang) => {
  const m = String(e?.message ?? '');
  // 무료 계정이 파견 해제한 에이전트를 다시 파견(서버 관문 msgr_crews_pro_gate) — 앞 코드가 이유(20261011120000), 뒤의 msgr_pro_required는 옛 앱용
  if (/msgr_free_agent_limit/.test(m)) return apiError('msgr_free_agent_limit', lang);
  if (/msgr_app_update_required/.test(m)) return apiError('msgr_app_update_required', lang);
  if (/msgr_pro_required/.test(m)) return apiError('msgr_pro_required', lang);
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
/** 이 회사의 내 행 전부(조직 등록 + 개인 공간) — 카드 조회와 브리지 켜기 판정이 같은 한 건을 쓴다(syncEnabled는 종전 조직 등록 조회 대신이라 호출 수 그대로). */
async function myBridgeRows(c, ws) {
  const { data, error } = await c.client.from('msgr_crews').select(REG_COLS).eq('owner_user_id', c.uid).eq('ws_id', ws);
  if (error) throw new Error(error.message);
  return data ?? [];
}
/** 카드 조회용 — 같은 한 번의 조회로 조직 등록과 개인 공간 행 수를 함께 얻는다(호출 수 그대로). 개인 공간 행(org NULL)은
    연결·해제 판정에는 쓰지 않고 "개인 공간에 연결됨" 표시에만 쓴다(CX-12, 2026-10-05). */
async function myCardRows(c, ws) {
  return splitCardRows(await myBridgeRows(c, ws));
}
/** 이 회사의 내 개인 공간 행(org_id NULL) — 조직이 없는 사용자의 개인 공간 연결(검수 스택 화면 4차). 행은 게이트웨이(미러)가 만든다. */
async function myPersonalRows(c, ws) {
  const { data, error } = await c.client.from('msgr_crews').select('id, org_id, slug, display_name, hosting, status, allow, allow_users')
    .eq('owner_user_id', c.uid).eq('ws_id', ws).is('org_id', null);
  if (error) throw new Error(error.message);
  return data ?? [];
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
async function syncEnabled(ws, c) { return (await syncBridge(ws, c)).regs; }
/** 브리지 값 맞추기 → { regs: 조직 등록, enabled: 판정(조회 실패면 null — 값을 건드리지 않았다) }. rows = 이미 읽은 이 회사의 내 행(다시 연결 — 같은 조회를 두 번 하지 않게) */
async function syncBridge(ws, c, read = null) {
  let rows = read;
  if (!rows) try { rows = await myBridgeRows(c, ws); } catch (e) { console.error('[argo] msgr 등록 조회 실패 — enabled 유지:', e.message); return { regs: [], enabled: null }; } // 일시 오류로 브리지를 끄지 않는다
  const regs = rows.filter((r) => r.org_id != null); // 돌려주는 값은 종전대로 조직 등록만(카드의 연결·해제 판정)
  // 브리지 판정에는 개인 공간 행(org NULL)도 센다(2026-10-12 재현) — 개인 공간 에이전트도 브리지가 답한다. 조직 등록만 세면 조직 없는 계정의
  //   [유지할 에이전트 고르기](#966)가 브리지를 껐고, 모두 연결된 계정은 자동 켜기(autoEnableMsgr — 크루 행이 있으면 멈춘 행이 있을 때만)도 다시 켜지 않았다.
  // paused(무료 계정 일시 중지 #941)만 남은 회사도 켠다(2026-10-11) — 최신 앱은 브리지가 돌아야 기기 심박(앱 버전)이 나가고, 서버가 그 심박을 보고 무료 계정
  // 에이전트를 4명까지 재개한다(20261011120000). 단 이 앱이 서버가 정한 최소 버전(#943 실시간 방식 포함 발행) 이상일 때만 — 아니면 #941처럼 꺼 둔다(검수 #945 MEDIUM-2).
  let enabled = rows.some((r) => r.status === 'active');
  if (!enabled && rows.some((r) => r.status === 'paused')) {
    const info = await readAgentPause(c.client).catch(() => null);
    if (!info) return { regs, enabled: null }; // 최소 버전을 못 읽으면(RPC 실패·옛 서버) 판정하지 않고 값을 쓰지 않는다 — 옛 앱으로 오판해 돌던 브리지를 끄지 않게(검수 1 LOW-1)
    enabled = appMeetsMin(info.min_app);
  }
  const company = await loadCompany(ws);
  if (!!company.msgr?.enabled !== enabled) await updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), enabled } }));
  return { regs, enabled };
}

/** 이 기기의 새 앱 심박 한 번(앱 버전) — 이 회사의 내 조직 행(상태 무관 — 기기 행이 서려면 행이 있어야 한다)으로. 서버가 재개 신호를 주면 makeDb.heartbeat가 재개까지 부른다. */
async function beatNow(c, ws) {
  const deviceId = await getDeviceId().catch(() => null);
  const ids = [...(await myRegistrations(c, ws).catch(() => [])), ...(await myPersonalRows(c, ws).catch(() => []))].map((r) => r.id); // 개인 공간만 쓰는 사용자도(4차)
  if (!deviceId || !ids.length) return false;
  await c.db.heartbeat(ids, { wsId: ws, deviceId });
  return true;
}
/** 무료 계정의 연결이 멈춘 채 남았을 때 이유(free-reason.mjs) — 서버가 이 기기의 새 앱을 아직 모르면 심박 한 번(앱 버전)을 보낸다. → { code, crews? } */
async function freeAgentReasonFor(c, ws) {
  const { code, beaten } = await freeAgentReason(c.client, { beatNow: () => beatNow(c, ws) });
  return { code, crews: beaten ? await syncEnabled(ws, c) : undefined };
}

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const c = await sessionClient().catch(() => null);
  if (!c) return Response.json({ signedIn: false, orgs: [], crews: [] });
  try {
    const [orgs, { crews, personalCount, personal }, gateway] = await Promise.all([myOrgs(c), myCardRows(c, ws), msgrGatewayStatus(ws)]);
    // 멈춘 행(무료 계정 한도)의 이유 — 카드 줄 문구(msgr-card.mjs pausedLabelKey). 멈춘 행이 있을 때만 읽는다(카드의 8초 폴에 호출을 늘리지 않게, 화면 검수 B)
    const pause = [...crews, ...personal].some((r) => r.status === 'paused') ? await readAgentPause(c.client).catch(() => null) : null;
    const pauseReason = pause?.reason ?? null;
    const pauseAppOk = pause ? appMeetsMin(pause.min_app) : undefined; // 이 앱이 무료 최소 버전 이상인가 — 카드가 app·off를 "곧 연결"로 읽을지(D3, msgr-card.mjs pauseSoon). 같은 응답에서 — 호출 추가 0
    // 내 행이 하나도 없으면 왜 없는지 — 회사 파일 읽기 + (조직이 없을 때) 메신저 프로필 조회 1건. 행이 있으면 0건(카드 8초 폴은 행이 있을 때만 돈다)
    const setup = await setupFacts({ rows: [...crews, ...personal], orgCount: orgs.length, company: await loadCompany(ws).catch(() => null), uid: c.uid, hasProfile: () => c.db.hasMsgrProfile(c.uid) });
    return Response.json({ signedIn: true, uid: c.uid, email: c.email ?? '', orgs, crews, personalCount, personal, pauseReason, pauseAppOk, setup, runtime: runtimeState(gateway) });
  } catch (e) { return upstream('GET', e, await requestLang()); }
}

/** 등록 { orgId, slug, allow?, allowUsers? } — 크루 카드(agents/<slug>.md)가 있어야 한다. 이미 있으면 allow만 갱신. */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const cs = await csrfDenied(req); if (cs) return cs;
  const lang = await requestLang();
  // 기본 'owner' — 조직 정책 테이블(부록 H-0) 전까지는 가장 좁게 시작하고 크루 시트/카드에서 연다(유건 결정 2026-09-03)
  const { orgId, slug, allow = 'owner', allowUsers = [], activate = false, reconnect = false, slugs = [], personal = false, preview = false, keepList = false, keep = null, add = [] } = await req.json().catch(() => ({}));
  const users = Array.isArray(allowUsers) ? allowUsers : [];
  const wanted = Array.isArray(slugs) ? [...new Set(slugs.filter((v) => typeof v === 'string' && v))] : [];
  if (reconnect) {
    const c = await sessionClient().catch(() => null);
    if (!c) return Response.json({ ok: false, runtime: { state: 'login' } });
    const company = await loadCompany(ws);
    if (company.ownerId !== c.uid) return Response.json({ ok: false, runtime: { state: 'owner' } });
    // 개인 공간 행도 센다(분리 검수 MEDIUM-1, 2026-10-12) — 조직 등록만 세면 조직 없는 계정은 늘 noCrews였고, 이미 꺼진 브리지(enabled=false)를
    //   되살릴 길이 없었다(자동 켜기도 크루 행이 있고 멈춘 행이 없으면 켜지 않는다). 다시 연결은 브리지 값을 행 상태에 맞춘 뒤 깨운다.
    const crews = await myBridgeRows(c, ws);
    if (!crews.length && !company.msgr?.nodeOrgId) { // 행이 하나도 없다 — 자동 켜기(10분에 한 번)를 기다리지 않고 사람이 누른 지금 켠다. 소유자·계정 조건은 자동 켜기와 같다(setup-facts.mjs). 회사 노드는 미러가 행을 만들지 않아 종전대로 noCrews
      const orgCount = (await c.db.myOrgIds(c.uid).catch(() => [])).length;
      const go = zeroRowsReconnect({ owner: true, orgCount, profile: orgCount ? null : await c.db.hasMsgrProfile(c.uid).then((v) => !!v, () => null) });
      if (go === 'account') return Response.json({ ok: false, runtime: { state: 'account' } });
      if (!company.msgr?.enabled) await updateCompany(ws, (cur) => (cur.msgr?.enabled ? {} : { msgr: { ...(cur.msgr ?? {}), enabled: true } }));
      nudgeGateway(ws); // 같은 sync에서 브리지가 시작되고 미러가 개인·조직 행을 만든다
      return Response.json({ ok: true, runtime: { state: 'reconnecting' } });
    }
    if (!crews.some((crew) => crew.status === 'active' || crew.status === 'paused')) return Response.json({ ok: false, runtime: { state: 'noCrews' } }); // paused = 무료 계정 — 브리지가 돌아야 재개된다(syncEnabled)
    // 사람이 누를 때만 — 위 조회 1건을 그대로 쓰고 + (멈춘 행만이면) rpc 1건 + 값이 바뀔 때만 쓰기 1건.
    // 멈춘 행만 있고 이 앱이 최소 버전 미만이면 브리지를 꺼 둔다(#945 MEDIUM-2) — '다시 연결하는 중'이 아니라 업데이트 안내로 답한다(재검수 LOW-A)
    const { enabled } = await syncBridge(ws, c, crews);
    if (enabled === false) return apiError('msgr_app_update_required', lang); // 판정 못 함(null)은 종전처럼 깨우기만 한다
    nudgeGateway(ws);
    return Response.json({ ok: true, runtime: { state: 'reconnecting' } });
  }
  // 교체 미리 알림(검수 스택 화면 4차 — 연결을 누르면 무엇이 멈추는지) — 관문과 같은 순서의 서버 판정(msgr_free_swap_preview). 읽기 1건, 연결을 누를 때만.
  //   Pro·새 앱 없음·자리 남음·옛 서버(함수 없음)·오류는 빈 목록(확인 없이 종전대로 연결).
  if (preview) {
    const agents = await listAgents(ws);
    const known = wanted.filter((s) => agents.some((a) => a.slug === s));
    const c = await sessionClient().catch(() => null);
    if (!c || !known.length) return Response.json({ ok: true, victims: [] });
    const { data, error } = await c.client.rpc('msgr_free_swap_preview', { p_ws: ws, p_slugs: known });
    return Response.json({ ok: true, victims: error ? [] : [...new Set((data ?? []).filter(Boolean))] });
  }
  // 무료 계정이 유지할 에이전트 고르기(유건 2026-10-12, 제보 "12명 중 5~8·9~12번만 번갈아 연결") — 종전 일괄 연결은 빠진 에이전트를 하나씩 연결해
  //   한도가 차 있으면 연결할 때마다 서버가 가장 오래 고르지 않은 것을 멈췄고, 매번 목록의 마지막 4명만 남았다. 이제 자리가 모자라면 사람이 고른다.
  // 1) 고를 거리 — 내 사람 에이전트 전체(한도는 계정 전체라 다른 회사 것도) + 플랜. 읽기 2건, 사람이 연결을 누를 때·고르기를 열 때만(카드 폴과 무관).
  if (keepList) {
    const c = await sessionClient().catch(() => null);
    if (!c) return authError('auth_required', lang);
    const [rows, plan] = await Promise.all([
      c.client.from('msgr_crews').select('id, ws_id, slug, display_name, status, hosting, owner_user_id').eq('owner_user_id', c.uid).neq('hosting', 'bot').in('status', ['active', 'paused']),
      c.client.rpc('my_plan'),
    ]);
    if (rows.error) return upstream('POST keepList', rows.error, lang);
    return Response.json({ ok: true, uid: c.uid, plan: plan.error ? null : (plan.data?.plan ?? null), rows: rows.data ?? [] });
  }
  // 2) 적용 { keep: ['회사:이름', …], orgId? | personal? } — 서버 함수 msgr_free_keep 한 번(고르지 않은 것은 멈춤 — 채널 참여·기억 보존, 고른 멈춘 것은 재개).
  //    이 회사에서 고른 에이전트에 조직 행이 없으면 멈춘 행으로 먼저 넣는다(연결 단추와 같은 1단계). 파견 해제(available) 행은 함께 연결할 행으로 넘긴다.
  if (Array.isArray(keep)) {
    if (!personal && !UUID.test(String(orgId ?? ''))) return apiError('msgr_bad_request', lang);
    const agents = await listAgents(ws);
    const c = await sessionClient().catch(() => null);
    if (!c) return authError('auth_required', lang);
    const orgRows = personal ? [] : (await myRegistrations(c, ws)).filter((r) => r.org_id === orgId);
    const plan = keepPlan({ keep, add, ws, personal, orgId, agents, existing: new Set(orgRows.map((r) => r.slug)), scope: personal ? await myPersonalRows(c, ws) : orgRows });
    if (plan.error) return apiError(plan.error, lang);
    const bySlug = new Map(agents.map((agent) => [agent.slug, agent]));
    for (const s of plan.inserts) {
      const a = bySlug.get(s);
      const { error } = await c.client.from('msgr_crews').insert({ org_id: orgId, owner_user_id: c.uid, ws_id: ws, slug: s, display_name: a.name || s, role_text: a.role || null,
        hosting: process.env.ARGO_TENANT_OWNER ? 'resident' : 'local', status: 'paused', allow: 'owner', allow_users: [] });
      if (error && error.code !== '23505') return upstream('POST keep insert', error, lang);
    }
    const info = await readAgentPause(c.client).catch(() => null); // 연결 갈래와 같다 — 서버가 이 기기의 새 앱을 모르면 심박 한 번(관문이 새 앱을 요구)
    if ((info?.reason === 'app' || info?.reason === 'off') && appMeetsMin(info.min_app)) await beatNow(c, ws).catch((e) => console.warn('[argo] msgr 새 앱 심박 실패:', e?.message ?? e));
    const { keys, act } = plan;
    const { data, error } = await c.client.rpc('msgr_free_keep', { p_keep: keys, p_activate: act });
    if (error) {
      if (error.code === 'PGRST202') return Response.json({ ok: false, unavailable: true }); // 옛 서버(함수 없음) — 화면이 종전 '멈추고 연결'로 돌아간다
      if (/msgr_bad_member/.test(String(error.message ?? ''))) return apiError('msgr_bad_request', lang);
      return upstream('POST keep', error, lang);
    }
    const crews = await syncEnabled(ws, c);
    return Response.json({ ok: true, crews, personal: personal ? await myPersonalRows(c, ws) : undefined, result: data ?? null });
  }
  // 개인 공간 연결(조직이 없는 사용자 — 검수 스택 화면 4차): 게이트웨이(미러)가 넣은 개인 행 중 멈춘 행을 사람의 연결(→active)로 — 관문·sweep·교체 안내가
  //   조직 행과 같은 길(PG 시험 [4차]). 행을 새로 넣지 않는다(개인 행은 미러가 만든다). 상태만 바꿔 허용 범위·이름은 그대로.
  if (activate && personal) {
    if (!wanted.length) return apiError('msgr_bad_request', lang);
    const agents = await listAgents(ws);
    if (wanted.some((s) => !agents.some((a) => a.slug === s))) return apiError('msgr_crew_not_found', lang);
    const c = await sessionClient().catch(() => null);
    if (!c) return authError('auth_required', lang);
    const info = await readAgentPause(c.client).catch(() => null); // 조직 갈래 2)와 같다 — 서버가 이 기기의 새 앱을 모르면 심박 한 번
    if ((info?.reason === 'app' || info?.reason === 'off') && appMeetsMin(info.min_app)) await beatNow(c, ws).catch((e) => console.warn('[argo] msgr 새 앱 심박 실패:', e?.message ?? e));
    const mine = (rows) => rows.filter((r) => wanted.includes(r.slug));
    for (const r of mine(await myPersonalRows(c, ws))) {
      if (r.status !== 'paused') continue; // 멈춘 행만 — 메신저에서 사람이 해제한(available) 개인 에이전트는 그 사람이 다시 켠다(재검수 LOW-1: 묶어 켜면 다른 에이전트를 교체)
      const { error } = await c.client.from('msgr_crews').update({ status: 'active' }).eq('id', r.id);
      if (error) return upstream('POST personal activate', error, lang);
    }
    let rows = await myPersonalRows(c, ws);
    const swapped = await swapNotes(c.client, mine(rows).map((r) => r.id)).catch(() => []);
    if (mine(rows).some((r) => r.status === 'paused')) { // 새 앱이 없으면 관문이 조용히 멈춘 채 둔다 — 이유를 보인다(조직 갈래와 같다)
      const why = await freeAgentReasonFor(c, ws);
      if (why.crews) rows = await myPersonalRows(c, ws);
      if (why.code && mine(rows).some((r) => r.status === 'paused')) return apiError(why.code, lang);
    }
    return Response.json({ ok: true, personal: rows, swapped });
  }
  if (activate) {
    if (!UUID.test(String(orgId ?? '')) || !wanted.length) return apiError('msgr_bad_request', lang);
    const agents = await listAgents(ws);
    const bySlug = new Map(agents.map((agent) => [agent.slug, agent]));
    if (wanted.some((wantedSlug) => !bySlug.has(wantedSlug))) return apiError('msgr_crew_not_found', lang);
    const c = await sessionClient().catch(() => null);
    if (!c) return authError('auth_required', lang);
    const existing = new Map((await myRegistrations(c, ws)).filter((r) => r.org_id === orgId).map((r) => [r.slug, r]));
    const baseOf = (wantedSlug) => { const agent = bySlug.get(wantedSlug); return { display_name: agent.name || wantedSlug, role_text: agent.role || null, hosting: process.env.ARGO_TENANT_OWNER ? 'resident' : 'local' }; };
    // 1) 없는 행은 멈춘 행(paused)으로 먼저 넣는다 — 아래 연결(paused→active)이 서버 관문에서 '사람의 연결'로 판정되게(무료 계정: 고른 순간 기록·4명이면 교체, 검수 #945).
    //    available(연결 해제)로 넣으면 새 앱이 없어 연결이 거절될 때 사람이 해제한 행으로 남아 카드가 '파견 해제됨', 새 앱이 와도 재개되지 않았다(분리 검수 3차 ①).
    //    paused면 거절돼도 멈춘 채 남고(이유 app·off — 카드 '멈춤 · …'), 새 앱 심박 뒤 sweep이 고른 순서대로 재개한다. Pro는 관문이 그대로 연결(재개 처리 포함).
    for (const wantedSlug of wanted) {
      if (existing.has(wantedSlug)) continue;
      const row = { org_id: orgId, owner_user_id: c.uid, ws_id: ws, slug: wantedSlug, ...baseOf(wantedSlug), status: 'paused', allow: 'owner', allow_users: [] };
      const { error } = await c.client.from('msgr_crews').insert(row);
      if (error && error.code !== '23505') return upstream('POST activate insert', error, lang);
    }
    // 2) 무료 계정이고 서버가 이 기기의 새 앱을 아직 모르면(브리지가 꺼져 있었음) 심박 한 번 — 이 화면 자신이 최신 앱이다(최소 버전 이상일 때만)
    const info = await readAgentPause(c.client).catch(() => null);
    if ((info?.reason === 'app' || info?.reason === 'off') && appMeetsMin(info.min_app)) await beatNow(c, ws).catch((e) => console.warn('[argo] msgr 새 앱 심박 실패:', e?.message ?? e));
    // 3) 연결
    const rows = new Map((await myRegistrations(c, ws)).filter((r) => r.org_id === orgId).map((r) => [r.slug, r]));
    for (const wantedSlug of wanted) {
      const prior = rows.get(wantedSlug);
      if (prior?.status === 'active') continue;
      if (!prior) continue; // 넣기가 실패하지 않았는데 행이 없으면(동시 삭제) 건너뛴다
      const base = baseOf(wantedSlug); // 되살린 크루는 기존 허용 범위를 보존 — 이름·역할·실행 위치만 다시 쓴다
      const { error } = await c.client.from('msgr_crews').update({ ...base, status: 'active' }).eq('id', prior.id);
      if (error) return upstream('POST activate update', error, lang);
    }
    let crews = await syncEnabled(ws, c);
    // 4) 무료 계정 4명이 차 있어 다른 에이전트를 멈췄으면 알린다(교체 — 서버 msgr_agent_swap_notes)
    const swapped = await swapNotes(c.client, crews.filter((r) => r.org_id === orgId && wanted.includes(r.slug)).map((r) => r.id)).catch(() => []);
    // 새 앱이 없을 때의 paused→active는 서버 관문이 행을 조용히 paused로 둔다(옛 미러가 같은 쓰기를 되풀이하지 않게) — 사람이 누른 연결이면 이유를 보인다
    if (crews.some((r) => r.org_id === orgId && wanted.includes(r.slug) && r.status === 'paused')) {
      const why = await freeAgentReasonFor(c, ws);
      if (why.crews) crews = why.crews;
      if (why.code && crews.some((r) => r.org_id === orgId && wanted.includes(r.slug) && r.status === 'paused')) return apiError(why.code, lang);
    }
    return Response.json({ ok: true, crews, swapped });
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
  let crews = await syncEnabled(ws, c);
  // 무료 계정 — 서버 관문이 상태를 paused(새 행·멈춘 행)로 두거나 원래 상태(available·detached)로 유지한다. 행·허용 범위는 저장되고 연결은 최신 앱 4명 안에서.
  // 'active'로 올렸는데 active가 아니면 관문 말고는 그렇게 되는 길이 없지만, 요금제 판정을 한 번 더 확인해 다른 사유를 요금제로 안내하지 않는다.
  if (data.status !== 'active') {
    const why = await freeAgentReasonFor(c, ws);
    if (why.crews) crews = why.crews;
    const now = crews.find((r) => r.id === data.id);
    if (why.code && now?.status !== 'active') return apiError(why.code, lang);
  }
  return Response.json({ ok: true, id: data.id, crews });
}

/** 해제 { orgId, slug } — 행 삭제(감사는 서버 트리거 몫). 마지막 등록이 사라지고 연결된 개인 공간 행도 없으면 브리지도 꺼진다. */
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
