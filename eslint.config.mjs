// no-undef 게이트(전수리뷰 2026-07-30 #2) — gateway listAgents 임포트 누락(크루 쪽지 브리핑 100%
// 무음 실패)이 이 규칙 하나로 잡혔을 종류다. 목적은 "정의 안 된 식별자" 단 하나 — 스타일 규칙은
// 넣지 않는다(스타일 게이트는 리뷰·검수의 몫, 린트 소음은 게이트 무시 습관을 만든다).
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.next/**', 'desktop/**', 'landing/**', 'demo-video/**', 'supabase/functions/**', 'workspaces/**', '.omc/**', '.fablize/**'] },
  {
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['app/**/*.js', 'app/**/*.jsx', 'app/**/*.mjs', 'middleware.js'],
    languageOptions: {
      ecmaVersion: 2024, sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      // Next는 서버·클라 파일이 한 트리에 혼재 — 양쪽 전역을 합친다(no-undef의 목적은 오탈자·임포트
      // 누락이지 환경 경계 검증이 아니다. 환경 경계는 번들러·런타임이 잡는다).
      globals: { ...globals.browser, ...globals.node, React: 'readonly' },
    },
    rules: { 'no-undef': 'error' },
  },
];
