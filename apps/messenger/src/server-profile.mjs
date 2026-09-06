// 서버 프로필 — 메신저가 붙는 Supabase를 정한다. 기본은 빌드에 박힌 Argo 클라우드(VITE_SUPABASE_*),
// 회사 로컬 서버(셀프호스트 Supabase — docs/selfhost.md "팀 메신저")는 이 기기의 localStorage 프로필로 덮는다.
// 순수 모듈(브라우저 API 없음) — test/msgr-ship.test.mjs가 행동으로 잠근다.
export const PROFILE_KEY = 'argo-msgr-server';

/** URL 정규화 — 스킴 필수, 경로·끝 슬래시 제거. 잘못된 값은 ''. */
export function normalizeUrl(u) {
  const s = String(u ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+$/.test(s) ? s : '';
}

/** 저장된 프로필 문자열 → { url, anon } | null. 둘 중 하나라도 비면 null(반쪽 프로필로 접속 시도하지 않는다). */
export function parseProfile(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    const url = normalizeUrl(o?.url);
    const anon = String(o?.anon ?? '').trim();
    return url && anon ? { url, anon } : null;
  } catch { return null; }
}

export function readProfile(storage) { try { return parseProfile(storage?.getItem(PROFILE_KEY)); } catch { return null; } }
export function writeProfile(storage, p) { storage.setItem(PROFILE_KEY, JSON.stringify({ url: normalizeUrl(p.url), anon: String(p.anon ?? '').trim() })); }
export function clearProfile(storage) { storage.removeItem(PROFILE_KEY); }
/** 화면 표시용 — 키는 절대 싣지 않고 호스트만. */
export function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }
