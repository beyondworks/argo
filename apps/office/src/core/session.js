// 로그인 상태·나·공간 목록. 화면 코드는 SPACES·ME를 그대로 읽는다(ES 모듈의 살아 있는 바인딩 — 로그인하면 값이 바뀌고 앱이 다시 그린다).
// 모드: sample(서버 설정 없음 → 예시 데이터) | loading | signedOut | signedIn
import { useSyncExternalStore } from 'react';
import * as SAMPLE from '../data/sample.js';
import { configured, getClient } from './supabase.js';
import { restore, persist } from './save.js';

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

/** 내가 속한 조직(퇴사·삭제 제외) → 공간. 조직 키는 주소에 쓰는 slug, 서버 키는 id */
async function loadSpaces(sb, me) {
  const { data, error } = await sb.from('msgr_org_members').select('role, org:msgr_orgs(id, name, slug, deleted_at)').eq('user_id', me.id).is('removed_at', null);
  if (error) throw error;
  const orgs = (data ?? []).filter((r) => r.org && !r.org.deleted_at)
    .map((r) => ({ key: r.org.slug, id: r.org.id, kind: 'org', name: r.org.name, role: r.role, mark: (r.org.name || '?').slice(0, 1).toUpperCase() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ key: 'me', kind: 'me', name: me.name, role: 'owner' }, ...orgs];
}

async function apply(sb, session) {
  if (!session) { mode = 'signedOut'; ME = SAMPLE.ME; SPACES = SAMPLE.SPACES; emit(); return; }
  const u = session.user;
  ME = { id: u.id, name: u.user_metadata?.full_name || u.user_metadata?.name || (u.email ?? '').split('@')[0], email: u.email ?? '' };
  const cached = restore(CACHE, null);
  if (cached?.uid === u.id) { SPACES = cached.spaces; mode = 'signedIn'; emit(); } // 지난번 목록으로 먼저 그린다(로컬 우선)
  try {
    SPACES = await loadSpaces(sb, ME);
    persist(CACHE, { uid: u.id, spaces: SPACES });
  } catch (e) { console.warn('[office] spaces load failed', e?.message); }
  mode = 'signedIn'; emit();
}

export async function initSession() {
  const sb = await getClient();
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  await apply(sb, data.session);
  sb.auth.onAuthStateChange((event, session) => { if (event !== 'INITIAL_SESSION' && event !== 'TOKEN_REFRESHED') apply(sb, session); });
}

export async function signInWith(provider) {
  const sb = await getClient();
  await sb.auth.signInWithOAuth({ provider, options: { redirectTo: `${location.origin}/me` } });
}
export async function signInWithPassword(email, password) {
  const sb = await getClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signOut() {
  const sb = await getClient();
  await sb?.auth.signOut();
}
