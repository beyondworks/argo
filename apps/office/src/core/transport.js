// 서버 전송 — 보낼 목록의 변경을 Supabase 함수로 보낸다. 쓰기는 전부 권한을 확인하는 DB 함수로만(20260927170000_office_pages.sql).
// 저장은 보내는 순간의 최신 제목·본문과 서버가 아는 버전으로 간다. 다른 기기가 먼저 저장했으면 충돌 → 페이지에 안내(사람이 고른다).
import { setTransport } from './sync.js';
import { getState, update } from './store.js';
import { getMode, SPACES, ME } from './session.js';
import { getClient, classify } from './supabase.js';
import { setUi, getUi } from './ui-state.js';
import { showToast } from '../ui/Overlay.jsx';
import { t } from './i18n.js';
import { persist, heldKey, getStorageScope, scopedStorageKey } from './save.js';
import { apiUrl } from './platform.js';

const hold = (row) => row && persist(heldKey(row.id), { title: row.title ?? '', content: row.content }, 0);

const orgOf = (space) => SPACES.find((s) => s.key === space && s.kind === 'org');
const findPage = (id) => getState().pages.find((p) => p.id === id) ?? getState().trash.find((p) => p.id === id);
const patchPage = (id, patch) => update((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
async function send(op) {
  const mode = getMode();
  if (mode === 'sample' && op.payload.ownerUid === 'sample') return;
  if (mode !== 'signedIn') throw Object.assign(new Error('session not ready'), { transient: true }); // 로그인 확인 전 — 목록을 버리지 않고 나중에
  const p = op.payload;
  const owner = p.ownerUid;
  const assertOwner = () => {
    if (!owner || getStorageScope() !== owner || ME.id !== owner || getMode() !== 'signedIn') throw Object.assign(new Error('account changed'), { transient: true });
  };
  assertOwner();
  const sb = await getClient();
  const { data: auth, error: authError } = await sb.auth.getSession();
  assertOwner();
  if (authError || auth?.session?.user?.id !== owner || !auth.session.access_token) throw Object.assign(new Error('session not ready'), { transient: true });
  const token = auth.session.access_token;
  const rpc = async (fn, args) => {
    assertOwner();
    const { data, error } = await sb.rpc(fn, args).setHeader('Authorization', `Bearer ${token}`);
    assertOwner();
    if (error) throw classify(error);
    return data;
  };
  switch (p.type) {
    case 'layout.set': {
      const [surface, space] = p.key.split(':');
      if (p.key !== `${surface}:${space}`) throw Object.assign(new Error('layout_input'), { transient: false });
      const current = getState().layouts[p.key];
      if (current?.conflict) throw Object.assign(new Error('layout_version_conflict'), { transient: false, conflict: true });
      const prefs = { items: p.items };
      let version;
      if (space === 'me') version = await rpc('office_layout_save_v2', { p_space: 'me', p_surface: surface, p_prefs: prefs, p_base_version: current?.version ?? 0 });
      else {
        const org = orgOf(space);
        if (!org || !['owner', 'admin'].includes(org.role)) throw Object.assign(new Error('org admin only'), { transient: false });
        version = await rpc('office_space_layout_save_v2', { p_org: org.id, p_surface: surface, p_layout: prefs, p_base_version: current?.version ?? 0 });
      }
      update((s) => ({ layouts: { ...s.layouts, [p.key]: { ...s.layouts[p.key], version } } }));
      return;
    }
    case 'page.create': {
      const row = findPage(p.id);
      if (!row) return;
      const org = row.space === 'me' ? null : orgOf(row.space)?.id;
      if (row.space !== 'me' && !org) return;                                        // 예시 공간의 페이지는 서버에 없다
      await rpc('office_page_create', { p_id: row.id, p_org: org, p_parent: row.parent ?? null, p_position: row.position ?? 'a', p_title: row.title ?? '', p_content: row.content ?? {}, p_template: !!row.template });
      patchPage(row.id, { fresh: false });
      return;
    }
    case 'page.save': {
      const row = getState().pages.find((x) => x.id === p.id);
      if (!row || row.content === undefined) return;                                 // 본문을 아직 안 받은 페이지는 보낼 것이 없다
      if (getUi().conflict === row.id) { hold(row); return; }                        // 충돌은 사람이 고른다(새로 불러오기·사본) — 그 전엔 거절될 저장을 보내지 않고 이 기기에 남긴다
      const version = await rpc('office_page_save', { p_id: row.id, p_title: row.title ?? '', p_content: row.content, p_base_version: row.version ?? 1 });
      if (version !== row.version) patchPage(row.id, { version });
      return;
    }
    case 'page.move': {
      const row = findPage(p.id);
      if (row) await rpc('office_page_move', { p_id: row.id, p_parent: row.parent ?? null, p_position: row.position });
      return;
    }
    case 'page.archive': return rpc('office_page_archive', { p_id: p.id });
    case 'page.restore': return rpc('office_page_restore_archived', { p_id: p.id });
    case 'page.restricted': return rpc('office_page_set_restricted', { p_page: p.id, p_on: p.on });
    case 'approval.decide': {                                                      // 메신저 앱과 같은 경로(App.jsx decide) — 권한은 RLS 정책 msgr_approvals_decide가 가른다
      const { data, error } = await sb.from('msgr_crew_approvals').update({ status: p.result, decided_by: owner, decided_at: new Date().toISOString() }).eq('id', p.id).eq('status', 'pending').select('id').setHeader('Authorization', `Bearer ${token}`);
      assertOwner();
      if (error) throw classify(error);
      if (!data?.length) throw Object.assign(new Error('office: not decidable'), { transient: false, decide: true }); // 0행 = 결재권 없음·이미 결정됨
      return;
    }
    case 'mail.flag': {                                                            // 합쳐진 변경이라 patch가 아니라 지금 상태(읽음·폴더)를 그대로 보낸다 — 여러 번 보내도 같다
      const m = getState().mails.find((x) => x.id === p.id);
      if (!m?.account) return;                                                     // 예시 메일
      const inbox = m.folder === 'inbox' ? 'add' : m.folder === 'archive' ? 'remove' : null;
      assertOwner();
      const response = await fetch(apiUrl('/api/mail/modify'), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ account: m.account, id: m.gid, add: [...(m.unread ? ['UNREAD'] : []), ...(inbox === 'add' ? ['INBOX'] : [])], remove: [...(m.unread ? [] : ['UNREAD']), ...(inbox === 'remove' ? ['INBOX'] : [])] }) });
      assertOwner();
      if (!response.ok) { const failure = await response.json().catch(() => ({})); throw Object.assign(new Error('mail'), { code: failure.error, transient: response.status >= 500 }); }
      return;
    }
    default: return;                                                                 // ponytail: 배정은 크루 단계(P4)에서 여기에 더한다
  }
}

function rejected(op, err) {
  if (op.payload.ownerUid !== getStorageScope()) return;
  if (op.payload.type === 'layout.set') {
    const key = op.payload.key;
    persist(scopedStorageKey(`argo-office-layout-conflict:${key}`), getState().layouts[key], 0);
    update((s) => ({ layouts: { ...s.layouts, [key]: { ...s.layouts[key], conflict: true } } }));
    showToast(t(err?.conflict ? 'page.conflict' : 'sync.rejected'));
    return;
  }
  if (err?.conflict && op.payload.type === 'page.save') { hold(getState().pages.find((x) => x.id === op.payload.id)); setUi({ conflict: op.payload.id }); return; }
  if (op.payload.type === 'approval.decide') { showToast(t('ap.noRight')); import('./pull.js').then((m) => m.pullBoard()).catch(() => {}); return; }
  if (op.payload.type === 'mail.flag') { showToast(t(err?.code === 'expired' ? 'mailc.expired' : 'sync.rejected')); import('./mail.js').then((m) => m.loadAccounts()).catch(() => {}); return; }
  showToast(t('sync.rejected'));
  import('./pull.js').then((m) => m.pullPages()).catch(() => {});                  // 서버 상태로 되돌린다
}

setTransport(send, rejected);
