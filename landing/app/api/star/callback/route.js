// 깃헙 스타 콜백 — 사용자 승인 후 도착. 코드 교환 → 사용자 대신 스타 1회 → 릴리스 페이지로.
// 원칙: 어떤 실패(취소·만료·API 오류)든 다운로드를 막지 않는다 — 전부 릴리스로 보낸다.
// 토큰은 스타 호출에만 쓰고 어디에도 저장하지 않는다.
import { cookies } from 'next/headers';

const RELEASES = 'https://github.com/beyondworks/argo-agent/releases/latest';
const REPO = 'beyondworks/argo-agent';
// 스타 후 직다운로드 — start가 심은 쿠키(argo_star_dl)의 타깃으로 바로 파일을 내려준다
const DL = {
  silicon: `${RELEASES}/download/argo-macos-apple-silicon.dmg`,
  intel: `${RELEASES}/download/argo-macos-intel.dmg`,
  win: `${RELEASES}/download/argo-windows-setup.exe`,
};

export async function GET(req) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  const store = await cookies();
  const saved = store.get('argo_star_state')?.value;
  const dl = store.get('argo_star_dl')?.value;
  store.delete('argo_star_state');
  store.delete('argo_star_dl');

  let starred = false;
  try {
    if (!code || !state || !saved || state !== saved) {
      console.warn('[star] state 불일치/누락:', { code: !!code, state: !!state, saved: !!saved });
    } else {
      const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          // trim — env 붙여넣기에 섞인 개행/공백이 incorrect_client_credentials를 만든다 (실측)
          client_id: (process.env.GITHUB_STAR_CLIENT_ID || '').trim(),
          client_secret: (process.env.GITHUB_STAR_CLIENT_SECRET || '').trim(),
          code,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const tok = await r.json();
      if (!tok?.access_token) {
        // 값은 절대 로그하지 않는다 — 에러 코드만
        console.warn('[star] 토큰 교환 실패:', r.status, tok?.error ?? 'no access_token');
      } else {
        const s = await fetch(`https://api.github.com/user/starred/${REPO}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tok.access_token}`,
            Accept: 'application/vnd.github+json',
            'Content-Length': '0',
          },
          signal: AbortSignal.timeout(10_000),
        });
        starred = s.status === 204;
        if (!starred) {
          console.warn('[star] star PUT 실패:', s.status, (await s.text()).slice(0, 200));
          // 깃헙이 요구 권한을 알려주는 진단 헤더 — 403 원인 확정용
          console.warn('[star] accepted-permissions:', s.headers.get('x-accepted-github-permissions'));
        }
      }
    }
  } catch (e) { console.warn('[star] 예외:', e?.name, e?.message); /* 다운로드가 우선 */ }

  if (starred) {
    // 모달 재노출 방지 마커 (클라이언트가 읽는 비민감 쿠키)
    store.set('argo_starred', '1', { secure: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365, path: '/' });
  }
  // 타깃을 알면 설치파일 직다운로드, 모르면 릴리스 페이지 — 어느 쪽이든 다운로드가 이어진다
  return Response.redirect(DL[dl] ?? RELEASES);
}
