// Argo 신원 마커 — "이 포트의 서버가 Argo인가"를 확인하는 무인증 엔드포인트(신원·버전만, 비밀 없음).
// 데스크톱 셸(lib.rs)과 부트 페이지(boot.js)가 낯선 서버(타 앱의 포트 선점)에 웹뷰를 붙이던
// 실사용 사고(2026-07-20, Windows 설치 직후 "Cannot GET /" — Express류 앱이 3001 점유)의 방어.
// CORS 개방: 부트 페이지(tauri:// 오리진)가 응답 본문을 읽어야 신원을 판정할 수 있다.
import pkg from '../../../package.json';

export async function GET() {
  return Response.json(
    { argo: true, version: pkg.version },
    { headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } },
  );
}
