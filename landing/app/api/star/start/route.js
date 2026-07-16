// 깃헙 스타 플로우 시작 — 다운로드 모달의 "스타 누르고 다운로드"가 진입.
// GitHub App(별점 권한만) 사용자 승인 화면으로 보낸다. env 미설정이면 그냥 릴리스로 폴백 —
// 스타 장치가 다운로드를 막는 일은 어떤 경우에도 없어야 한다.
import { cookies } from 'next/headers';

const RELEASES = 'https://github.com/beyondworks/argo-agent/releases/latest';
const TARGETS = ['silicon', 'intel', 'win']; // 화이트리스트 — 쿠키 경유라 검증 필수

export async function GET(req) {
  const clientId = (process.env.GITHUB_STAR_CLIENT_ID || '').trim();
  if (!clientId) return Response.redirect(RELEASES);
  const t = new URL(req.url).searchParams.get('t');
  const state = crypto.randomUUID();
  const store = await cookies();
  store.set('argo_star_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
  // 스타 완료 후 어떤 설치파일로 보낼지 — 콜백이 읽는다
  if (TARGETS.includes(t)) {
    store.set('argo_star_dl', t, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' });
  }
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('state', state);
  return Response.redirect(url);
}
