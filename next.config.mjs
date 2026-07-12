/** @type {import('next').NextConfig} */
export default {
  // Agent SDK가 claude CLI를 서브프로세스로 스폰한다 — 번들에 포함하지 않는다.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk'],
  outputFileTracingRoot: import.meta.dirname, // 상위 폴더 lockfile 오인 방지
  // 데스크톱 패키징(C-4): ARGO_STANDALONE=1 빌드 시 자기완결 서버(.next/standalone)를 낸다.
  // env 게이트인 이유 — 평소 dev 서버·빌드 산출물 경로를 바꾸지 않기 위해.
  ...(process.env.ARGO_STANDALONE ? { output: 'standalone' } : {}),
  // 심층 방어 보안 헤더 — 마크다운 렌더러가 이미 XSS를 이스케이프하지만, 클릭재킹·MIME
  // 스니핑을 막고 CSP로 한 겹 더. Next 하이드레이션 인라인 스크립트/앱 인라인 스타일 때문에
  // script/style은 'unsafe-inline'을 허용하되, frame-ancestors 'none'으로 프레임 삽입은 차단.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    }];
  },
};
