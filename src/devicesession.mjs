// 기기 세션 — "이 기기 = 이 계정" (M-2 로그인=연동의 심장).
// Supabase Auth 세션(access+refresh)을 기기 파일(0600)에 보관하고, 만료 임박 시 스스로 회전한다.
// 회전 충돌 방지 원칙: 이 파일이 세션의 단일 소유자 — 브라우저 쿠키/클라이언트와 refresh 토큰을
// 공유하지 않는다(공유하면 Supabase 토큰 회전 재사용 감지로 세션 일가족이 폐기된다).
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { WS_ROOT } from './workspace.mjs';
import { withLock } from './mutex.mjs';

const FILE = '.device-session.json';
let cache = null; // { root, sess }
let epoch = 0;
export const deviceEpoch = () => epoch;
const fileOf = (root) => join(root, FILE);

/** 기기 세션 또는 null. 파일 손상은 경고(경로만) 후 null — 시크릿 값은 절대 출력하지 않는다. */
export function loadDeviceSession({ root = WS_ROOT } = {}) {
  if (cache && cache.root === root) return cache.sess;
  let sess = null;
  try {
    const d = JSON.parse(readFileSync(fileOf(root), 'utf8'));
    if (d.url && d.anonKey && d.refresh_token && d.access_token && d.user?.id) sess = d;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[argo] 기기 세션 파일 손상 — 재로그인 필요: ${fileOf(root)}`);
  }
  cache = { root, sess };
  return sess;
}

async function persist(sess, root) {
  await mkdir(root, { recursive: true });
  const tmp = join(root, `.tmp-devsess-${process.pid}-${Date.now().toString(36)}`);
  await writeFile(tmp, JSON.stringify(sess, null, 2), { mode: 0o600 }); // 생성 시점부터 0600
  await rename(tmp, fileOf(root)); // 원자 교체 — 모드 보존
  cache = null;
  epoch++;
}

/** 로그인/링크 시 저장. session = Supabase Auth 세션(user 포함). */
export async function saveDeviceSession({ url, anonKey, session }, { root = WS_ROOT } = {}) {
  if (!url || !anonKey || !session?.access_token || !session?.refresh_token || !session?.user?.id) {
    throw new Error('기기 세션 저장에 필요한 값 누락 (url/anonKey/session)');
  }
  await persist({
    url, anonKey,
    user: { id: session.user.id, email: session.user.email ?? '' },
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? 0,
  }, root);
}

export async function clearDeviceSession({ root = WS_ROOT } = {}) {
  await rm(fileOf(root), { force: true });
  cache = null;
  epoch++;
}

/** 유효한 access token 보장 — 만료 60초 전이면 회전 후 저장(락으로 직렬화). null = 세션 없음/회전 실패. */
export async function getFreshDeviceSession({ root = WS_ROOT } = {}) {
  return withLock(`devsess:${root}`, async () => {
    const sess = loadDeviceSession({ root });
    if (!sess) return null;
    if ((sess.expires_at ?? 0) * 1000 - Date.now() > 60_000) return sess;
    const sb = createClient(sess.url, sess.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.refreshSession({ refresh_token: sess.refresh_token });
    if (error || !data?.session) {
      console.warn('[argo] 기기 세션 갱신 실패 — 재로그인 필요:', error?.message ?? 'no session');
      return null;
    }
    const s = data.session;
    const next = {
      ...sess,
      access_token: s.access_token,
      refresh_token: s.refresh_token, // 회전된 토큰 즉시 영속 — 유실 시 세션 일가족 폐기
      expires_at: s.expires_at ?? 0,
      user: { id: s.user?.id ?? sess.user.id, email: s.user?.email ?? sess.user.email },
    };
    await persist(next, root);
    return next;
  });
}
