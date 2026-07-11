/** @type {import('next').NextConfig} */
export default {
  // Agent SDK가 claude CLI를 서브프로세스로 스폰한다 — 번들에 포함하지 않는다.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk'],
  outputFileTracingRoot: import.meta.dirname, // 상위 폴더 lockfile 오인 방지
  // 데스크톱 패키징(C-4): ARGO_STANDALONE=1 빌드 시 자기완결 서버(.next/standalone)를 낸다.
  // env 게이트인 이유 — 평소 dev 서버·빌드 산출물 경로를 바꾸지 않기 위해.
  ...(process.env.ARGO_STANDALONE ? { output: 'standalone' } : {}),
};
