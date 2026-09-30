// 로그인 뒤 서버의 배치를 가져온다 — 아직 안 보낸 변경이 있는 배치는 이 기기 값을 지킨다(로컬 우선).
import { getClient } from './supabase.js';
import { SPACES, ME } from './session.js';
import { update, getState } from './store.js';
import { outbox } from './sync.js';
import { mergePages } from './layout.js';
import { mapBoard } from './board.js';
import { getStorageScope } from './save.js';

export async function pullLayouts({ recoverKey = null } = {}) {
  const owner = getStorageScope();
  const sb = await getClient();
  if (!sb || getStorageScope() !== owner || owner !== ME.id) return;
  const orgs = SPACES.filter((s) => s.kind === 'org');
  const busy = new Set(Object.keys(getState().layouts ?? {}).filter((k) => outbox.has(`layout:${k}`))); // 요청 전 보낼 것 — 응답은 요청 시점 스냅숏
  const [mine, shared] = await Promise.all([
    sb.from('office_user_layouts').select('space_key, surface, prefs, version').eq('user_id', owner).eq('space_key', 'me'),
    orgs.length ? sb.from('office_space_layouts').select('org_id, surface, layout, version').in('org_id', orgs.map((o) => o.id)) : { data: [] },
  ]);
  if (getStorageScope() !== owner) return;
  if (mine.error || shared.error) throw mine.error ?? shared.error;
  const next = Object.fromEntries(['me', ...orgs.map((o) => o.key)].map((space) => [`home:${space}`, { items: [], version: 0 }]));
  next['nav:me'] = { items: [], version: 0 }; next['biztabs:me'] = { items: [], version: 0 }; // 좌측 메뉴·업무 탭 순서(사람마다, 9/30)
  for (const r of mine.data ?? []) next[`${r.surface}:me`] = { ...r.prefs, version: r.version };
  for (const r of shared.data ?? []) { const o = orgs.find((x) => x.id === r.org_id); if (o) next[`${r.surface}:${o.key}`] = { ...r.layout, version: r.version }; }
  const keep = Object.entries(next).filter(([k]) => !busy.has(k) && !outbox.has(`layout:${k}`) && (!getState().layouts[k]?.conflict || k === recoverKey));
  if (keep.length) update((s) => ({ layouts: { ...s.layouts, ...Object.fromEntries(keep) } }));
  return recoverKey ? keep.some(([key]) => key === recoverKey) : true;
}

/** 볼 수 있는 페이지 목록(본문 제외)을 가져온다 — 아직 안 보낸 변경이 있는 페이지는 이 기기 값을 지킨다. 본문은 열 때 loadPageContent로. */
const PENDING = ['page-create', 'page', 'order', 'restricted', 'trash'];
const pendingFor = (id) => PENDING.some((k) => outbox.has(`${k}:${id}`));
export async function pullPages() {
  const owner = getStorageScope();
  const sb = await getClient();
  if (!sb || owner !== ME.id || getStorageScope() !== owner) return;
  const all = () => [...getState().pages, ...getState().trash];
  const before = new Set(all().map((p) => p.id).filter(pendingFor));                 // 요청 전에 잡는다 — 응답은 요청 시점 스냅숏
  // 후보를 내 공간·내 조직·공유받은 트리로 좁혀 읽는다(office_page_list) — 전체 표를 읽으면 테넌트 전체 페이지를 권한 판정한다(검수 M3)
  const { data, error } = await sb.rpc('office_page_list_access');
  if (getStorageScope() !== owner) return;
  if (error) throw error;
  const orgKey = new Map(SPACES.filter((s) => s.kind === 'org').map((s) => [s.id, s.key]));
  const spaceOf = (r) => (r.space_kind === 'me' ? (r.owner_user_id === ME.id ? 'me' : 'shared') : orgKey.get(r.org_id));
  const local = all();
  const { pages, trash } = mergePages(data ?? [], local, { before, pendingNow: new Set(local.map((p) => p.id).filter(pendingFor)), spaceOf });
  update(() => ({ pages, trash }));
}

/** 페이지 본문을 불러온다. force면 이 기기의 아직 안 보낸 저장을 버리고 서버 값으로(충돌 뒤 "새로 불러오기") */
export async function loadPageContent(id, { force = false } = {}) {
  const owner = getStorageScope();
  const sb = await getClient();
  if (!sb || owner !== ME.id || getStorageScope() !== owner) return;
  const busy = outbox.has(`page:${id}`);                                            // 요청 전에 잡는다 — 응답 전에 저장이 끝나면 응답이 더 옛것
  const [{ data, error }, rights] = await Promise.all([
    sb.from('office_pages').select('title, content, version, updated_at, owner_user_id, org_id').eq('id', id).maybeSingle(),
    sb.rpc('office_page_access', { p_page: id }),
  ]);
  if (getStorageScope() !== owner) return;
  if (rights.error) throw rights.error;
  if (error || !data) return;
  if (!force && (busy || outbox.has(`page:${id}`))) return;
  update((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, title: data.title, content: data.content, version: data.version, owner: data.owner_user_id, orgId: data.org_id, access: rights.data, updated: data.updated_at, loadedAt: Date.now() } : p)) }));
  return data;
}

/** 기록판 — 내 조직들의 메신저 기록(크루·진행 중인 일·대기 결재·최근 결정·산출물·일지)을 읽는다. 읽기만(DB 쓰기 0).
 *  결재 버튼은 서버가 결재권이 있다고 한 것만(msgr_can_decide — 메신저 앱과 같은 판정). */
export async function pullBoard() {
  const owner = getStorageScope();
  const sb = await getClient();
  if (!sb || owner !== ME.id || getStorageScope() !== owner) return;
  const orgs = SPACES.filter((s) => s.kind === 'org');
  const empty = { crews: [], work: [], approvals: [], decisions: [], outputs: [], journal: [], docs: [] };
  if (!orgs.length) { update(() => empty); return; }
  const ids = orgs.map((o) => o.id);
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const res = await Promise.all([
    // 크루는 주인·쓸 수 있는지·내 고정/순서까지 한 번에(9/30). 함수가 없는 옛 DB면 예전처럼 표에서 읽는다
    sb.rpc('office_crew_list', { p_orgs: ids }).then((r) => (r.error?.code === 'PGRST202' ? sb.from('msgr_crews').select('id, org_id, owner_user_id, display_name, department, role_text, face').in('org_id', ids) : r)),
    sb.from('msgr_work_runs').select('id, org_id, channel_id, goal, completion_criteria, lead_crew_id, status, created_at').in('org_id', ids).in('status', ['running', 'blocked']).order('created_at', { ascending: false }).limit(100),
    sb.from('msgr_crew_approvals').select('id, org_id, channel_id, crew_id, action, reason, risk, created_at, pl:payload->plain').in('org_id', ids).eq('status', 'pending').order('created_at', { ascending: false }).limit(100),
    sb.from('msgr_crew_approvals').select('id, org_id, channel_id, crew_id, action, reason, risk, status, decided_by, decided_at, created_at').in('org_id', ids).in('status', ['approved', 'rejected']).gte('decided_at', since).order('decided_at', { ascending: false }).limit(100),
    sb.from('msgr_attachments').select('id, org_id, name, bytes, mime, storage_path, created_at, msg:msgr_messages(channel_id, crew_id)').in('org_id', ids).order('created_at', { ascending: false }).limit(100),
    sb.from('msgr_channels').select('id, name, kind').in('org_id', ids),
    sb.from('msgr_org_docs').select('org_id, title, body').in('org_id', ids).like('path', 'journal/%').order('updated_at', { ascending: false }).limit(30),
    sb.from('msgr_org_docs').select('id, org_id, channel_id, path, title, updated_at').in('org_id', ids).not('path', 'like', 'journal/%').order('path').limit(300), // 본문은 열 때만
  ]);
  const bad = res.find((r) => r.error);
  if (bad) throw bad.error;
  const [crews, runs, approvals, decisions, files, channels, journals, docs] = res.map((r) => r.data ?? []);
  const deciders = [...new Set(decisions.map((d) => d.decided_by).filter(Boolean))]; // 결정한 사람 이름 — 결정이 있을 때만 한 번 더 읽는다
  const [can, members] = await Promise.all([
    Promise.all(approvals.map((a) => sb.rpc('msgr_can_decide', { ap: a.id }).then((r) => (r.data ? a.id : null)))),
    deciders.length ? sb.from('msgr_org_members').select('org_id, user_id, display_name').in('org_id', ids).in('user_id', deciders).then((r) => r.data ?? []) : [],
  ]);
  if (getStorageScope() !== owner) return;
  update(() => mapBoard({ crews, runs, approvals, decisions, files, channels, journals, docs, members }, { orgKey: new Map(orgs.map((o) => [o.id, o.key])), decidable: new Set(can.filter(Boolean)) }));
}

/** 공용 문서 본문 — 목록에는 싣지 않고 열 때만 읽는다(문서당 최대 64KB) */
export async function loadDocBody(id) {
  const owner = getStorageScope();
  const sb = await getClient();
  if (!sb || getStorageScope() !== owner) return null;
  const { data } = await sb.from('msgr_org_docs').select('body').eq('id', id).maybeSingle();
  if (getStorageScope() !== owner) return null;
  return data?.body ?? null;
}

export async function reloadLayout(key) {
  const owner = getStorageScope();
  await outbox.drop(`layout:${key}`);
  if (getStorageScope() !== owner) return false;
  // Keep the conflict locked until a successful server snapshot replaces it.
  return (await pullLayouts({ recoverKey: key })) === true;
}
