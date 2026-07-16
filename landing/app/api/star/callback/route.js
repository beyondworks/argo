// 깃헙 스타 콜백 — 사용자 승인 후 도착. 코드 교환 → 사용자 대신 스타 1회 → 릴리스 페이지로.
// 원칙: 어떤 실패(취소·만료·API 오류)든 다운로드를 막지 않는다 — 전부 릴리스로 보낸다.
// 토큰은 스타 호출에만 쓰고 어디에도 저장하지 않는다.
import { cookies } from 'next/headers';

const RELEASES = 'https://github.com/beyondworks/argo-agent/releases/latest';
const REPO = 'beyondworks/argo-agent';

export async function GET(req) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const store = await cookies();
  const saved = store.get('argo_star_state')?.value;
  store.delete('argo_star_state');

  let starred = false;
  try {
    if (code && state && saved && state === saved) {
      const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: process.env.GITHUB_STAR_CLIENT_ID,
          client_secret: process.env.GITHUB_STAR_CLIENT_SECRET,
          code,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const token = (await r.json())?.access_token;
      if (token) {
        const s = await fetch(`https://api.github.com/user/starred/${REPO}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Length': '0',
          },
          signal: AbortSignal.timeout(10_000),
        });
        starred = s.status === 204;
      }
    }
  } catch { /* 스타 실패는 조용히 무시 — 다운로드가 우선 */ }

  if (starred) {
    // 모달 재노출 방지 마커 (클라이언트가 읽는 비민감 쿠키)
    store.set('argo_starred', '1', { secure: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365, path: '/' });
  }
  return Response.redirect(RELEASES);
}
