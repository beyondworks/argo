// 서버 전송 — 보낼 목록의 변경을 Supabase 함수로 보낸다. 쓰기는 전부 권한을 확인하는 DB 함수로만(20260927170000_office_pages.sql).
// 저장은 보내는 순간의 최신 제목·본문과 서버가 아는 버전으로 간다. 다른 기기가 먼저 저장했으면 충돌 → 페이지에 안내(사람이 고른다).
import { setTransport } from './sync.js';
import { getState, update } from './store.js';
import { getMode, SPACES, ME } from './session.js';
import { getClient, classify } from './supabase.js';
import { setUi, getUi } from './ui-state.js';
import { showToast } from '../ui/Overlay.jsx';
import { t } from './i18n.js';
import { persist, heldKey } from './save.js';

const hold = (row) => row && persist(heldKey(row.id), { title: row.title ?? '', content: row.content }, 0);

const orgOf = (space) => SPACES.find((s) => s.key === space && s.kind === 'org');
const findPage = (id) => getState().pages.find((p) => p.id === id) ?? getState().trash.find((p) => p.id === id);
const patchPage = (id, patch) => update((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
async function rpc(fn, args) {
  const sb = await getClient();
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw classify(error);
  return data;
}

async function send(op) {
  const mode = getMode();
  if (mode === 'sample') return;                                                   // 예시 데이터 모드 — 이 기기에만
  if (mode !== 'signedIn') throw Object.assign(new Error('session not ready'), { transient: true }); // 로그인 확인 전 — 목록을 버리지 않고 나중에
  const p = op.payload;
  switch (p.type) {
    case 'layout.set': {
      const [surface, space] = p.key.split(':');
      const prefs = { items: p.items };
      if (space === 'me') return rpc('office_layout_save', { p_space: 'me', p_surface: surface, p_prefs: prefs });
      const org = orgOf(space);
      if (!org || !['owner', 'admin'].includes(org.role)) return;                    // 조직 구조는 관리자만(화면도 막는다)
      return rpc('office_space_layout_save', { p_org: org.id, p_surface: surface, p_layout: prefs });
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
      const sb = await getClient();
      const { data, error } = await sb.from('msgr_crew_approvals').update({ status: p.result, decided_by: ME.id, decided_at: new Date().toISOString() }).eq('id', p.id).eq('status', 'pending').select('id');
      if (error) throw classify(error);
      if (!data?.length) throw Object.assign(new Error('office: not decidable'), { transient: false, decide: true }); // 0행 = 결재권 없음·이미 결정됨
      return;
    }
    case 'mail.flag': {                                                            // 합쳐진 변경이라 patch가 아니라 지금 상태(읽음·폴더)를 그대로 보낸다 — 여러 번 보내도 같다
      const m = getState().mails.find((x) => x.id === p.id);
      if (!m?.account) return;                                                     // 예시 메일
      const inbox = m.folder === 'inbox' ? 'add' : m.folder === 'archive' ? 'remove' : null;
      const { api } = await import('./mail.js');
      await api('modify', { account: m.account, id: m.gid, add: [...(m.unread ? ['UNREAD'] : []), ...(inbox === 'add' ? ['INBOX'] : [])], remove: [...(m.unread ? [] : ['UNREAD']), ...(inbox === 'remove' ? ['INBOX'] : [])] });
      return;
    }
    default: return;                                                                 // ponytail: 배정은 크루 단계(P4)에서 여기에 더한다
  }
}

function rejected(op, err) {
  if (err?.conflict && op.payload.type === 'page.save') { hold(getState().pages.find((x) => x.id === op.payload.id)); setUi({ conflict: op.payload.id }); return; }
  if (op.payload.type === 'approval.decide') { showToast(t('ap.noRight')); import('./pull.js').then((m) => m.pullBoard()).catch(() => {}); return; }
  if (op.payload.type === 'mail.flag') { showToast(t(err?.code === 'expired' ? 'mailc.expired' : 'sync.rejected')); import('./mail.js').then((m) => m.loadAccounts()).catch(() => {}); return; }
  showToast(t('sync.rejected'));
  import('./pull.js').then((m) => m.pullPages()).catch(() => {});                  // 서버 상태로 되돌린다
}

setTransport(send, rejected);
