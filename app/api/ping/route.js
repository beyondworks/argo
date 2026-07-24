// Argo 신원 마커 — "이 포트의 서버가 Argo인가"를 확인하는 무인증 엔드포인트(신원·버전만, 비밀 없음).
// 데스크톱 셸(lib.rs)과 부트 페이지(boot.js)가 낯선 서버(타 앱의 포트 선점)에 웹뷰를 붙이던
// 실사용 사고(2026-07-20, Windows 설치 직후 "Cannot GET /" — Express류 앱이 3001 점유)의 방어.
// CORS 개방: 부트 페이지(tauri:// 오리진)가 응답 본문을 읽어야 신원을 판정할 수 있다.
import { readFileSync } from 'node:fs';
import pkg from '../../../package.json';

// buildId — 같은 버전의 재배포를 클라(BuildWatch)가 감지하는 근거. next start·standalone 모두
// cwd에 .next/BUILD_ID가 있다. 실패(dev 등)면 빈 값 — 클라는 감시를 조용히 생략한다.
let buildId = '';
try { buildId = readFileSync('.next/BUILD_ID', 'utf8').trim(); } catch { /* dev — buildId 없음 */ }

export async function GET() {
  return Response.json(
    { argo: true, version: pkg.version, buildId },
    { headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } },
  );
}
