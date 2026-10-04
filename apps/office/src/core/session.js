// 로그인 상태·나·공간 목록. 화면 코드는 SPACES·ME를 그대로 읽는다(ES 모듈의 살아 있는 바인딩 — 로그인하면 값이 바뀌고 앱이 다시 그린다).
// 모드: sample(서버 설정 없음 → 예시 데이터) | loading | signedOut | signedIn
import { useSyncExternalStore } from 'react';
import * as SAMPLE from '../data/sample.js';
import { configured, getClient, devPasswordLogin } from './supabase.js';
import { isDesktop } from './platform.js';
import { restore, persist, setStorageScope } from './save.js';
import { isSameUserEcho, switchNeedsReload } from './auth-events.js';

export let SPACES = SAMPLE.SPACES;
export let ME = SAMPLE.ME;
let mode = configured ? 'loading' : 'sample';
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
export const getMode = () => mode;
export const useSession = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => mode, () => mode);

/** 공간 구조(조직 위키 최상위·조직 홈)를 바꿀 수 있는가 — 서버 msgr_is_admin과 같은 기준. 'shared'는 남의 공간이라 false */
export const canManage = (key) => { const s = SPACES.find((x) => x.key === key); return s?.kind === 'me' || s?.role === 'owner' || s?.role === 'admin'; };

const CACHE = 'argo-office-session';
let applying = 0, spacesAt = 0, pageUid = null; // pageUid: 이 페이지에서 처음 데이터를 읽은 계정(auth-events.js switchNeedsReload)

/** 내가 속한 조직(퇴사·삭제 제외) → 공간. 조직 키는 주소에 쓰는 slug, 서버 키는 id */
async function loadSpaces(sb, me) {
  const { data, error } = await sb.from('msgr_org_members').select('role, org:msgr_orgs(id, name, slug, deleted_at)').eq('user_id', me.id).is('removed_at', null);
  if (error) throw error;
  const orgs = (data ?? []).filter((r) => r.org && !r.org.deleted_at)
    .map((r) => ({ key: r.org.slug, id: r.org.id, kind: 'org', name: r.org.name, role: r.role, mark: (r.org.name || '?').slice(0, 1).toUpperCase() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)); // 이름이 같아도 순서가 매번 같게(탭 복귀 비교가 흔들리지 않게)
  return [{ key: 'me', kind: 'me', name: me.name, role: 'owner' }, ...orgs];
}

async function apply(sb, session) {
  const uid = session?.user.id ?? null;
  if (switchNeedsReload(pageUid, uid)) { location.reload(); return; } // 다른 계정 — 앞 계정 데이터가 남은 메모리를 버린다(저장 범위를 바꾸기 전에)
  if (uid) pageUid ??= uid;
  const request = ++applying;
  mode = 'loading'; setStorageScope(uid); emit();
  const [{ activateDraftScope }, { activateSyncScope }] = await Promise.all([import('./store.js'), import('./sync.js')]);
  if (request !== applying) return;
  activateDraftScope(uid);
  await activateSyncScope(uid);
  if (request !== applying) return;
  if (!session) { mode = 'signedOut'; ME = SAMPLE.ME; SPACES = SAMPLE.SPACES; emit(); return; }
  const u = session.user;
  ME = { id: u.id, name: u.user_metadata?.full_name || u.user_metadata?.name || (u.email ?? '').split('@')[0], email: u.email ?? '' };
  const cached = restore(CACHE, null);
  SPACES = cached?.uid === u.id ? cached.spaces : [{ key: 'me', kind: 'me', name: ME.name, role: 'owner' }];
  try {
    const spaces = await loadSpaces(sb, ME);
    if (request !== applying) return;
    SPACES = spaces; spacesAt = Date.now();
    persist(CACHE, { uid: u.id, spaces: SPACES });
  } catch (e) { console.warn('[office] spaces load failed', e?.message); }
  if (request === applying) { mode = 'signedIn'; emit(); }
}

export async function initSession() {
  const sb = await getClient();
  if (!sb) {
    setStorageScope('sample');
    const [{ activateDraftScope }, { activateSyncScope }] = await Promise.all([import('./store.js'), import('./sync.js')]);
    activateDraftScope('sample'); await activateSyncScope('sample');
    return;
  }
  const { data } = await sb.auth.getSession();
  await apply(sb, data.session);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
    if (!isSameUserEcho(event, session, { signedIn: mode === 'signedIn', uid: ME.id })) { apply(sb, session); return; }
    // 탭 복귀: 앱은 그대로 두고 조직 목록만 1분에 한 번 확인 — 초대·퇴사로 바뀌었을 때만 다시 적용한다(분리 검수 M6)
    if (Date.now() - spacesAt < 60_000) return;
    spacesAt = Date.now();
    loadSpaces(sb, ME).then((spaces) => { if (JSON.stringify(spaces) !== JSON.stringify(SPACES)) apply(sb, session); }).catch(() => {});
  });
}

export async function signInWith(provider, options) {
  if (isDesktop()) return (await import('./desktop-auth.js')).signInDesktop(provider, options);
  const sb = await getClient();
  const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: `${location.origin}/me` } });
  if (error) throw error;
}
export async function signInWithPassword(email, password) {
  if (!devPasswordLogin) throw new Error('password_login_disabled');
  const sb = await getClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signOut() {
  const sb = await getClient();
  await sb?.auth.signOut();
}
