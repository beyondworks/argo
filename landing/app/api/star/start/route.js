// 깃헙 스타 플로우 시작 — 다운로드 모달의 "스타 누르고 다운로드"가 진입.
// GitHub App(별점 권한만) 사용자 승인 화면으로 보낸다. env 미설정이면 그냥 릴리스로 폴백 —
// 스타 장치가 다운로드를 막는 일은 어떤 경우에도 없어야 한다.
import { cookies } from 'next/headers';

const RELEASES = 'https://github.com/beyondworks/argo-agent/releases/latest';

export async function GET() {
  const clientId = process.env.GITHUB_STAR_CLIENT_ID;
  if (!clientId) return Response.redirect(RELEASES);
  const state = crypto.randomUUID();
  const store = await cookies();
  store.set('argo_star_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('state', state);
  return Response.redirect(url);
}
