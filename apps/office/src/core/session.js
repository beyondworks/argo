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

/** 그 공간에서 보이는 내 이름(CX-07) — 메신저와 같은 원천: 조직은 그 조직의 내 표시 이름(msgr_org_members), 없거나 내 공간이면 프로필 이름(ME.name) */
export const nameIn = (space) => SPACES.find((s) => s.key === space)?.me || ME.name;
/** 사람 이름 규칙 — 서버 msgr_person_label·메신저 self-member.mjs와 같다: 프로필 표시 이름 → 이메일 앞부분 */
export const personLabel = (profileName, email) => String(profileName ?? '').trim() || String(email ?? '').split('@')[0];

/** 공간 구조(조직 위키 최상위·조직 홈)를 바꿀 수 있는가 — 서버 msgr_is_admin과 같은 기준. 'shared'는 남의 공간이라 false */
export const canManage = (key) => { const s = SPACES.find((x) => x.key === key); return s?.kind === 'me' || s?.role === 'owner' || s?.role === 'admin'; };

const CACHE = 'argo-office-session';
let applying = 0, spacesAt = 0, pageUid = null; // pageUid: 이 페이지에서 처음 데이터를 읽은 계정(auth-events.js switchNeedsReload)

/** 내가 속한 조직(퇴사·삭제 제외) → 공간. 조직 키는 주소에 쓰는 slug, 서버 키는 id */
async function loadSpaces(sb, me) {
  const { data, error } = await sb.from('msgr_org_members').select('role, display_name, org:msgr_orgs(id, name, slug, deleted_at)').eq('user_id', me.id).is('removed_at', null);
  if (error) throw error;
  const orgs = (data ?? []).filter((r) => r.org && !r.org.deleted_at)
    .map((r) => ({ key: r.org.slug, id: r.org.id, kind: 'org', name: r.org.name, role: r.role, mark: (r.org.name || '?').slice(0, 1).toUpperCase(), me: String(r.display_name ?? '').trim() || null })) // me = 이 조직에서 보이는 내 이름
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)); // 이름이 같아도 순서가 매번 같게(탭 복귀 비교가 흔들리지 않게)
  return [{ key: 'me', kind: 'me', name: me.name, role: 'owner' }, ...orgs];
}

async function apply(sb, session) {
  const uid = session?.user.id ?? null;
  // 다른 계정 — 앞 계정 데이터가 남은 메모리를 버린다. 다시 불러오기 직전까지 끝나는 앞 계정 화면의 늦은 읽기가 앞 계정 초안에 새 계정 목록을 쓰지 않게
  // 저장 범위를 비우고(store.update가 거절) 화면을 내린 뒤 다시 불러온다(10/4 4차 검수 L1)
  if (switchNeedsReload(pageUid, uid)) { setStorageScope(null); mode = 'loading'; emit(); location.reload(); return; }
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
  const cached = restore(CACHE, null);
  // 내 이름(CX-07) — 메신저 프로필 이름 → 이메일 앞부분(메신저·서버와 같은 규칙). 프로필을 못 읽으면 지난번 이름, 그것도 없으면 로그인 정보의 이름
  ME = { id: u.id, name: (cached?.uid === u.id && cached.name) || u.user_metadata?.full_name || u.user_metadata?.name || personLabel(null, u.email), email: u.email ?? '' };
  SPACES = cached?.uid === u.id ? cached.spaces : [{ key: 'me', kind: 'me', name: ME.name, role: 'owner' }];
  const profile = Promise.resolve().then(() => sb.from('msgr_profiles').select('display_name').eq('user_id', u.id).maybeSingle()) // 로그인 때 한 번(탭 복귀에는 읽지 않는다)
    .then((r) => (r.error ? undefined : personLabel(r.data?.display_name, u.email)), () => undefined); // 못 읽어도 로그인은 그대로
  try {
    const [spaces, name] = await Promise.all([loadSpaces(sb, ME), profile]);
    if (request !== applying) return;
    if (name) { ME = { ...ME, name }; spaces[0] = { ...spaces[0], name }; }
    SPACES = spaces; spacesAt = Date.now();
    persist(CACHE, { uid: u.id, spaces: SPACES, name: ME.name });
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
    // 무시하는 두 사건에도 다른 계정이 실려 오면(페이지를 여는 사이 다른 탭이 로그인) 다시 불러오기로 넘긴다(10/4 4차 검수 L2)
    if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') { if (switchNeedsReload(pageUid, session?.user?.id ?? null)) apply(sb, session); return; }
    if (!isSameUserEcho(event, session, { signedIn: mode === 'signedIn', uid: ME.id })) { apply(sb, session); return; }
    // 탭 복귀: 앱은 그대로 두고 조직 목록만 1분에 한 번 확인 — 초대·퇴사로 바뀌었을 때만 다시 적용한다(분리 검수 M6)
    if (Date.now() - spacesAt < 60_000) return;
    spacesAt = Date.now();
    // 확인하는 사이 로그아웃·계정 전환이 지나갔으면 붙잡아 둔 옛 세션으로 되살리지 않는다(10/4 4차 검수 L3)
    loadSpaces(sb, ME).then((spaces) => { if (mode === 'signedIn' && ME.id === session?.user?.id && JSON.stringify(spaces) !== JSON.stringify(SPACES)) apply(sb, session); }).catch(() => {});
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
