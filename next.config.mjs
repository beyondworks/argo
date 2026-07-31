import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {import('next').NextConfig} */
export default {
  // 상단바 버전 표시 — 빌드 시점 package.json 버전을 클라이언트에 노출(업데이트 버튼 기반).
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
  // Agent SDK가 claude CLI를 서브프로세스로 스폰한다 — 번들에 포함하지 않는다.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk'],
  outputFileTracingRoot: import.meta.dirname, // 상위 폴더 lockfile 오인 방지
  // 이미지 최적화기 비활성 — 앱은 next/image를 한 곳도 쓰지 않는다(첨부는 전부 <img src="/api/.../files">
  // 원본 직결). 그런데도 /_next/image 엔드포인트는 살아 있어서, 앱을 거치지 않고 sharp(libvips)에
  // 이미지를 먹일 수 있는 통로로 남는다. 지금은 Next 내부 fetch가 헤더를 안 실어(익명) 게이트 대상
  // 경로가 막히지만, 그건 테스트로 잠기지 않은 암묵 불변식이다 — 엔드포인트째 끄는 쪽이 근본적이다.
  // (분리 검수 2026-07-28 지적 #1. next/image를 쓰게 되는 날 이 줄을 지우면 된다.)
  images: { unoptimized: true },
  // 데스크톱 패키징(C-4): ARGO_STANDALONE=1 빌드 시 자기완결 서버(.next/standalone)를 낸다.
  // env 게이트인 이유 — 평소 dev 서버·빌드 산출물 경로를 바꾸지 않기 위해.
  ...(process.env.ARGO_STANDALONE ? { output: 'standalone' } : {}),
  // 심층 방어 보안 헤더 — 마크다운 렌더러가 이미 XSS를 이스케이프하지만, 클릭재킹·MIME
  // 스니핑을 막고 CSP로 한 겹 더. Next 하이드레이션 인라인 스크립트/앱 인라인 스타일 때문에
  // script/style은 'unsafe-inline'을 허용하되, frame-ancestors 'none'으로 프레임 삽입은 차단.
  async headers() {
    // 폰트 — Pretendard는 자체 호스팅('self', public/fonts)이라 CSP에 외부 출처가 필요 없다.
    // IBM Plex Mono(터미널 테마 전용)만 Google Fonts CDN을 유지한다 — 실패 시 ui-monospace 폴백이 무해.
    const cspBase = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https: wss:",
      "base-uri 'self'",
      "form-action 'self'",
    ];
    const csp = [...cspBase, "frame-ancestors 'none'"].join('; ');
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    }, {
      // 파일 서빙 라우트만 같은 출처 프레임 허용 — 채팅 인라인 산출물 미리보기의 PDF <iframe>이
      // 전역 frame-ancestors 'none'/DENY에 막히던 것(실측: 크롬 빈 프레임 아이콘). 완화 범위는
      // 이 라우트뿐이고 'self'라 외부 사이트 삽입은 여전히 차단. 여기서 나가는 응답은 파일
      // 바이트(PDF·이미지·텍스트)뿐이며 html은 MIME 목록에 없어 octet-stream(nosniff)으로
      // 문서 렌더 자체가 안 된다 — 프레임 허용이 스크립트 실행 표면을 만들지 않는다.
      // Next headers는 같은 키를 뒤 항목이 덮는다(공식 문서) — 전역 뒤에 두는 이유.
      source: '/api/companies/:ws/files',
      headers: [
        { key: 'Content-Security-Policy', value: [...cspBase, "frame-ancestors 'self'"].join('; ') },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    }, {
      // 동봉 폰트 장기 캐시 — Next는 public/ 파일에 max-age=0을 주므로(검수 실측) 명시한다.
      // 파일 내용이 바뀌면 경로(버전)를 바꾸는 전제의 immutable — 폰트 교체 시 파일명을 갈 것.
      source: '/fonts/:path*',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    }];
  },
};
