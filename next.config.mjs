/** @type {import('next').NextConfig} */
export default {
  // Agent SDK가 claude CLI를 서브프로세스로 스폰한다 — 번들에 포함하지 않는다.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk'],
  outputFileTracingRoot: import.meta.dirname, // 상위 폴더 lockfile 오인 방지
};
